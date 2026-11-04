/**
 * The Engine owns the domain state — threads, triggers, tickets, subscriptions, assignments, reports — and is its only
 * writer. Sources call `receiveMessage`; the router's tools call the router commands; workers' tools and turn hooks call
 * the worker facts; people call the people commands. Each command is one transaction; agent wake-ups run after commit.
 */
import type { AgentRuntime, Bus } from '@super-agent/agent-runtime'
import { kvGet, newId, schema, type Store } from '@super-agent/db'
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { conversationOf, webchatThread, type Attention, type Ended, type HumanAction, type Mandate, type Report, type ReportStatus, type Ticket, type TicketStage } from './model'

export const ROUTER_SESSION = 'ses_router'

export class DomainError extends Error {
  constructor(readonly code: 'missing' | 'invalid' | 'conflict', message: string) { super(message) }
}

export interface ExecutionSettings {
  maxWorkers: number
  foregroundSeconds: number
  timeoutMinutes: number
  blockedCommands: string[]
  /** Existing directories a task may be given as its working directory (in addition to a fresh one under work/). */
  workspaceRoots: string[]
}

export const DEFAULT_EXECUTION: ExecutionSettings = {
  maxWorkers: 3, foregroundSeconds: 5, timeoutMinutes: 30, blockedCommands: ['sudo', 'su', 'shutdown', 'reboot', 'mkfs'], workspaceRoots: [],
}

export interface EngineOptions { home: string; now?: () => number }

type Row = typeof schema.tickets.$inferSelect

export class Engine {
  private now: () => number
  private lastStamp = 0
  /** Strictly increasing timestamps for timeline rows, so an ack, its task card and a fast reply never tie. */
  private stamp(): number { this.lastStamp = Math.max(this.now(), this.lastStamp + 1); return this.lastStamp }

  constructor(private store: Store, private runtime: AgentRuntime, private bus: Bus, private opts: EngineOptions) {
    this.now = opts.now ?? Date.now
  }

  get workRoot() { return join(this.opts.home, 'work') }

  execution(): ExecutionSettings {
    return { ...DEFAULT_EXECUTION, ...(kvGet<Partial<ExecutionSettings>>(this.store, 'settings:execution') ?? {}) }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  ticket(id: string): Ticket {
    const row = this.store.db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()
    if (!row) throw new DomainError('missing', `没有任务 ${id}`)
    return row as unknown as Ticket
  }

  tickets(filter: { open?: boolean; threadId?: string } = {}): Ticket[] {
    const where = [
      filter.open ? isNull(schema.tickets.ended) : undefined,
      filter.threadId ? eq(schema.tickets.threadId, filter.threadId) : undefined,
    ].filter(Boolean)
    return this.store.db.select().from(schema.tickets).where(and(...where as any)).orderBy(desc(schema.tickets.createdAt)).all() as unknown as Ticket[]
  }

  /** Tickets subscribed to a thread. */
  subscribers(threadId: string): Ticket[] {
    const ids = this.store.db.select({ id: schema.subscriptions.ticketId }).from(schema.subscriptions).where(eq(schema.subscriptions.threadId, threadId)).all().map(r => r.id)
    if (!ids.length) return []
    return this.store.db.select().from(schema.tickets).where(inArray(schema.tickets.id, ids)).orderBy(asc(schema.tickets.createdAt)).all() as unknown as Ticket[]
  }

  stage(ticket: Ticket): TicketStage {
    if (ticket.ended) return 'ended'
    if (ticket.attention) return 'person/answer'
    const report = ticket.latestReport
    if (report && (report.status === 'blocked' || report.status === 'failed') && !this.humanInputSince(ticket.sessionId, report.at)) {
      return report.status === 'blocked' ? 'person/blocked' : 'person/failed'
    }
    const session = this.runtime.session(ticket.sessionId)
    if (session?.state === 'error' && !this.humanInputSince(ticket.sessionId, ticket.updatedAt)) return 'person/failed'
    if (session?.state === 'running') return 'working'
    if (session?.state === 'queued') return 'queued'
    if (this.runtime.pending(ticket.sessionId).length > 0) return 'queued'
    return 'idle'
  }

  /** What `recall` and the cards show for a ticket. */
  describeTicket(ticket: Ticket): string {
    const reports = this.store.db.select().from(schema.reports).where(eq(schema.reports.ticketId, ticket.id)).orderBy(desc(schema.reports.at)).limit(5).all()
    return [
      `<task id="${ticket.id}" title="${ticket.title}" stage="${this.stage(ticket)}" conversation="${conversationOf(ticket.threadId) ?? ticket.threadId}" dir="${ticket.directory}">`,
      ticket.note ? `note: ${ticket.note}` : '',
      ticket.attention ? `waiting for owner: ${ticket.attention.question}` : '',
      ticket.ended ? `ended: ${ticket.ended.outcome} by ${ticket.ended.by}${ticket.ended.reason ? ` (${ticket.ended.reason})` : ''}` : '',
      `origin triggers: ${ticket.origin.triggerIds.join(', ')}`,
      ...reports.map(r => `report ${new Date(r.at).toISOString()} ${r.status}: ${clip(r.summary, 600)}`),
      '</task>',
    ].filter(Boolean).join('\n')
  }

  // ── Source: web chat ───────────────────────────────────────────────────────

  ensureThread(conversationId: string): string {
    const id = webchatThread(conversationId)
    this.store.db.insert(schema.threads).values({ id, source: 'webchat', ref: conversationId, createdAt: this.now() }).onConflictDoNothing().run()
    return id
  }

  /**
   * The owner wrote in a conversation. Fast path: a message aimed at one task (`replyTo`, or the conversation's only open
   * task) goes straight to that task's worker, and the router only gets a follow-up notice. Everything else goes to the router.
   */
  receiveMessage(conversationId: string, text: string, opts: { replyTo?: string } = {}) {
    return this.store.atomic(() => {
      const threadId = this.ensureThread(conversationId)
      const at = this.now()
      const triggerId = newId('trg')
      this.store.db.insert(schema.triggers).values({ id: triggerId, threadId, source: 'webchat', actor: 'owner', human: true, text, at }).run()
      const messageAt = this.stamp()
      const messageId = newId('msg')
      this.store.db.insert(schema.messages).values({ id: messageId, conversationId, role: 'user', content: text, triggerId, createdAt: messageAt }).run()
      this.store.db.update(schema.conversations).set({ updatedAt: at }).where(eq(schema.conversations.id, conversationId)).run()

      const subscribed = this.subscribers(threadId)
      let targets: Ticket[] = []
      if (opts.replyTo) {
        const t = subscribed.find(s => s.id === opts.replyTo)
        if (!t) throw new DomainError('invalid', `任务 ${opts.replyTo} 不属于这个对话`)
        if (t.ended?.by === 'person') throw new DomainError('conflict', '这个任务已被你停止；要继续请发起新任务')
        targets = [t]
      } else {
        const open = subscribed.filter(t => !t.ended)
        if (open.length === 1) targets = open
      }

      if (targets.length) {
        for (const t of targets) this.deliver(t, triggerId, true)
        this.setDisposition(triggerId, { deliveredTo: targets.map(t => t.id) })
        this.runtime.push(ROUTER_SESSION, { type: 'followup', triggerId, ticketIds: targets.map(t => t.id) }, { wake: false })
      } else {
        this.runtime.push(ROUTER_SESSION, { type: 'trigger', triggerId }, { human: true })
      }
      this.store.afterCommit(() => this.bus.emit({ type: 'message.created', conversationId, messageId }))
      return { triggerId, messageId, deliveredTo: targets.map(t => t.id) }
    })
  }

  // ── Router commands ────────────────────────────────────────────────────────

  reply(input: { conversationId: string; text: string; ticketId?: string; callId?: string }): string {
    const conversation = this.store.db.select().from(schema.conversations).where(eq(schema.conversations.id, input.conversationId)).get()
    if (!conversation) throw new DomainError('missing', `没有对话 ${input.conversationId}`)
    const id = newId('msg')
    const at = this.stamp()
    this.store.atomic(() => {
      this.store.db.insert(schema.messages).values({ id, conversationId: input.conversationId, role: 'assistant', content: input.text,
        ticketId: input.ticketId ?? null, meta: input.callId ? { callId: input.callId } : {}, createdAt: at }).run()
      this.store.db.update(schema.conversations).set({ updatedAt: at }).where(eq(schema.conversations.id, input.conversationId)).run()
    })
    this.bus.emit({ type: 'message.created', conversationId: input.conversationId, messageId: id })
    return id
  }

  startTask(input: { conversationId: string; triggerIds: string[]; title: string; name?: string; note?: string; ack?: string; directory?: string; callId?: string }): Ticket {
    const threadId = webchatThread(input.conversationId)
    const triggers = input.triggerIds.length
      ? this.store.db.select().from(schema.triggers).where(inArray(schema.triggers.id, input.triggerIds)).all() : []
    if (!triggers.length) throw new DomainError('invalid', 'start_task 需要至少一个来自主人的 trigger_id')
    if (triggers.length !== input.triggerIds.length) throw new DomainError('invalid', '有 trigger_id 不存在')
    if (triggers.some(t => t.threadId !== threadId)) throw new DomainError('invalid', 'trigger 不属于这个对话')
    // Idempotent per trigger set: a retried call returns the ticket it already made.
    const existing = this.tickets({ threadId }).find(t => sameSet(t.origin.triggerIds, input.triggerIds))
    if (existing) return existing

    const id = newId('tkt')
    const name = /^[a-z0-9][a-z0-9-]{1,40}$/.test(input.name ?? '') ? `${input.name}-${id.slice(-4)}` : `task-${id.slice(-6)}`
    const directory = this.chooseDirectory(input.directory, name)
    const sessionId = `ses_${id.slice(4)}`
    const at = this.now()
    const mandate: Mandate = { by: 'owner', strength: 'explicit', triggerIds: input.triggerIds, at }
    this.store.atomic(() => {
      this.runtime.createSession('worker', 'worker', { id: sessionId, ticketId: id })
      this.store.db.insert(schema.tickets).values({ id, name, title: input.title.slice(0, 60), note: input.note ?? null, threadId,
        origin: { triggerIds: input.triggerIds }, mandate: mandate as any, directory, sessionId, createdAt: at, updatedAt: at }).run()
      this.store.db.insert(schema.subscriptions).values({ ticketId: id, threadId, kind: 'own', createdAt: at }).run()
      for (const t of input.triggerIds) this.setDisposition(t, { startedTicket: id })
      if (input.ack) this.reply({ conversationId: input.conversationId, text: input.ack, ticketId: id, ...(input.callId ? { callId: input.callId } : {}) })
      const cardId = newId('msg')
      this.store.db.insert(schema.messages).values({ id: cardId, conversationId: input.conversationId, role: 'event', content: input.title, ticketId: id,
        meta: { kind: 'ticket' }, createdAt: this.stamp() }).run()
      this.startAssignment(id, 'start')
      this.runtime.push(sessionId, { type: 'assignment', ticketId: id, reason: 'start' }, { human: true })
      this.store.afterCommit(() => this.bus.emit({ type: 'message.created', conversationId: input.conversationId, messageId: cardId }))
    })
    mkdirSync(directory, { recursive: true })
    this.changed(id)
    return this.ticket(id)
  }

  /** Routes a message to a task it explicitly refers to; an ended task resumes unless the owner stopped it. */
  attach(input: { ticketId: string; triggerId: string; note?: string }): void {
    const ticket = this.ticket(input.ticketId)
    if (ticket.ended?.by === 'person') throw new DomainError('conflict', '这个任务已被主人停止，不能再附加；请用 start_task 开新任务')
    const trigger = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.id, input.triggerId)).get()
    if (!trigger) throw new DomainError('missing', `没有 ${input.triggerId}`)
    this.store.atomic(() => {
      if (trigger.threadId !== ticket.threadId) {
        this.store.db.insert(schema.subscriptions).values({ ticketId: ticket.id, threadId: trigger.threadId, kind: 'attached', createdAt: this.now() }).onConflictDoNothing().run()
      }
      this.deliver(ticket, input.triggerId, trigger.human, input.note)
      this.setDisposition(input.triggerId, { attachedTo: ticket.id })
    })
    this.changed(ticket.id)
  }

  stopTask(ticketId: string, by: Ended['by'], reason?: string): void {
    const ticket = this.ticket(ticketId)
    if (ticket.ended) return
    this.store.atomic(() => {
      this.end(ticket, { at: this.now(), by, outcome: 'stopped', ...(reason ? { reason } : {}) })
      this.runtime.discardPending(ticket.sessionId)
      if (by === 'person') this.runtime.push(ROUTER_SESSION, { type: 'ticket-ended', ticketId, outcome: 'stopped', by }, { wake: false })
    })
    this.runtime.cancel(ticket.sessionId)
    this.changed(ticketId)
  }

  note(ticketId: string, text: string): void {
    const ticket = this.ticket(ticketId)
    if (ticket.ended) throw new DomainError('conflict', '任务已结束')
    this.store.atomic(() => this.runtime.push(ticket.sessionId, { type: 'note', text }))
  }

  // ── Worker facts ───────────────────────────────────────────────────────────

  report(ticketId: string, input: { status: ReportStatus; summary: string; humanAction?: HumanAction }): void {
    const ticket = this.ticket(ticketId)
    if (ticket.ended && ticket.ended.by === 'person') return
    const at = this.now()
    const report: Report = { status: input.status, summary: input.summary, ...(input.humanAction ? { humanAction: input.humanAction } : {}), at }
    this.store.atomic(() => {
      const assignment = this.currentAssignment(ticketId)
      this.store.db.insert(schema.reports).values({ ticketId, assignmentId: assignment?.id ?? null, status: input.status, summary: input.summary,
        humanAction: (input.humanAction ?? null) as any, at }).run()
      const attention: Attention | null = input.humanAction ? { ...input.humanAction, at } : ticket.attention
      this.store.db.update(schema.tickets).set({ latestReport: report as any, attention: attention as any, updatedAt: at }).where(eq(schema.tickets.id, ticketId)).run()
      const fresh = this.ticket(ticketId)
      if (input.status === 'ready') this.end(fresh, { at, by: 'worker', outcome: 'completed' })
      if (input.status === 'dropped') this.end(fresh, { at, by: 'worker', outcome: 'dropped', reason: input.summary })
      // The router speaks for results, questions and problems; progress stays on the task card.
      const relay = input.humanAction || ['ready', 'blocked', 'failed'].includes(input.status)
      if (input.status !== 'progress') this.runtime.push(ROUTER_SESSION, { type: 'report', ticketId, status: input.status, summary: input.summary,
        humanAction: input.humanAction }, { wake: Boolean(relay) })
    })
    this.changed(ticketId)
  }

  /** A worker returns a message that is not about its task; the router decides it as a new message. */
  handback(ticketId: string, triggerId: string, reason: string): void {
    const ticket = this.ticket(ticketId)
    const trigger = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    if (!trigger) throw new DomainError('missing', `没有 ${triggerId}`)
    const disposition = trigger.disposition as { handedBack?: { ticketId: string; reason: string }[] }
    if (disposition.handedBack?.some(h => h.ticketId === ticketId)) return
    this.store.atomic(() => {
      this.setDisposition(triggerId, { handedBack: [...(disposition.handedBack ?? []), { ticketId, reason }] })
      this.runtime.push(ROUTER_SESSION, { type: 'handback', ticketId: ticket.id, triggerId, reason }, { human: true })
    })
  }

  /** A worker turn ended. Without a report this turn, its last words become an implicit `waiting` (or `progress` while jobs run). */
  turnEnded(ticketId: string, info: { reported: boolean; lastText: string; runningJobs: number; cancelled: boolean; stepLimit: boolean }): void {
    const ticket = this.ticket(ticketId)
    if (ticket.ended || info.cancelled || info.reported) { this.changed(ticketId); return }
    if (info.stepLimit) return this.report(ticketId, { status: 'blocked', summary: `达到单轮步数上限仍未完成。最后的说明：${clip(info.lastText, 800) || '（无）'}` })
    this.report(ticketId, { status: info.runningJobs > 0 ? 'progress' : 'waiting', summary: clip(info.lastText, 2_000) || '（本轮结束，没有说明）' })
  }

  turnFailed(ticketId: string, message: string): void {
    const ticket = this.ticket(ticketId)
    if (ticket.ended) return
    this.report(ticketId, { status: 'failed', summary: `执行出错：${message}` })
  }

  // ── People ─────────────────────────────────────────────────────────────────

  retry(ticketId: string): void {
    const ticket = this.ticket(ticketId)
    if (ticket.ended) throw new DomainError('conflict', '任务已结束')
    const stage = this.stage(ticket)
    if (!['person/blocked', 'person/failed', 'idle'].includes(stage)) throw new DomainError('conflict', `当前状态（${stage}）不需要重试`)
    this.store.atomic(() => {
      this.startAssignment(ticketId, 'retry')
      this.runtime.push(ticket.sessionId, { type: 'assignment', ticketId, reason: 'retry' }, { human: true })
    })
    this.changed(ticketId)
  }

  /** Startup: tickets whose worker was mid-turn get a recovery assignment; the router gets a recovery note. */
  recoveryNote(sessionId: string, role: string): unknown {
    if (role === 'router') return { type: 'recovery' }
    const ticket = this.store.db.select().from(schema.tickets).where(eq(schema.tickets.sessionId, sessionId)).get()
    if (ticket && !ticket.ended) this.startAssignment(ticket.id, 'restart')
    return { type: 'assignment', ticketId: ticket?.id, reason: 'restart' }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private deliver(ticket: Ticket, triggerId: string, human: boolean, note?: string): void {
    if (ticket.ended) {
      this.store.db.update(schema.tickets).set({ ended: null, updatedAt: this.now() }).where(eq(schema.tickets.id, ticket.id)).run()
      this.startAssignment(ticket.id, 'resume')
      this.runtime.push(ticket.sessionId, { type: 'assignment', ticketId: ticket.id, reason: 'resume' }, { human })
    }
    if (human && ticket.attention) this.store.db.update(schema.tickets).set({ attention: null, updatedAt: this.now() }).where(eq(schema.tickets.id, ticket.id)).run()
    this.runtime.push(ticket.sessionId, { type: 'trigger', triggerId, ...(note ? { note } : {}) }, { human })
    this.store.afterCommit(() => this.changed(ticket.id))
  }

  /** Ends the ticket and its assignment; its background jobs are killed without waking the worker (dsh-superagent 003). */
  private end(ticket: Ticket, ended: Ended): void {
    this.store.afterCommit(() => this.runtime.jobs.stopAll(ticket.sessionId))
    this.store.db.update(schema.tickets).set({ ended: ended as any, attention: null, updatedAt: ended.at }).where(eq(schema.tickets.id, ticket.id)).run()
    this.store.db.update(schema.assignments).set({ status: 'ended', endedAt: ended.at, endReason: ended.outcome })
      .where(and(eq(schema.assignments.ticketId, ticket.id), eq(schema.assignments.status, 'running'))).run()
  }

  private startAssignment(ticketId: string, reason: 'start' | 'resume' | 'retry' | 'restart'): void {
    const at = this.now()
    this.store.db.update(schema.assignments).set({ status: 'ended', endedAt: at, endReason: `replaced:${reason}` })
      .where(and(eq(schema.assignments.ticketId, ticketId), eq(schema.assignments.status, 'running'))).run()
    this.store.db.insert(schema.assignments).values({ id: newId('asg'), ticketId, status: 'running', reason, startedAt: at }).run()
  }

  private currentAssignment(ticketId: string) {
    return this.store.db.select().from(schema.assignments).where(and(eq(schema.assignments.ticketId, ticketId), eq(schema.assignments.status, 'running'))).get()
  }

  private chooseDirectory(requested: string | undefined, name: string): string {
    if (!requested) return join(this.workRoot, name)
    const target = resolve(requested.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
    const roots = this.execution().workspaceRoots.map(r => resolve(r.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')))
    if (!roots.some(root => target === root || target.startsWith(root + sep))) {
      throw new DomainError('invalid', `目录 ${requested} 不在允许的工作目录内（设置 → 执行 → 允许的工作目录：${roots.join(', ') || '未设置'}）`)
    }
    return target
  }

  private humanInputSince(sessionId: string, at: number): boolean {
    return (this.store.db.select({ n: sql<number>`count(*)` }).from(schema.sessionInbox)
      .where(and(eq(schema.sessionInbox.sessionId, sessionId), eq(schema.sessionInbox.human, true), gt(schema.sessionInbox.createdAt, at))).get()?.n ?? 0) > 0
  }

  private setDisposition(triggerId: string, patch: Record<string, unknown>): void {
    const row = this.store.db.select({ d: schema.triggers.disposition }).from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    this.store.db.update(schema.triggers).set({ disposition: { ...(row?.d ?? {}), ...patch } }).where(eq(schema.triggers.id, triggerId)).run()
  }

  changed(ticketId: string): void {
    this.bus.emit({ type: 'ticket.updated', ticketId })
  }
}

export const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text)
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
export type TicketRow = Row
