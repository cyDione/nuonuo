/**
 * The Engine owns the domain state — threads, triggers, tickets, subscriptions, assignments, reports — and is its only
 * writer. Sources call `receiveMessage`; the router's tools call the router commands; workers' tools and turn hooks call
 * the worker facts; people call the people commands. Each command is one transaction; agent wake-ups run after commit.
 */
import type { AgentRuntime, Bus } from '@super-agent/agent-runtime'
import { kvGet, kvSet, newId, schema, type Store } from '@super-agent/db'
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DEFAULT_SANDBOX, type SandboxSettings } from './sandbox'
import { sourceOfThread, webchatThread, type Attention, type Ended, type HumanAction, type IncomingTrigger, type Mandate, type Report, type ReportStatus, type SourcePort, type Ticket, type TicketStage } from './model'

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
  sandbox: SandboxSettings
}

export const DEFAULT_EXECUTION: ExecutionSettings = {
  maxWorkers: 3, foregroundSeconds: 5, timeoutMinutes: 30, blockedCommands: ['sudo', 'su', 'shutdown', 'reboot', 'mkfs'], workspaceRoots: [],
  sandbox: DEFAULT_SANDBOX,
}

export interface EngineOptions { home: string; now?: () => number; sources?: SourcePort }

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
    const saved = kvGet<Partial<ExecutionSettings>>(this.store, 'settings:execution') ?? {}
    return { ...DEFAULT_EXECUTION, ...saved, sandbox: { ...DEFAULT_SANDBOX, ...(saved.sandbox ?? {}) } }
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

  /** The project a task belongs to: set when it was started, else its GitHub repository. Drives project memory. */
  projectOf(ticket: Ticket): string | undefined {
    const explicit = kvGet<string>(this.store, `ticket:project:${ticket.id}`)
    if (explicit) return explicit
    const m = /^github:([\w.-]+\/[\w.-]+)#/.exec(ticket.threadId)
    return m?.[1]
  }

  setProject(ticketId: string, project: string): void {
    kvSet(this.store, `ticket:project:${ticketId}`, project.trim())
  }

  /** Threads a ticket is subscribed to. */
  subscribersOfTicket(ticketId: string): string[] {
    return this.store.db.select({ threadId: schema.subscriptions.threadId }).from(schema.subscriptions).where(eq(schema.subscriptions.ticketId, ticketId)).all().map(r => r.threadId)
  }

  stage(ticket: Ticket): TicketStage {
    if (ticket.ended) return 'ended'
    const approvals = this.store.db.select({ id: schema.approvals.id }).from(schema.approvals)
      .where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending'))).get()
    if (approvals) return 'person/approve'
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
      `<task id="${ticket.id}" title="${ticket.title}" stage="${this.stage(ticket)}" conversation="${this.conversationOfThread(ticket.threadId) ?? ''}" thread="${ticket.threadId}" dir="${ticket.directory}">`,
      ticket.note ? `note: ${ticket.note}` : '',
      ticket.attention ? `waiting for owner: ${ticket.attention.question}` : '',
      ticket.ended ? `ended: ${ticket.ended.outcome} by ${ticket.ended.by}${ticket.ended.reason ? ` (${ticket.ended.reason})` : ''}` : '',
      `origin triggers: ${ticket.origin.triggerIds.join(', ')}`,
      ...reports.map(r => `report ${new Date(r.at).toISOString()} ${r.status}: ${clip(r.summary, 600)}`),
      '</task>',
    ].filter(Boolean).join('\n')
  }

  // ── Threads and their conversations ────────────────────────────────────────

  /** The thread a conversation shows: its own web chat thread, or the external thread it mirrors. */
  threadOf(conversationId: string): string {
    const row = this.store.db.select({ threadId: schema.conversations.threadId }).from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get()
    if (!row) throw new DomainError('missing', `没有对话 ${conversationId}`)
    return row.threadId ?? webchatThread(conversationId)
  }

  /** The conversation that shows a thread, if any. */
  conversationOfThread(threadId: string): string | undefined {
    if (threadId.startsWith('webchat:')) return threadId.slice('webchat:'.length)
    return this.store.db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.threadId, threadId)).get()?.id
  }

  ensureThread(conversationId: string): string {
    const id = this.threadOf(conversationId)
    this.store.db.insert(schema.threads).values({ id, source: sourceOfThread(id), ref: conversationId, createdAt: this.now() }).onConflictDoNothing().run()
    return id
  }

  /** Opens (once) the web conversation that mirrors an external thread, so the owner sees it beside their own topics. */
  mirrorConversation(threadId: string, info: { title: string; url?: string; meta?: Record<string, unknown> }): string {
    const existing = this.conversationOfThread(threadId)
    if (existing) return existing
    const id = newId('cnv')
    const at = this.stamp()
    this.store.db.insert(schema.conversations).values({ id, title: info.title.slice(0, 80), source: sourceOfThread(threadId), threadId, origin: 'agent',
      meta: { ...(info.meta ?? {}), ...(info.url ? { url: info.url } : {}) }, createdAt: at, updatedAt: at }).run()
    this.store.afterCommit(() => this.bus.emit({ type: 'conversation.updated', conversationId: id }))
    return id
  }

  /** Opens a conversation on the agent's initiative (a notification, a routine's results). */
  openConversation(title: string, opts: { source?: string; meta?: Record<string, unknown> } = {}): string {
    const id = newId('cnv')
    const at = this.stamp()
    this.store.db.insert(schema.conversations).values({ id, title: title.slice(0, 80), source: opts.source ?? 'webchat', origin: 'agent', meta: opts.meta ?? {}, createdAt: at, updatedAt: at }).run()
    this.store.afterCommit(() => this.bus.emit({ type: 'conversation.updated', conversationId: id }))
    return id
  }

  private allowed(source: string, actor: string): boolean {
    if (source === 'webchat' || source === 'cron') return actor === 'owner'
    return this.opts.sources?.allowed(source, actor) ?? false
  }

  // ── Source: any external source ────────────────────────────────────────────

  /**
   * One event from a source (dsh-superagent's Intake, for one owner):
   * - it reaches every task subscribed to its thread (fan-out, no authority granted); an allowed person's message resumes
   *   an ended task that the owner did not stop, bots and CI never do;
   * - if no task took it and an allowed person addressed the agent, it goes to the router as a request;
   * - anything else is recorded and ignored.
   */
  receive(t: IncomingTrigger): { status: 'stored' | 'duplicate'; deliveredTo: string[]; routed: boolean } {
    return this.store.atomic(() => {
      if (this.store.db.select({ id: schema.triggers.id }).from(schema.triggers).where(eq(schema.triggers.id, t.id)).get()) {
        return { status: 'duplicate' as const, deliveredTo: [], routed: false }
      }
      this.store.db.insert(schema.threads).values({ id: t.threadId, source: t.source, ref: t.threadId, meta: { ...(t.thread.meta ?? {}), title: t.thread.title, ...(t.thread.url ? { url: t.thread.url } : {}) }, createdAt: this.now() }).onConflictDoNothing().run()
      this.store.db.insert(schema.triggers).values({ id: t.id, threadId: t.threadId, source: t.source, actor: t.actor, human: t.human, text: t.text,
        meta: { ...(t.meta ?? {}), ...(t.url ? { url: t.url } : {}), addressed: t.addressed }, at: t.at }).run()
      const allowed = t.human && this.allowed(t.source, t.actor)
      const targets = this.subscribers(t.threadId).filter(ticket => ticket.ended?.by !== 'person' && (!ticket.ended || allowed))
      const explicit = allowed && t.addressed
      if (!targets.length && !explicit) {
        this.setDisposition(t.id, { ignored: !t.human ? 'bot' : !allowed ? 'not_allowed' : 'not_addressed' })
        return { status: 'stored' as const, deliveredTo: [], routed: false }
      }
      const conversationId = this.mirrorConversation(t.threadId, t.thread)
      const messageId = newId('msg')
      this.store.db.insert(schema.messages).values({ id: messageId, conversationId, role: 'user', content: t.text, triggerId: t.id,
        meta: { source: t.source, actor: t.actor, human: t.human, ...(t.url ? { url: t.url } : {}) }, createdAt: this.stamp() }).run()
      this.store.db.update(schema.conversations).set({ updatedAt: this.now() }).where(eq(schema.conversations.id, conversationId)).run()
      this.store.afterCommit(() => this.bus.emit({ type: 'message.created', conversationId, messageId }))
      if (targets.length) {
        for (const ticket of targets) this.deliver(ticket, t.id, allowed)
        this.setDisposition(t.id, { deliveredTo: targets.map(x => x.id) })
        if (allowed) this.runtime.push(ROUTER_SESSION, { type: 'followup', triggerId: t.id, ticketIds: targets.map(x => x.id) }, { wake: false })
        return { status: 'stored' as const, deliveredTo: targets.map(x => x.id), routed: false }
      }
      this.runtime.push(ROUTER_SESSION, { type: 'trigger', triggerId: t.id }, { human: true })
      return { status: 'stored' as const, deliveredTo: [], routed: true }
    })
  }

  /** A followed thread closed (a pull request merged or closed): tasks that opened it end once none of their own threads is open. */
  threadClosed(threadId: string, outcome: 'merged' | 'closed'): void {
    const at = this.now()
    const affected: string[] = []
    this.store.atomic(() => {
      this.store.db.update(schema.subscriptions).set({ closed: { at, outcome } }).where(and(eq(schema.subscriptions.threadId, threadId), eq(schema.subscriptions.kind, 'own'))).run()
      for (const ticket of this.subscribers(threadId)) {
        if (ticket.ended) continue
        const own = this.store.db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.ticketId, ticket.id), eq(schema.subscriptions.kind, 'own'))).all()
        // The ticket's origin thread does not count: only threads it opened (its pull requests).
        const opened = own.filter(s => s.threadId !== ticket.threadId)
        if (!opened.length || opened.some(s => !s.closed)) continue
        this.end(ticket, { at, by: 'system', outcome })
        this.runtime.push(ROUTER_SESSION, { type: 'ticket-ended', ticketId: ticket.id, outcome, by: 'system' }, { wake: false })
        affected.push(ticket.id)
      }
    })
    for (const id of affected) this.changed(id)
  }

  /** A task follows another thread: one it opened (`own`, e.g. its pull request) or one it reads for context. */
  follow(ticketId: string, threadId: string, kind: 'own' | 'context', info?: { title: string; url?: string; meta?: Record<string, unknown> }): void {
    const ticket = this.ticket(ticketId)
    this.store.atomic(() => {
      this.store.db.insert(schema.threads).values({ id: threadId, source: sourceOfThread(threadId), ref: threadId, meta: info ? { ...(info.meta ?? {}), title: info.title, ...(info.url ? { url: info.url } : {}) } : {}, createdAt: this.now() }).onConflictDoNothing().run()
      this.store.db.insert(schema.subscriptions).values({ ticketId: ticket.id, threadId, kind, createdAt: this.now() })
        .onConflictDoUpdate({ target: [schema.subscriptions.ticketId, schema.subscriptions.threadId], set: { kind, closed: null } }).run()
    })
    this.changed(ticketId)
  }

  /** Threads a task follows, with what a source needs to poll them. */
  followed(): { threadId: string; ticketId: string; kind: string; closed: unknown; meta: Record<string, unknown> }[] {
    return this.store.sqlite.prepare(`SELECT s.thread_id AS threadId, s.ticket_id AS ticketId, s.kind, s.closed, t.meta FROM subscriptions s
      JOIN threads t ON t.id = s.thread_id JOIN tickets k ON k.id = s.ticket_id
      WHERE (k.ended IS NULL OR k.updated_at > ?) AND json_extract(coalesce(k.ended, '{}'), '$.by') IS NOT 'person'`)
      .all(this.now() - 14 * 86_400_000).map((r: any) => ({ ...r, closed: r.closed ? JSON.parse(r.closed) : null, meta: JSON.parse(r.meta) }))
  }

  // ── Source: web chat ───────────────────────────────────────────────────────

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
      this.store.db.insert(schema.messages).values({ id: messageId, conversationId, role: 'user', content: text, triggerId, meta: { source: 'webchat' }, createdAt: messageAt }).run()
      this.store.db.update(schema.conversations).set({ updatedAt: at }).where(eq(schema.conversations.id, conversationId)).run()

      // The watchdog's own conversation talks to the watchdog, not the router.
      const source = this.store.db.select({ source: schema.conversations.source }).from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get()?.source
      if (source === 'watchdog') {
        this.runtime.push('ses_watchdog', { type: 'owner', text, triggerId }, { human: true })
        this.store.afterCommit(() => this.bus.emit({ type: 'message.created', conversationId, messageId }))
        return { triggerId, messageId, deliveredTo: [] as string[] }
      }
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

  /**
   * Posts the agent's message in a conversation. It also goes out through the source's channel (a GitHub comment) when it
   * answers a message from that source (`replyTo`) or reports on a task that came from it (`ticketId`); otherwise it stays in the web.
   */
  reply(input: { conversationId: string; text: string; ticketId?: string; replyTo?: string; callId?: string }): string {
    const conversation = this.store.db.select().from(schema.conversations).where(eq(schema.conversations.id, input.conversationId)).get()
    if (!conversation) throw new DomainError('missing', `没有对话 ${input.conversationId}`)
    const id = newId('msg')
    const at = this.stamp()
    const via = this.replySource(input.replyTo, input.ticketId)
    const threadId = conversation.threadId
    const external = via !== 'webchat' && threadId && sourceOfThread(threadId) === via && this.opts.sources?.hasChannel(via)
    this.store.atomic(() => {
      this.store.db.insert(schema.messages).values({ id, conversationId: input.conversationId, role: 'assistant', content: input.text,
        ticketId: input.ticketId ?? null, meta: { ...(input.callId ? { callId: input.callId } : {}), ...(external ? { via, delivery: 'pending' } : {}) }, createdAt: at }).run()
      this.store.db.update(schema.conversations).set({ updatedAt: at }).where(eq(schema.conversations.id, input.conversationId)).run()
      if (external) this.opts.sources!.send({ messageId: id, source: via, threadId: threadId!, text: input.text, ...(input.ticketId ? { ticketId: input.ticketId } : {}) })
    })
    this.bus.emit({ type: 'message.created', conversationId: input.conversationId, messageId: id })
    return id
  }

  private replySource(replyTo?: string, ticketId?: string): string {
    if (replyTo) {
      const t = this.store.db.select({ source: schema.triggers.source }).from(schema.triggers).where(eq(schema.triggers.id, replyTo)).get()
      if (t) return t.source
    }
    if (ticketId) {
      const ticket = this.store.db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
      const origin = ticket && this.store.db.select({ source: schema.triggers.source }).from(schema.triggers).where(eq(schema.triggers.id, (ticket.origin as { triggerIds: string[] }).triggerIds[0]!)).get()
      if (origin) return origin.source
    }
    return 'webchat'
  }

  /** Marks the delivery of a message that went out through a source channel. */
  delivered(messageId: string, result: { ok: true; url?: string } | { ok: false; error: string; final?: boolean }): void {
    const row = this.store.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
    if (!row) return
    const meta = result.ok ? { ...row.meta, delivery: 'sent', ...(result.url ? { url: result.url } : {}) }
      : { ...row.meta, delivery: result.final ? 'dropped' : 'failing', deliveryError: result.error }
    this.store.db.update(schema.messages).set({ meta }).where(eq(schema.messages.id, messageId)).run()
    this.bus.emit({ type: 'message.created', conversationId: row.conversationId, messageId })
  }

  startTask(input: { conversationId?: string; triggerIds: string[]; title: string; name?: string; note?: string; ack?: string; directory?: string; project?: string; callId?: string }): Ticket {
    const triggers = input.triggerIds.length
      ? this.store.db.select().from(schema.triggers).where(inArray(schema.triggers.id, input.triggerIds)).all() : []
    if (!triggers.length) throw new DomainError('invalid', 'start_task 需要至少一个 trigger_id')
    if (triggers.length !== input.triggerIds.length) throw new DomainError('invalid', '有 trigger_id 不存在')
    const threadId = triggers[0]!.threadId
    if (triggers.some(t => t.threadId !== threadId)) throw new DomainError('invalid', '一个任务的 trigger 必须来自同一个对话/线程')
    if (triggers.some(t => !t.human || !this.allowed(t.source, t.actor))) throw new DomainError('invalid', '只有主人（或允许的账号）的消息才能开任务')
    const conversationId = this.conversationOfThread(threadId)
    if (!conversationId) throw new DomainError('missing', '这个线程没有对应的对话')
    if (input.conversationId && input.conversationId !== conversationId) throw new DomainError('invalid', `trigger 属于对话 ${conversationId}，不是 ${input.conversationId}`)
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
      if (input.ack) this.reply({ conversationId, text: input.ack, ticketId: id, ...(input.callId ? { callId: input.callId } : {}) })
      const cardId = newId('msg')
      this.store.db.insert(schema.messages).values({ id: cardId, conversationId, role: 'event', content: input.title, ticketId: id,
        meta: { kind: 'ticket' }, createdAt: this.stamp() }).run()
      if (input.project) this.setProject(id, input.project)
      this.startAssignment(id, 'start')
      this.runtime.push(sessionId, { type: 'assignment', ticketId: id, reason: 'start' }, { human: true })
      this.store.afterCommit(() => this.bus.emit({ type: 'message.created', conversationId, messageId: cardId }))
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
      // A pending browser handoff is not replaced by a plain question the worker adds afterwards.
      const keepHandoff = ticket.attention?.kind === 'handoff' && input.humanAction && input.humanAction.kind !== 'handoff'
      const attention: Attention | null = input.humanAction && !keepHandoff ? { ...input.humanAction, at } : ticket.attention
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

  /** Starts a task's worker again regardless of its stage (the watchdog, for a hung turn). */
  restart(ticketId: string, reason: string): void {
    const ticket = this.ticket(ticketId)
    if (ticket.ended) throw new DomainError('conflict', '任务已结束')
    this.store.atomic(() => {
      this.startAssignment(ticketId, 'retry')
      this.runtime.push(ticket.sessionId, { type: 'assignment', ticketId, reason: 'retry', note: reason }, { human: true })
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
    this.store.db.update(schema.approvals).set({ status: 'expired', decidedAt: ended.at, decidedBy: 'system' })
      .where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending'))).run()
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
