/**
 * The Engine owns the domain state — threads, triggers, tickets, subscriptions, assignments, reports — and is its only
 * writer. Sources call `receiveMessage`; the router's tools call the router commands; workers' tools and turn hooks call
 * the worker facts; people call the people commands. Each command is one transaction; agent wake-ups run after commit.
 */
import type { AgentRuntime, Bus } from '@nuonuo/agent-runtime'
import { kvGet, kvSet, newId, schema, type Store } from '@nuonuo/db'
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fastPath, proactiveSettings, saveProactiveSettings, type FilterVerdict, type ProactiveMode } from './proactive'
import { DEFAULT_SANDBOX, type SandboxSettings } from './sandbox'
import { sourceOfThread, webchatThread, type Attention, type Ended, type HumanAction, type IncomingTrigger, type Mandate, type Report, type ReportStatus, type SourcePort, type Ticket, type TicketStage } from './model'

export const ROUTER_SESSION = 'ses_router'

/** A paired client device (client protocol) the owner wrote from: a phone, a watch, a speaker, a car… */
export interface SendingDevice { id: string; name: string; kind: string; display: 'full' | 'small' | 'none' }

/** What the assistant is told about a device that cannot show a normal chat, so its answer fits. */
export function deviceNote(device: SendingDevice): string {
  if (device.display === 'none') return `\n\n（这条是从「${device.name}」发来的。它没有屏幕，只会把回答念出来：请用简短、口语化的话回答，不要用表格、代码、链接或 Markdown。）`
  if (device.display === 'small') return `\n\n（这条是从「${device.name}」发来的，屏幕很小：请尽量一两句话回答，不要用表格或长列表。）`
  return ''
}

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

export interface EngineOptions {
  home: string
  now?: () => number
  sources?: SourcePort
  /** Queues the Slow Path screening of an unaddressed event, inside the caller's transaction. */
  screen?: (triggerId: string) => void
}

/** What an agent message carries when it delivers a finished task: the full result and the files. */
export interface Delivery { ticketId: string; title: string; summary: string; files: { id: string; name: string; size: number }[] }

type Row = typeof schema.tickets.$inferSelect

export class Engine {
  private now: () => number
  private lastStamp = 0
  /** Strictly increasing timestamps for timeline rows, so an ack, its task card and a fast reply never tie. */
  private stamp(): number { this.lastStamp = Math.max(this.now(), this.lastStamp + 1); return this.lastStamp }

  constructor(private store: Store, private runtime: AgentRuntime, private bus: Bus, private opts: EngineOptions) {
    this.now = opts.now ?? Date.now
  }

  /** The assistant's tapback on the owner's message (👌 😂 ❤️ …), shown on the bubble's corner. */
  react(triggerId: string, emoji: string): boolean {
    const message = this.store.db.select().from(schema.messages).where(eq(schema.messages.triggerId, triggerId)).get()
    if (!message || message.role !== 'user') return false
    this.store.db.update(schema.messages).set({ meta: { ...message.meta, tapback: emoji } }).where(eq(schema.messages.id, message.id)).run()
    this.bus.emit({ type: 'message.updated', conversationId: message.conversationId, messageId: message.id })
    return true
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

  /** The project a task belongs to: set when it was started, else its thread's (a repository, or a side chat). Drives project memory. */
  projectOf(ticket: Ticket): string | undefined {
    return kvGet<string>(this.store, `ticket:project:${ticket.id}`) ?? this.scopeOfThread(ticket.threadId)
  }

  /**
   * Memory is bound to the project a thread belongs to (Grok Bot: "it always understands this project"): a GitHub
   * repository, or a side chat. The main conversation has no project; it sees the owner's profile and recalls broadly.
   */
  scopeOfThread(threadId: string): string | undefined {
    const gh = /^github:([\w.-]+\/[\w.-]+)#/.exec(threadId)
    if (gh) return gh[1]
    const cnv = threadId.startsWith('webchat:') ? threadId.slice('webchat:'.length) : undefined
    if (!cnv || cnv === this.mainConversation()) return undefined
    const row = this.store.db.select({ source: schema.conversations.source }).from(schema.conversations).where(eq(schema.conversations.id, cnv)).get()
    return row?.source === 'webchat' ? cnv : undefined
  }

  /** The owner's main conversation (Muse): where the assistant talks to them by default. Created on first use. */
  mainConversation(): string {
    const id = kvGet<string>(this.store, 'conversation:main')
    if (id && this.store.db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.id, id)).get()) return id
    const at = this.stamp()
    const created = newId('cnv')
    this.store.db.insert(schema.conversations).values({ id: created, title: '主对话', source: 'webchat', origin: 'owner', meta: { main: true }, pinned: true, createdAt: at, updatedAt: at }).run()
    kvSet(this.store, 'conversation:main', created)
    return created
  }

  /** Whether a trigger comes from someone allowed to ask for work (the owner, or an allowlisted account). */
  isOwnerTrigger(triggerId: string): boolean {
    const t = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    return Boolean(t && t.human && this.allowed(t.source, t.actor))
  }

  /**
   * Whether a trigger is the owner talking to the assistant in a chat channel (the web, a routine, the owner's own
   * Telegram): only those words may write memory directly. A comment on GitHub or an email — even the owner's — is
   * about work in a shared space; what it suggests remembering goes to the review queue.
   */
  isOwnerChat(triggerId: string): boolean {
    const t = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    if (!t || !t.human) return false
    if (t.source === 'webchat' || t.source === 'cron') return t.actor === 'owner'
    return t.source === 'telegram' && this.allowed(t.source, t.actor)
  }

  /** A session that has read other people's words is tainted: what it remembers goes to the owner's review queue. */
  taint(sessionId: string): void { if (!this.tainted(sessionId)) kvSet(this.store, `taint:${sessionId}`, true) }
  tainted(sessionId: string): boolean { return kvGet<boolean>(this.store, `taint:${sessionId}`) === true }

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
      // A web chat thread (a routine speaking in the main conversation) has no fan-out: the router decides.
      const targets = t.threadId.startsWith('webchat:') ? [] : this.subscribers(t.threadId).filter(ticket => ticket.ended?.by !== 'person' && (!ticket.ended || allowed))
      const explicit = allowed && t.addressed
      if (!targets.length && !explicit) {
        const ignored = !t.human ? 'bot' : !allowed ? 'not_allowed' : 'not_addressed'
        const skip = this.opts.screen ? fastPath(proactiveSettings(this.store), t) : 'no_screener'
        this.setDisposition(t.id, { ignored, ...(skip ? { fastPath: skip } : { screening: true }) })
        if (!skip) this.opts.screen!(t.id)
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

  /** A task stops following a thread it no longer needs; its origin thread stays. */
  unfollow(ticketId: string, threadId: string): void {
    const ticket = this.ticket(ticketId)
    if (threadId === ticket.threadId) throw new DomainError('invalid', '不能取消订阅任务自己的来源线程')
    this.store.db.delete(schema.subscriptions).where(and(eq(schema.subscriptions.ticketId, ticketId), eq(schema.subscriptions.threadId, threadId))).run()
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
  receiveMessage(conversationId: string, text: string, opts: { replyTo?: string; attachments?: Attachment[]; quote?: { messageId: string; text: string }; device?: SendingDevice } = {}) {
    return this.store.atomic(() => {
      const threadId = this.ensureThread(conversationId)
      const at = this.now()
      const triggerId = newId('trg')
      const files = opts.attachments ?? []
      // The agent reads the attachments by path (the file tools reach the uploads folder); the chat shows them as chips.
      const quoted = opts.quote ? `> ${clip(opts.quote.text, 400).replace(/\n/g, '\n> ')}\n\n` : ''
      const listed = files.length ? `\n\n[附件]\n${files.map(f => `- ${f.name}（${f.mime}，${formatSize(f.size)}）：${f.path}`).join('\n')}` : ''
      const triggerText = `${quoted}${text || (files.length ? '（发来了附件）' : '')}${listed}`
        + (opts.device ? deviceNote(opts.device) : '')
      this.store.db.insert(schema.triggers).values({ id: triggerId, threadId, source: 'webchat', actor: 'owner', human: true, text: triggerText, at,
        meta: files.length || opts.quote || opts.device ? { ...(files.length ? { attachments: files.map(f => f.id) } : {}), ...(opts.quote ? { quote: opts.quote.messageId } : {}),
          ...(opts.device ? { device: opts.device } : {}) } : {} }).run()
      const messageAt = this.stamp()
      const messageId = newId('msg')
      const meta: Record<string, unknown> = { source: 'webchat' }
      if (files.length) meta.attachments = files.map(({ id, name, mime, size }) => ({ id, name, mime, size }))
      if (opts.quote) meta.quote = opts.quote
      if (opts.device) meta.device = opts.device
      this.store.db.insert(schema.messages).values({ id: messageId, conversationId, role: 'user', content: text, triggerId, meta, createdAt: messageAt }).run()
      if (files.length) this.store.db.update(schema.uploads).set({ messageId, conversationId }).where(inArray(schema.uploads.id, files.map(f => f.id))).run()
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
      } else if (conversationId !== this.mainConversation()) {
        // The main conversation is one long chat about many things (Muse): the router keeps it coherent, so there is
        // no shortcut to "the" open task there. A side chat is one topic, so its single open task gets the message.
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

  /**
   * 撤回: the owner takes back a message they sent in the last ten minutes. It disappears from the chat; the router (and
   * any task it went to) is told not to act on it.
   */
  recallMessage(messageId: string, opts: { edited?: boolean } = {}): void {
    const m = this.store.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
    if (!m || m.role !== 'user') throw new DomainError('missing', '只能撤回你自己发的消息')
    if ((m.meta as { recalled?: boolean }).recalled) throw new DomainError('conflict', '这条已经撤回了')
    if (this.now() - m.createdAt > 10 * 60_000) throw new DomainError('conflict', '超过 10 分钟的消息不能撤回')
    this.store.atomic(() => {
      this.store.db.update(schema.messages).set({ content: '', meta: { ...(m.meta as object), recalled: true, ...(opts.edited ? { edited: true } : {}) } }).where(eq(schema.messages.id, messageId)).run()
      if (m.triggerId) {
        const trigger = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.id, m.triggerId)).get()
        const delivered = ((trigger?.disposition ?? {}) as { deliveredTo?: string[] }).deliveredTo ?? []
        for (const id of delivered) {
          try { this.runtime.push(this.ticket(id).sessionId, { type: 'note', from: 'owner', text: '主人撤回了刚才那条消息，不要按它做。' }, { wake: true }) } catch { /* gone */ }
        }
        this.runtime.push(ROUTER_SESSION, { type: 'recalled', triggerId: m.triggerId, conversationId: m.conversationId, ...(opts.edited ? { edited: true } : {}) }, { wake: !opts.edited })
      }
      this.store.afterCommit(() => this.bus.emit({ type: 'message.updated', conversationId: m.conversationId, messageId }))
    })
  }

  /** 重新回答: the owner wants another answer to one of the assistant's messages; the old one is hidden. */
  regenerate(messageId: string): void {
    const m = this.store.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
    if (!m || m.role !== 'assistant') throw new DomainError('missing', '只能让它重新回答它自己的消息')
    this.store.atomic(() => {
      this.store.db.update(schema.messages).set({ meta: { ...(m.meta as object), superseded: true } }).where(eq(schema.messages.id, messageId)).run()
      this.runtime.push(ROUTER_SESSION, { type: 'regenerate', conversationId: m.conversationId, messageId, text: m.content }, { human: true })
      this.store.afterCommit(() => this.bus.emit({ type: 'message.updated', conversationId: m.conversationId, messageId }))
    })
  }

  // ── Router commands ────────────────────────────────────────────────────────

  /**
   * Posts the agent's message in a conversation. It also goes out through the source's channel (a GitHub comment) when it
   * answers a message from that source (`replyTo`) or reports on a task that came from it (`ticketId`); otherwise it stays in the web.
   */
  reply(input: { conversationId?: string; text: string; ticketId?: string; replyTo?: string; callId?: string; extra?: Record<string, unknown> }): string {
    const conversationId = input.conversationId ?? (input.ticketId ? this.conversationOfTicket(input.ticketId) : undefined)
    if (!conversationId) throw new DomainError('invalid', 'reply 需要 conversation_id 或 ticket_id')
    const conversation = this.store.db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get()
    if (!conversation) throw new DomainError('missing', `没有对话 ${conversationId}`)
    const id = newId('msg')
    const at = this.stamp()
    const via = this.replySource(input.replyTo, input.ticketId)
    const threadId = conversation.threadId
    const external = via !== 'webchat' && threadId && sourceOfThread(threadId) === via && this.opts.sources?.hasChannel(via)
    this.store.atomic(() => {
      const delivery = this.takeDelivery(conversation.threadId ?? webchatThread(conversationId), input.ticketId)
      this.store.db.insert(schema.messages).values({ id, conversationId, role: 'assistant', content: input.text,
        ticketId: input.ticketId ?? delivery?.ticketId ?? null,
        meta: { ...(input.extra ?? {}), ...(input.callId ? { callId: input.callId } : {}), ...(external ? { via, delivery: 'pending' } : {}), ...(delivery ? { result: delivery } : {}) }, createdAt: at }).run()
      this.store.db.update(schema.conversations).set({ updatedAt: at }).where(eq(schema.conversations.id, conversationId)).run()
      if (input.replyTo) this.setDisposition(input.replyTo, { answered: id })
      if (external) this.opts.sources!.send({ messageId: id, source: via, threadId: threadId!, text: input.text, ...(input.ticketId ? { ticketId: input.ticketId } : {}) })
    })
    this.bus.emit({ type: 'message.created', conversationId, messageId: id })
    return id
  }

  /** The conversation that shows a task; a silent task's thread gets its mirror conversation when it first has something to say. */
  conversationOfTicket(ticketId: string): string {
    const ticket = this.ticket(ticketId)
    // What the assistant noticed on its own is told in the main conversation, like a person mentioning it (Muse).
    if ((ticket.mandate as Mandate).strength === 'proactive') return this.mainConversation()
    const existing = this.conversationOfThread(ticket.threadId)
    if (existing) return existing
    const thread = this.store.db.select().from(schema.threads).where(eq(schema.threads.id, ticket.threadId)).get()
    const meta = (thread?.meta ?? {}) as { title?: string; url?: string }
    return this.mirrorConversation(ticket.threadId, { title: meta.title ?? ticket.title, ...(meta.url ? { url: meta.url } : {}), meta: thread?.meta as Record<string, unknown> ?? {} })
  }

  /**
   * The finished result an agent message carries, once: the task's last `ready` report and its files. Without an explicit
   * task, a message in the conversation picks up the one task that finished there in the last minutes and was not delivered.
   */
  private takeDelivery(threadId: string, ticketId?: string): Delivery | undefined {
    // A finished result, or partial work (blocked / failed) that already produced files.
    const deliverable = (t: Ticket) => Boolean(t.latestReport && (t.latestReport.status === 'ready' || (['blocked', 'failed'].includes(t.latestReport.status) && t.latestReport.files?.length)))
    const candidates = ticketId ? [this.ticket(ticketId)]
      : this.subscribers(threadId).filter(t => deliverable(t) && this.now() - t.latestReport!.at < 10 * 60_000)
    const fresh = candidates.filter(t => deliverable(t) && kvGet<number>(this.store, `ticket:delivered:${t.id}`) !== t.latestReport!.at)
    if (fresh.length !== 1) return undefined
    const t = fresh[0]!
    const report = t.latestReport!
    kvSet(this.store, `ticket:delivered:${t.id}`, report.at)
    const files = report.files?.length ? this.artifacts({ ticketId: t.id }).filter(a => report.files!.includes(a.path)) : []
    return { ticketId: t.id, title: t.title, summary: report.summary, files: files.map(f => ({ id: f.id, name: f.name, size: f.size })) }
  }

  // ── Deliverables ───────────────────────────────────────────────────────────

  artifacts(filter: { ticketId?: string; limit?: number } = {}) {
    const q = this.store.db.select().from(schema.artifacts)
    return (filter.ticketId ? q.where(eq(schema.artifacts.ticketId, filter.ticketId)) : q).orderBy(desc(schema.artifacts.createdAt)).limit(filter.limit ?? 500).all()
  }

  artifact(id: string) {
    const row = this.store.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)).get()
    if (!row) throw new DomainError('missing', `没有文件 ${id}`)
    const ticket = this.ticket(row.ticketId)
    return { ...row, absolute: join(ticket.directory, row.path) }
  }

  /** Registers files a worker delivers; paths must be files inside its working directory. Returns the accepted relative paths. */
  private registerFiles(ticket: Ticket, files: string[]): { accepted: string[]; rejected: string[] } {
    const accepted: string[] = []
    const rejected: string[] = []
    for (const f of files) {
      const abs = isAbsolute(f) ? resolve(f) : resolve(ticket.directory, f)
      const rel = relative(ticket.directory, abs)
      let size = -1
      try { const st = statSync(abs); if (st.isFile()) size = st.size } catch { /* missing */ }
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || size < 0) { rejected.push(f); continue }
      this.store.db.insert(schema.artifacts).values({ id: newId('art'), ticketId: ticket.id, path: rel, name: basename(rel), size, createdAt: this.now() })
        .onConflictDoUpdate({ target: [schema.artifacts.ticketId, schema.artifacts.path], set: { size, createdAt: this.now() } }).run()
      accepted.push(rel)
    }
    return { accepted, rejected }
  }

  /** The source a reply goes out through: the answered message's, or the task's origin (silent work stays in the web). */
  replySource(replyTo?: string, ticketId?: string): string {
    if (replyTo) {
      const t = this.store.db.select({ source: schema.triggers.source }).from(schema.triggers).where(eq(schema.triggers.id, replyTo)).get()
      if (t) return t.source
    }
    if (ticketId) {
      const ticket = this.store.db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
      if ((ticket?.mandate as Mandate | undefined)?.strength === 'proactive') return 'webchat'
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
      if (input.project) this.setProject(id, input.project)
      this.startAssignment(id, 'start')
      this.runtime.push(sessionId, { type: 'assignment', ticketId: id, reason: 'start' }, { human: true })
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

  /** The router decided an event needs nothing; the reason is kept so "why did nobody answer?" has an answer. */
  ignore(triggerIds: string[], reason: string): void {
    this.store.atomic(() => { for (const id of triggerIds) this.setDisposition(id, { ignored: 'router', reason }) })
  }

  /** Records the Slow Path's verdict on an unaddressed event; in auto mode the event goes on to the Router. */
  proactiveDecision(triggerId: string, verdict: FilterVerdict, mode: ProactiveMode | 'off'): void {
    this.store.atomic(() => {
      this.setDisposition(triggerId, { screening: false, proactive: { act: verdict.act, reason: verdict.reason, mode, at: this.now(), policy: proactiveSettings(this.store).version,
        ...(verdict.title ? { title: verdict.title } : {}), ...(verdict.goal ? { goal: verdict.goal } : {}) } })
      // As in the article's figure, an event that passes both filters is routed by the Router, which decides whether to
      // start silent work (start_silent_task) or leave it (ignore); it is not dispatched behind the Router's back.
      if (verdict.act && mode === 'auto') this.runtime.push(ROUTER_SESSION, { type: 'proactive', triggerId, reason: verdict.reason, title: verdict.title, goal: verdict.goal }, { wake: true })
    })
    this.bus.emit({ type: 'activity.updated' })
  }

  /**
   * A silent task the owner's strategy chose (speculative execution, article §3.4). It posts nothing and starts no
   * conversation; the router tells the owner only if the result is worth it.
   */
  startProactive(triggerId: string, input: { title: string; reason: string; goal?: string; byOwner?: boolean }): Ticket {
    const trigger = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    if (!trigger) throw new DomainError('missing', `没有 ${triggerId}`)
    const existing = this.tickets({ threadId: trigger.threadId }).find(t => t.origin.triggerIds.includes(triggerId))
    if (existing) return existing
    const settings = proactiveSettings(this.store)
    // Speculative work costs compute: a budget the owner sets, except when the owner asked for it from the activity page.
    if (!input.byOwner) {
      const silent = this.tickets().filter(t => (t.mandate as Mandate).strength === 'proactive')
      if (silent.filter(t => !t.ended).length >= settings.budget.concurrent) throw new DomainError('conflict', `已有 ${settings.budget.concurrent} 件静默工作在进行（主动预算上限）`)
      if (silent.filter(t => this.now() - t.createdAt < 86_400_000).length >= settings.budget.daily) throw new DomainError('conflict', `过去 24 小时已开始 ${settings.budget.daily} 件静默工作（主动预算上限）`)
    }
    const id = newId('tkt')
    const name = `auto-${id.slice(-6)}`
    const directory = join(this.workRoot, name)
    const sessionId = `ses_${id.slice(4)}`
    const at = this.now()
    const mandate: Mandate = { by: input.byOwner ? 'owner' : 'policy', strength: 'proactive', triggerIds: [triggerId], at, policy: settings.version,
      reason: input.goal ? `${input.reason}；目标：${input.goal}` : input.reason }
    this.store.atomic(() => {
      this.runtime.createSession('worker', 'worker', { id: sessionId, ticketId: id })
      this.store.db.insert(schema.tickets).values({ id, name, title: input.title.slice(0, 60), note: null, threadId: trigger.threadId,
        origin: { triggerIds: [triggerId] }, mandate: mandate as any, directory, sessionId, createdAt: at, updatedAt: at }).run()
      this.store.db.insert(schema.subscriptions).values({ ticketId: id, threadId: trigger.threadId, kind: 'own', createdAt: at }).onConflictDoNothing().run()
      this.setDisposition(triggerId, { startedTicket: id })
      this.startAssignment(id, 'start')
      this.runtime.push(sessionId, { type: 'assignment', ticketId: id, reason: 'start' })
    })
    mkdirSync(directory, { recursive: true })
    this.changed(id)
    return this.ticket(id)
  }

  /** Turning proactive work off withdraws the strategy's mandate: silent work still running stops (prototype: weakening a rule revokes acceptance). */
  revokeProactive(reason: string): string[] {
    const open = this.tickets({ open: true }).filter(t => (t.mandate as Mandate).strength === 'proactive' && (t.mandate as Mandate).by === 'policy')
    for (const t of open) this.stopTask(t.id, 'system', reason)
    return open.map(t => t.id)
  }

  /**
   * The owner's verdict on something done unasked. "Not useful" becomes a line in the strategy (in the owner's words),
   * so the filter learns what not to bother them with.
   */
  proactiveFeedback(triggerId: string, useful: boolean): void {
    const trigger = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    if (!trigger) throw new DomainError('missing', `没有 ${triggerId}`)
    const d = trigger.disposition as { proactive?: { title?: string; reason?: string } }
    if (!d.proactive) throw new DomainError('invalid', '这不是主动处理的事件')
    this.store.atomic(() => {
      this.setDisposition(triggerId, { feedback: { useful, at: this.now() } })
      if (!useful) {
        const cur = proactiveSettings(this.store)
        const what = d.proactive!.title || clip(trigger.text.replace(/\s+/g, ' '), 40)
        saveProactiveSettings(this.store, { strategy: `${cur.strategy}\n- 不用管这类事：「${what}」（${trigger.source}，你标记过没用）` }, 'owner')
      }
    })
    this.bus.emit({ type: 'activity.updated' })
  }

  /** How much the agent asked of the owner, and how its own initiative went (last 7 days). */
  attentionStats(days = 7) {
    const since = this.now() - days * 86_400_000
    const q = (sql: string, ...args: unknown[]) => (this.store.sqlite.prepare(sql).get(...args) as { n: number }).n
    return {
      days,
      approvals: q('SELECT count(*) n FROM approvals WHERE created_at > ?', since),
      questions: q("SELECT count(*) n FROM reports WHERE at > ? AND human_action IS NOT NULL", since),
      screened: q("SELECT count(*) n FROM triggers WHERE at > ? AND json_extract(disposition, '$.proactive') IS NOT NULL", since),
      picked: q("SELECT count(*) n FROM triggers WHERE at > ? AND json_extract(disposition, '$.proactive.act') = 1", since),
      silent: q("SELECT count(*) n FROM tickets WHERE created_at > ? AND json_extract(mandate, '$.strength') = 'proactive'", since),
      told: q(`SELECT count(DISTINCT m.ticket_id) n FROM messages m JOIN tickets t ON t.id = m.ticket_id
        WHERE m.created_at > ? AND m.role = 'assistant' AND json_extract(t.mandate, '$.strength') = 'proactive'`, since),
      useful: q("SELECT count(*) n FROM triggers WHERE at > ? AND json_extract(disposition, '$.feedback.useful') = 1", since),
      useless: q("SELECT count(*) n FROM triggers WHERE at > ? AND json_extract(disposition, '$.feedback.useful') = 0", since),
    }
  }

  /** Tokens and cost a task used, its subagents included. */
  usageOf(ticketId: string): { tokens: number; costUsd: number | null } {
    const r = this.store.sqlite.prepare('SELECT coalesce(sum(input_tokens + output_tokens), 0) tokens, sum(cost_usd) cost FROM usage_ledger WHERE ref = ?').get(ticketId) as { tokens: number; cost: number | null }
    return { tokens: r.tokens, costUsd: r.cost }
  }

  note(ticketId: string, text: string): void {
    const ticket = this.ticket(ticketId)
    if (ticket.ended) throw new DomainError('conflict', '任务已结束')
    this.store.atomic(() => this.runtime.push(ticket.sessionId, { type: 'note', text }))
  }

  // ── Worker facts ───────────────────────────────────────────────────────────

  report(ticketId: string, input: { status: ReportStatus; summary: string; humanAction?: HumanAction; files?: string[] }): { rejectedFiles: string[] } {
    const ticket = this.ticket(ticketId)
    if (ticket.ended && ticket.ended.by === 'person') return { rejectedFiles: [] }
    const at = this.now()
    const { accepted, rejected } = input.files?.length ? this.registerFiles(ticket, input.files) : { accepted: [], rejected: [] }
    const report: Report = { status: input.status, summary: input.summary, ...(input.humanAction ? { humanAction: input.humanAction } : {}), ...(accepted.length ? { files: accepted } : {}), at }
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
        humanAction: input.humanAction, ...(accepted.length ? { files: accepted } : {}) }, { wake: Boolean(relay) })
    })
    this.changed(ticketId)
    return { rejectedFiles: rejected }
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
    if (info.stepLimit) { this.report(ticketId, { status: 'blocked', summary: `达到单轮步数上限仍未完成。最后的说明：${clip(info.lastText, 800) || '（无）'}` }); return }
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
    if (role !== 'worker') return { type: 'recovery' }
    const ticket = this.store.db.select().from(schema.tickets).where(eq(schema.tickets.sessionId, sessionId)).get()
    if (ticket && !ticket.ended) this.startAssignment(ticket.id, 'restart')
    return { type: 'assignment', ticketId: ticket?.id, reason: 'restart' }
  }

  /** Recent events with what became of them, newest first (the activity log). */
  triggerLog(limit = 100) {
    return this.store.db.select().from(schema.triggers).orderBy(desc(schema.triggers.at)).limit(limit).all()
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
    this.store.afterCommit(() => {
      this.runtime.jobs.stopAll(ticket.sessionId)
      for (const child of this.runtime.children(ticket.sessionId)) { this.runtime.discardPending(child); this.runtime.cancel(child) }
    })
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
    // Compared after resolving symlinks: a link inside an allowed root must not lead the task outside it.
    const target = realish(resolve(requested.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')))
    const roots = this.execution().workspaceRoots.map(r => realish(resolve(r.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))))
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

/** The real path of `path`, or of its deepest existing ancestor joined with the rest (the directory may not exist yet). */
function realish(path: string): string {
  let existing = path
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
  try { return join(realpathSync(existing), relative(existing, path)) } catch { return path }
}

export const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text)
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
export type TicketRow = Row

/** A file the owner attached to a message (an uploads row). */
export interface Attachment { id: string; name: string; mime: string; size: number; path: string }

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
