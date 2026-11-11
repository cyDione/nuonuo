/**
 * AgentRuntime: persistent agent sessions with an inbox.
 *
 * - A session's history is an append-only event log in SQLite, so the compute is stateless and a restart resumes it.
 * - A turn runs one model step at a time. Between steps the runtime drains the inbox and appends what arrived (new
 *   messages, reports, finished background jobs) — that is how the router batches triggers and how a worker hears a
 *   person mid-task without waiting for its turn to end.
 * - Turns take slots: the router has its own; workers share `maxWorkers`, plus one slot kept for a person's message so new
 *   work never blocks a person from continuing existing work.
 */
import { newId, schema, type Store } from '@super-assistant/db'
import { describeError, type ModelHub, type RoleId } from '@super-assistant/models'
import { generateText, stepCountIs, streamText, type ModelMessage, type ToolSet } from 'ai'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { Blobs } from './blobs'
import type { Bus, SessionState, StreamPart } from './bus'
import { Jobs, type JobResult } from './jobs'

export interface SessionRecord {
  id: string
  role: string
  modelRole: RoleId
  ticketId: string | null
  state: SessionState
  meta: Record<string, unknown>
}

export interface InboxItem { id: number; payload: any; human: boolean; createdAt: number }

export interface TurnContext {
  session: SessionRecord
  signal: AbortSignal
  runtime: AgentRuntime
}

export interface AgentDefinition {
  role: string
  /** System prompt, rebuilt for every step so settings and live state are current. */
  system(session: SessionRecord): string
  tools(ctx: TurnContext): ToolSet
  /** Renders drained inbox items as the text of one user message. */
  formatInbox(items: InboxItem[], session: SessionRecord): string | Promise<string>
  /** Workers queue behind `maxWorkers`; the router never waits for a slot. */
  pool: 'router' | 'worker'
  maxSteps?: number
  onTurnEnd?(session: SessionRecord, info: TurnEndInfo): void
  onTurnError?(session: SessionRecord, error: unknown): void
}

export interface TurnEndInfo { steps: number; lastText: string; stepLimit: boolean; cancelled: boolean; runningJobs: number }

export interface RuntimeOptions {
  maxWorkers?: number
  /** Compact a session once a step's prompt exceeds this many tokens. */
  compactAtTokens?: number
  /** Messages kept verbatim at the end of a compacted history. */
  keepRecent?: number
  /**
   * A model step that streams nothing for this long (while no tool is running) is aborted as hung: a gateway that holds
   * the connection open would otherwise keep the session `running` forever, with every new input waiting behind it.
   */
  stepIdleMs?: number
}

/** A model step that went quiet for too long; retried like a dropped connection. */
export class StepTimeoutError extends Error {
  /** `toolsRan`: a tool already ran in this step, so running the step again could repeat it (not retried). */
  constructor(ms: number, readonly toolsRan = false) { super(`模型 ${Math.round(ms / 1000)} 秒没有响应`) }
}

/** A tool call that started but whose result was never recorded (the service stopped mid-step). */
export interface InterruptedCall { tool: string; input: string }

export class AgentRuntime {
  readonly blobs: Blobs
  readonly jobs: Jobs
  private defs = new Map<string, AgentDefinition>()
  private running = new Map<string, AbortController>()
  /** Consecutive failed turns per session, for the back-off before waking it again. */
  private failures = new Map<string, number>()
  private queue: { sessionId: string; human: boolean }[] = []
  private workerTurns = 0
  private stopped = false
  private idleWaiters: (() => void)[] = []
  private resolvers = new Map<string, (ref: string, page?: number) => string | undefined>()
  readonly options: Required<RuntimeOptions>

  constructor(private store: Store, private hub: ModelHub, readonly bus: Bus, options: RuntimeOptions = {}) {
    this.options = { maxWorkers: 3, compactAtTokens: 120_000, keepRecent: 12, stepIdleMs: 180_000, ...options }
    this.blobs = new Blobs(store)
    this.jobs = new Jobs(store, (sessionId, result, command) => this.jobFinished(sessionId, result, command))
    this.registerResolver('blob', (ref, page) => {
      const p = this.blobs.page(ref, page)
      return p ? `${ref} 第 ${p.page}/${p.pages} 页：\n${p.text}` : `${ref} 已不在了（较早的工具输出会按保留期清理）`
    })
  }

  register(def: AgentDefinition): void { this.defs.set(def.role, def) }

  /** Lets the domain answer `recall` for its own id prefixes (`tkt`, `trg`, `cnv`, ...). */
  registerResolver(prefix: string, resolve: (ref: string, page?: number) => string | undefined): void {
    this.resolvers.set(prefix, resolve)
  }

  recall(ref: string, page?: number): string {
    // Thread ids look like `github:owner/repo#12`; everything else is `prefix_…`.
    const prefix = /^[a-z]+:/.test(ref) ? 'thread' : ref.split('_')[0] ?? ''
    const resolver = this.resolvers.get(prefix)
    return resolver?.(ref, page) ?? `没有找到 ${ref}`
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  createSession(role: string, modelRole: RoleId, opts: { id?: string; ticketId?: string; meta?: Record<string, unknown> } = {}): string {
    const id = opts.id ?? newId('ses')
    const at = Date.now()
    this.store.db.insert(schema.sessions).values({ id, role, modelRole, ticketId: opts.ticketId ?? null, meta: opts.meta ?? {}, createdAt: at, updatedAt: at })
      .onConflictDoNothing().run()
    return id
  }

  session(id: string): SessionRecord | undefined {
    const row = this.store.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()
    return row && { id: row.id, role: row.role, modelRole: row.modelRole as RoleId, ticketId: row.ticketId, state: row.state as SessionState, meta: row.meta }
  }

  /** Sessions started by another session (a worker's subagents). */
  children(parentId: string): string[] {
    return this.store.sqlite.prepare(`SELECT id FROM sessions WHERE json_extract(meta, '$.parent') = ?`).all(parentId).map((r: any) => r.id as string)
  }

  /** Queues input for a session; it wakes after the surrounding transaction commits unless `wake` is false. */
  push(sessionId: string, payload: unknown, opts: { human?: boolean; wake?: boolean } = {}): void {
    this.store.db.insert(schema.sessionInbox).values({ sessionId, payload, human: Boolean(opts.human), wake: opts.wake !== false, createdAt: Date.now() }).run()
    if (opts.wake !== false) this.store.afterCommit(() => {
      // Full duplex: a person's message must not wait behind a long foreground command.
      if (opts.human && this.running.has(sessionId)) this.jobs.promote(sessionId)
      this.wake(sessionId, Boolean(opts.human))
    })
  }

  pending(sessionId: string): InboxItem[] {
    return this.store.db.select().from(schema.sessionInbox)
      .where(and(eq(schema.sessionInbox.sessionId, sessionId), isNull(schema.sessionInbox.takenAt))).orderBy(asc(schema.sessionInbox.id)).all()
      .map(r => ({ id: r.id, payload: r.payload, human: r.human, createdAt: r.createdAt }))
  }

  /** Drops inbox items not yet taken (for a session that is being stopped). */
  discardPending(sessionId: string): number {
    return this.store.db.update(schema.sessionInbox).set({ takenAt: -1 })
      .where(and(eq(schema.sessionInbox.sessionId, sessionId), isNull(schema.sessionInbox.takenAt))).run().changes
  }

  isRunning(sessionId: string): boolean { return this.running.has(sessionId) }

  /** Aborts the session's current turn, if any; background jobs are stopped too. */
  cancel(sessionId: string): void {
    this.running.get(sessionId)?.abort()
    this.queue = this.queue.filter(q => q.sessionId !== sessionId)
    this.jobs.stopAll(sessionId)
  }

  wake(sessionId: string, human = false): void {
    if (this.stopped || this.running.has(sessionId) || this.queue.some(q => q.sessionId === sessionId)) return
    const session = this.session(sessionId)
    if (!session) return
    const def = this.defs.get(session.role)
    if (!def) return
    const hasWakingInput = this.store.db.select({ n: sql<number>`count(*)` }).from(schema.sessionInbox)
      .where(and(eq(schema.sessionInbox.sessionId, sessionId), isNull(schema.sessionInbox.takenAt), eq(schema.sessionInbox.wake, true))).get()!.n > 0
    if (!hasWakingInput) return
    if (def.pool === 'router' || this.workerTurns < this.options.maxWorkers || (human && this.workerTurns < this.options.maxWorkers + 1)) {
      void this.runTurn(session, def)
    } else {
      // A person's message goes ahead of queued launches.
      if (human) this.queue.unshift({ sessionId, human }); else this.queue.push({ sessionId, human })
      this.setState(session, 'queued')
    }
  }

  /** Resolves once no turn is running and nothing waits for a slot (tests, shutdown). */
  idle(): Promise<void> {
    if (this.running.size === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    for (const controller of this.running.values()) controller.abort()
    await this.jobs.shutdown()
    const deadline = Date.now() + 10_000
    while (this.running.size > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  }

  /** At startup: sessions that were mid-turn get a recovery note; killed jobs are reported to their sessions. */
  recover(note: (session: SessionRecord) => unknown): void {
    const killed = this.jobs.recover()
    const interrupted = this.store.db.select().from(schema.sessions).where(sql`${schema.sessions.state} IN ('running','queued')`).all()
    this.store.atomic(() => {
      for (const row of interrupted) {
        this.store.db.update(schema.sessions).set({ state: 'idle' }).where(eq(schema.sessions.id, row.id)).run()
        const session = this.session(row.id)!
        this.push(row.id, note(session))
      }
      for (const job of killed) this.push(job.sessionId, { type: 'job', jobId: job.id, command: job.command, status: 'killed', output: '服务重启时被终止' }, { wake: false })
    })
    // Wake whatever has input waiting (including inputs queued before the restart).
    const waiting = this.store.db.selectDistinct({ id: schema.sessionInbox.sessionId }).from(schema.sessionInbox)
      .where(and(isNull(schema.sessionInbox.takenAt), eq(schema.sessionInbox.wake, true))).all()
    for (const { id } of waiting) this.wake(id)
  }

  // ── History ────────────────────────────────────────────────────────────────

  /** The messages sent to the model: a compaction summary (if any) followed by the events after it. */
  history(sessionId: string): ModelMessage[] {
    const compaction = this.store.db.select().from(schema.sessionEvents)
      .where(and(eq(schema.sessionEvents.sessionId, sessionId), eq(schema.sessionEvents.kind, 'compaction')))
      .orderBy(sql`${schema.sessionEvents.id} DESC`).limit(1).get()
    const after = compaction ? (compaction.payload.upTo as number) : 0
    const rows = this.store.db.select().from(schema.sessionEvents)
      .where(and(eq(schema.sessionEvents.sessionId, sessionId), eq(schema.sessionEvents.kind, 'message'), gt(schema.sessionEvents.id, after)))
      .orderBy(asc(schema.sessionEvents.id)).all()
    const messages = rows.map(r => r.payload as ModelMessage)
    if (compaction) messages.unshift({ role: 'user', content: `<compacted_history>\n以下是此前对话的压缩摘要：\n${compaction.payload.summary}\n</compacted_history>` })
    return messages
  }

  /** Every event of a session, for the transcript view. */
  events(sessionId: string, afterId = 0): { id: number; kind: string; payload: any; at: number }[] {
    return this.store.db.select().from(schema.sessionEvents)
      .where(and(eq(schema.sessionEvents.sessionId, sessionId), gt(schema.sessionEvents.id, afterId))).orderBy(asc(schema.sessionEvents.id)).all()
  }

  appendEvent(sessionId: string, kind: 'message' | 'marker' | 'compaction', payload: unknown): number {
    return Number(this.store.db.insert(schema.sessionEvents).values({ sessionId, kind, payload, at: Date.now() }).run().lastInsertRowid)
  }

  // ── Turns ──────────────────────────────────────────────────────────────────

  private async runTurn(session: SessionRecord, def: AgentDefinition): Promise<void> {
    const controller = new AbortController()
    this.running.set(session.id, controller)
    if (def.pool === 'worker') this.workerTurns++
    this.setState(session, 'running')
    let steps = 0
    let lastText = ''
    let stepLimit = false
    let failed = false
    try {
      const maxSteps = def.maxSteps ?? 100
      for (;;) {
        if (controller.signal.aborted) break
        const items = this.pending(session.id)
        if (items.length) {
          // Rendered first, then taken and written to the history in one transaction: an input is either still in the
          // inbox or in the history, never lost between them (a crash, or a render that throws, leaves it queued).
          const interrupted = steps === 0 ? this.interruptedCalls(session.id) : []
          const body = await def.formatInbox(items, session)
          // The current time rides on the new input, not the system prompt: a clock in the system prompt changes the
          // prompt prefix on every step and defeats the provider's prompt cache.
          const content = `${body}${interrupted.length ? `\n\n${renderInterrupted(interrupted)}` : ''}\n<now>${new Date().toString()}</now>`
          this.store.atomic(() => {
            this.markTaken(session.id, items.at(-1)!.id)
            this.appendEvent(session.id, 'message', { role: 'user', content })
          })
          this.emit(session, { type: 'session.message' })
        } else if (steps === 0) break
        if (steps >= maxSteps) { stepLimit = true; break }
        const step = await this.stepWithRetry(session, def, controller.signal)
        steps++
        if (step.text) lastText = step.text
        if (step.inputTokens > this.options.compactAtTokens) await this.compact(session).catch(() => { /* retried next step */ })
        if (step.finishReason === 'tool-calls' && !controller.signal.aborted) continue
        if (this.pending(session.id).length > 0 && !controller.signal.aborted) continue
        break
      }
      const cancelled = controller.signal.aborted
      if (stepLimit) this.appendEvent(session.id, 'marker', { type: 'step-limit', steps })
      this.setState(session, 'idle')
      def.onTurnEnd?.(this.session(session.id) ?? session, { steps, lastText, stepLimit, cancelled, runningJobs: this.jobs.running(session.id).length })
    } catch (error) {
      if (controller.signal.aborted) {
        this.setState(session, 'idle')
        def.onTurnEnd?.(this.session(session.id) ?? session, { steps, lastText, stepLimit, cancelled: true, runningJobs: 0 })
      } else {
        failed = true
        this.appendEvent(session.id, 'marker', { type: 'error', message: describeError(error) })
        this.setState(session, 'error')
        this.emit(session, { type: 'session.part', part: { kind: 'error', message: describeError(error) } })
        def.onTurnError?.(this.session(session.id) ?? session, error)
      }
    } finally {
      this.running.delete(session.id)
      if (def.pool === 'worker') this.workerTurns--
      this.next()
      // Input that arrived after the last check (e.g. while onTurnEnd ran) starts a new turn. After a failed turn it
      // waits, longer each time, so an input that keeps failing (a render that throws) cannot spin.
      const failures = failed ? (this.failures.get(session.id) ?? 0) + 1 : 0
      if (failures) this.failures.set(session.id, failures); else this.failures.delete(session.id)
      if (!this.stopped && !failed) this.wake(session.id)
      else if (!this.stopped) setTimeout(() => this.wake(session.id), Math.min(5_000 * 2 ** (failures - 1), 300_000)).unref?.()
      if (this.running.size === 0 && this.queue.length === 0) for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }

  /**
   * A step whose response broke off mid-stream (a gateway hiccup: "Failed to process successful response", a reset
   * connection) is retried: nothing of it was recorded yet, so running it again is safe.
   */
  private async stepWithRetry(session: SessionRecord, def: AgentDefinition, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.step(session, def, signal) } catch (error) {
        if (signal.aborted || attempt >= 2 || !transient(error)) throw error
        this.appendEvent(session.id, 'marker', { type: 'retry', message: describeError(error), attempt: attempt + 1 })
        await new Promise(r => setTimeout(r, 1_500 * (attempt + 1)))
      }
    }
  }

  private async step(session: SessionRecord, def: AgentDefinition, signal: AbortSignal) {
    // The step's own abort: the turn's (cancel, shutdown) or the idle timer's (a hung model call).
    const stepAbort = new AbortController()
    const onTurnAbort = () => stepAbort.abort(signal.reason)
    signal.addEventListener('abort', onTurnAbort, { once: true })
    let toolsRunning = 0
    let toolsStarted = 0
    let idle: NodeJS.Timeout | undefined
    let timedOut = false
    const arm = () => {
      clearTimeout(idle)
      if (toolsRunning > 0) return
      idle = setTimeout(() => { timedOut = true; stepAbort.abort(new StepTimeoutError(this.options.stepIdleMs)) }, this.options.stepIdleMs)
    }
    const ctx: TurnContext = { session, signal, runtime: this }
    const tools = this.trackTools(session.id, def.tools(ctx), {
      start: () => { toolsRunning++; toolsStarted++; clearTimeout(idle) },
      end: () => { toolsRunning--; arm() },
    })
    arm()
    try {
      return await this.streamStep(session, def, tools, stepAbort.signal, arm)
    } catch (error) {
      if (timedOut && !signal.aborted) throw new StepTimeoutError(this.options.stepIdleMs, toolsStarted > 0)
      throw error
    } finally {
      clearTimeout(idle)
      signal.removeEventListener('abort', onTurnAbort)
    }
  }

  /**
   * Each tool call leaves a `tool-start` marker before it runs and a `tool-end` after. The step's messages are written
   * only when the step finishes, so after a crash these markers are the only record that a call (a command, a post)
   * already happened; the next input says so, and the agent checks instead of doing it twice.
   */
  private trackTools(sessionId: string, tools: ToolSet, hooks: { start: () => void; end: () => void }): ToolSet {
    const out: ToolSet = {}
    for (const [name, t] of Object.entries(tools)) {
      const run = t.execute
      out[name] = !run ? t : {
        ...t,
        execute: async (input: any, options: any) => {
          const marker = this.appendEvent(sessionId, 'marker', { type: 'tool-start', tool: name, callId: options?.toolCallId, input: clipJson(input, 300) })
          hooks.start()
          try { return await run(input, options) } finally {
            hooks.end()
            this.appendEvent(sessionId, 'marker', { type: 'tool-end', start: marker })
          }
        },
      } as typeof t
    }
    return out
  }

  /** Calls that started after the session's last recorded message and never ended: interrupted by a stop of the service. */
  interruptedCalls(sessionId: string): InterruptedCall[] {
    const lastMessage = (this.store.sqlite.prepare(`SELECT max(id) AS id FROM session_events WHERE session_id = ? AND kind = 'message'`).get(sessionId) as { id: number | null }).id ?? 0
    const markers = this.store.db.select().from(schema.sessionEvents)
      .where(and(eq(schema.sessionEvents.sessionId, sessionId), eq(schema.sessionEvents.kind, 'marker'), gt(schema.sessionEvents.id, lastMessage))).orderBy(asc(schema.sessionEvents.id)).all()
    const ended = new Set(markers.filter(m => m.payload?.type === 'tool-end').map(m => m.payload.start as number))
    return markers.filter(m => m.payload?.type === 'tool-start' && !ended.has(m.id)).map(m => ({ tool: String(m.payload.tool), input: String(m.payload.input ?? '') }))
  }

  private async streamStep(session: SessionRecord, def: AgentDefinition, tools: ToolSet, signal: AbortSignal, onActivity: () => void) {
    const result = streamText({
      model: this.hub.model(session.modelRole, { ref: session.ticketId ?? session.id }),
      system: def.system(session),
      messages: this.history(session.id),
      tools,
      stopWhen: stepCountIs(1),
      abortSignal: signal,
      maxRetries: 2,
      // Anthropic caches only where asked; this request-level breakpoint caches the prefix up to the last block.
      // Other providers cache prefixes on their own and ignore this option.
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    })
    this.emit(session, { type: 'session.part', part: { kind: 'step-start' } })
    let text = ''
    let streamError: unknown
    for await (const part of result.fullStream) {
      onActivity()
      const mapped = toPart(part)
      if (mapped) this.emit(session, { type: 'session.part', part: mapped })
      if (part.type === 'text-delta') text += part.text
      if (part.type === 'error') streamError = part.error
    }
    if (streamError) throw streamError
    const messages = await result.responseMessages
    this.store.atomic(() => { for (const m of messages) this.appendEvent(session.id, 'message', m) })
    this.emit(session, { type: 'session.message' })
    const usage = await result.totalUsage
    return { finishReason: await result.finishReason, text, inputTokens: usage.inputTokens ?? 0 }
  }

  /** Summarizes all but the most recent messages with the summarizer layer; cut points fall on user messages so tool calls stay paired. */
  async compact(session: SessionRecord): Promise<boolean> {
    const rows = this.store.db.select().from(schema.sessionEvents)
      .where(and(eq(schema.sessionEvents.sessionId, session.id), eq(schema.sessionEvents.kind, 'message'))).orderBy(asc(schema.sessionEvents.id)).all()
    const last = this.store.db.select().from(schema.sessionEvents)
      .where(and(eq(schema.sessionEvents.sessionId, session.id), eq(schema.sessionEvents.kind, 'compaction'))).orderBy(sql`${schema.sessionEvents.id} DESC`).limit(1).get()
    const live = rows.filter(r => r.id > ((last?.payload.upTo as number) ?? 0))
    let cut = live.length - this.options.keepRecent
    while (cut > 0 && (live[cut]!.payload as ModelMessage).role !== 'user') cut--
    if (cut <= 0) return false
    const older = live.slice(0, cut)
    const transcript = older.map(r => renderForSummary(r.payload as ModelMessage)).join('\n\n').slice(-400_000)
    const previous = last ? `此前的摘要：\n${last.payload.summary}\n\n` : ''
    const { text } = await generateText({
      model: this.hub.model('summarizer', { ref: session.ticketId ?? session.id }),
      prompt: `${previous}请把下面这段 Agent 会话压缩成一份供它自己继续工作的摘要（中文，保留：目标、已做的决定与原因、已完成的步骤与结果、关键文件路径/ID/命令、未完成事项与下一步、用户的明确要求与禁忌）。不要编造。\n\n${transcript}`,
      maxOutputTokens: 4_000,
    })
    this.appendEvent(session.id, 'compaction', { summary: text, upTo: older.at(-1)!.id })
    return true
  }

  /** Marks the session's inbox items up to `lastId` as taken (items discarded meanwhile stay discarded). */
  private markTaken(sessionId: string, lastId: number): void {
    this.store.db.update(schema.sessionInbox).set({ takenAt: Date.now() })
      .where(and(eq(schema.sessionInbox.sessionId, sessionId), isNull(schema.sessionInbox.takenAt), sql`${schema.sessionInbox.id} <= ${lastId}`)).run()
  }

  /** When the session last recorded anything (a message or a marker); undefined for a new session. */
  lastActivity(sessionId: string): number | undefined {
    return (this.store.sqlite.prepare('SELECT max(at) AS at FROM session_events WHERE session_id = ?').get(sessionId) as { at: number | null }).at ?? undefined
  }

  /** The oldest input still waiting in the session's inbox that would wake it. */
  oldestWaiting(sessionId: string): number | undefined {
    return (this.store.sqlite.prepare('SELECT min(created_at) AS at FROM session_inbox WHERE session_id = ? AND taken_at IS NULL AND wake = 1').get(sessionId) as { at: number | null }).at ?? undefined
  }

  private next(): void {
    while (this.queue.length && !this.stopped) {
      const head = this.queue[0]!
      const free = this.workerTurns < this.options.maxWorkers || (head.human && this.workerTurns < this.options.maxWorkers + 1)
      if (!free) return
      this.queue.shift()
      const session = this.session(head.sessionId)
      const def = session && this.defs.get(session.role)
      if (session && def) void this.runTurn(session, def)
    }
  }

  private jobFinished(sessionId: string, result: JobResult, command: string): void {
    this.store.atomic(() => this.push(sessionId, { type: 'job', jobId: result.jobId, command, status: result.status, exitCode: result.exitCode,
      output: this.blobs.spill('job-output', result.output), durationMs: result.durationMs }))
  }

  private setState(session: SessionRecord, state: SessionState) {
    // A turn cut off by shutdown stays `running` on disk, so the next start recovers it with a note.
    if (this.stopped && state === 'idle') return
    this.store.db.update(schema.sessions).set({ state, updatedAt: Date.now() }).where(eq(schema.sessions.id, session.id)).run()
    this.emit(session, { type: 'session.state', state })
  }

  private emit(session: SessionRecord, event: { type: 'session.state'; state: SessionState } | { type: 'session.part'; part: StreamPart } | { type: 'session.message' }) {
    this.bus.emit({ ...event, sessionId: session.id, role: session.role, ticketId: session.ticketId } as any)
  }
}

function toPart(part: any): StreamPart | undefined {
  switch (part.type) {
    case 'text-delta': return { kind: 'text', delta: part.text }
    case 'reasoning-delta': return { kind: 'reasoning', delta: part.text }
    case 'tool-input-start': return { kind: 'tool-input-start', id: part.id, tool: part.toolName }
    case 'tool-input-delta': return { kind: 'tool-input-delta', id: part.id, delta: part.delta }
    case 'tool-call': return { kind: 'tool-call', id: part.toolCallId, tool: part.toolName, input: part.input }
    case 'tool-result': return { kind: 'tool-result', id: part.toolCallId, tool: part.toolName, output: part.output }
    case 'tool-error': return { kind: 'tool-result', id: part.toolCallId, tool: part.toolName, output: { error: describeError(part.error) } }
    default: return undefined
  }
}

function renderForSummary(m: ModelMessage): string {
  const content = typeof m.content === 'string' ? m.content : m.content.map((p: any) => {
    if (p.type === 'text') return p.text
    if (p.type === 'tool-call') return `[调用 ${p.toolName} ${JSON.stringify(p.input).slice(0, 600)}]`
    if (p.type === 'tool-result') return `[结果 ${p.toolName}: ${JSON.stringify(p.output).slice(0, 1200)}]`
    return ''
  }).filter(Boolean).join('\n')
  return `${m.role}: ${content}`
}

function clipJson(value: unknown, n: number): string {
  let text = ''
  try { text = JSON.stringify(value) ?? '' } catch { text = String(value) }
  return text.length > n ? `${text.slice(0, n)}…` : text
}

function renderInterrupted(calls: InterruptedCall[]): string {
  return `<interrupted_calls>服务在下面这些工具调用执行期间停止了，它们可能已经生效（命令跑完、内容已发出），但结果没有记下来。先检查实际情况，不要直接再做一遍：\n${calls.map(c => `- ${c.tool} ${c.input}`).join('\n')}\n</interrupted_calls>`
}

/** Errors worth one more try: the response broke off, the connection dropped, or the model went quiet. */
export function transient(error: unknown): boolean {
  if (error instanceof StepTimeoutError) return !error.toolsRan
  const text = `${describeError(error)} ${(error as { cause?: unknown })?.cause ?? ''}`
  return /Failed to process successful response|ECONNRESET|socket hang up|terminated|other side closed|fetch failed|ETIMEDOUT|EPIPE|premature close/i.test(text)
}

/** Today's date and time zone for system prompts: stable all day, so the prompt prefix stays cacheable. */
export function today(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} (${zone}); each new input ends with <now> giving the exact time`
}
