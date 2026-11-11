/**
 * Watchdog: an outside control loop (article §6). Deterministic probes run every minute without tokens; when one fires,
 * the watchdog agent reads the task's recent transcript and decides: nudge the worker, restart it, tell the owner, or let it be.
 * The owner can also talk to it in its own conversation ("为什么 tkt_x 卡住了？").
 */
import { recallTool, today, type AgentDefinition, type AgentRuntime, type InboxItem } from '@nuonuo/agent-runtime'
import { kvGet, kvSet, schema, type Store } from '@nuonuo/db'
import { tool, type ToolSet } from 'ai'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { clip, ROUTER_SESSION, type Engine } from './engine'
import type { Ticket } from './model'

export const WATCHDOG_SESSION = 'ses_watchdog'

export type FindingKind = 'stuck' | 'loop' | 'many_steps' | 'stalled' | 'expensive' | 'system'
export interface Finding { kind: FindingKind; ticketId?: string; detail: string }

export interface WatchdogOptions {
  /** A running turn with no new event for this long is stuck (a hung model call or tool). */
  stuckMs: number
  /** A turn with more model steps than this since its last input is suspicious. */
  maxStepsPerTurn: number
  /** The same tool call this many times in a row is a loop. */
  repeats: number
  /** A task that reported progress, then went quiet with nothing running, for this long has stalled. */
  stalledMs: number
  /** A task whose model calls used more tokens than this (input + output, subagents included) gets a look. */
  maxTokensPerTask: number
  /** A finding is not raised again for the same task within this window. */
  quietMs: number
  /** Input waiting this long while the main agent sits idle wakes it again. */
  wakeAfterMs: number
  /** System problems from outside the domain (failing queues, sources). */
  systemProblems?: () => string[]
  /** Tools that let the watchdog correct the system online (edit instructions, the proactive strategy). */
  correctionTools?: () => ToolSet
  now?: () => number
}

const DEFAULTS: WatchdogOptions = { stuckMs: 10 * 60_000, maxStepsPerTurn: 60, repeats: 4, stalledMs: 30 * 60_000, maxTokensPerTask: 3_000_000, quietMs: 30 * 60_000, wakeAfterMs: 2 * 60_000 }

const WATCHDOG_PROMPT = `You are the watchdog of the owner's personal Nuonuo: an outside observer of the main agent and its task workers.
You receive findings from deterministic probes (a stuck turn, a loop of identical tool calls, a very long turn, a task that has used a lot of tokens, a task that said it would continue but nothing will wake it, failing system parts), with the task's recent transcript. Judge whether the task is actually making progress toward its goal.
Act with the lightest effective step:
- nothing: the probe misfired (for example a long but productive build) — say so in one line, no tool needed;
- nudge_task: tell the worker what you observe and what to do differently (stop repeating X, report what blocks it, check Y);
- restart_task: the turn is hung or hopelessly confused — restart it from its working directory;
- notify_owner: only when the owner must act or should know (a task cannot progress without them, a system part is broken). One or two sentences, in Chinese.
When the same kind of mistake keeps recurring (not a one-off), you may correct the system online: update_instructions (how the agent talks, what it may do, what a result must include) or update_proactive (what is worth acting on unasked). Change little, say why, and tell the owner what you changed with notify_owner.
You never stop tasks and never do the work yourself. When the owner writes to you, answer with notify_owner, using recall and list_tasks to look things up.`

export class Watchdog {
  readonly options: WatchdogOptions
  constructor(private store: Store, private runtime: AgentRuntime, private engine: Engine, options: Partial<WatchdogOptions> = {}) {
    this.options = { ...DEFAULTS, ...options }
  }
  private now() { return this.options.now?.() ?? Date.now() }

  /** Runs every probe; returns the findings (deduplicated within the quiet window). */
  probe(): Finding[] {
    const findings: Finding[] = []
    const now = this.now()
    for (const ticket of this.engine.tickets({ open: true })) {
      const session = this.runtime.session(ticket.sessionId)
      const events = this.store.db.select().from(schema.sessionEvents).where(eq(schema.sessionEvents.sessionId, ticket.sessionId))
        .orderBy(desc(schema.sessionEvents.id)).limit(200).all()
      const last = events[0]
      if (session?.state === 'running' && last && now - last.at > this.options.stuckMs) {
        findings.push({ kind: 'stuck', ticketId: ticket.id, detail: `本轮已经 ${Math.round((now - last.at) / 60_000)} 分钟没有任何新事件` })
      }
      // Calls since the last input, newest first.
      const sinceInput: { name: string; input: string }[] = []
      let steps = 0
      for (const e of events) {
        if (e.kind !== 'message') continue
        if (e.payload.role === 'user') break
        if (e.payload.role === 'assistant') {
          steps++
          for (const part of Array.isArray(e.payload.content) ? e.payload.content : []) {
            if (part.type === 'tool-call') sinceInput.push({ name: part.toolName, input: JSON.stringify(part.input) })
          }
        }
      }
      const head = sinceInput[0]
      if (head && sinceInput.length >= this.options.repeats && sinceInput.slice(0, this.options.repeats).every(c => c.name === head.name && c.input === head.input)) {
        findings.push({ kind: 'loop', ticketId: ticket.id, detail: `连续 ${this.options.repeats} 次相同调用：${head.name} ${clip(head.input, 160)}` })
      } else if (steps > this.options.maxStepsPerTurn) {
        findings.push({ kind: 'many_steps', ticketId: ticket.id, detail: `自上次输入以来已经 ${steps} 步` })
      }
      const { tokens } = this.engine.usageOf(ticket.id)
      if (tokens > this.options.maxTokensPerTask) {
        findings.push({ kind: 'expensive', ticketId: ticket.id, detail: `已经用了 ${(tokens / 1e6).toFixed(1)}M tokens（阈值 ${(this.options.maxTokensPerTask / 1e6).toFixed(1)}M）` })
      }
      const report = ticket.latestReport
      if (report?.status === 'progress' && session?.state === 'idle' && now - report.at > this.options.stalledMs
        && this.runtime.jobs.running(ticket.sessionId).length === 0 && this.runtime.pending(ticket.sessionId).length === 0) {
        findings.push({ kind: 'stalled', ticketId: ticket.id, detail: `汇报「继续中」后 ${Math.round((now - report.at) / 60_000)} 分钟没有动静，也没有在运行的命令` })
      }
    }
    for (const problem of this.options.systemProblems?.() ?? []) findings.push({ kind: 'system', detail: problem })
    return findings.filter(f => this.fresh(f, now))
  }

  /**
   * The main agent is the single point every request passes, so it is watched without a model: a turn that recorded
   * nothing for `stuckMs` is cut and retried; input waiting while it sits idle (a lost wake-up) wakes it. Returns what
   * it did, for the findings.
   */
  healRouter(): string | undefined {
    const now = this.now()
    const session = this.runtime.session(ROUTER_SESSION)
    if (!session) return undefined
    if (this.runtime.isRunning(ROUTER_SESSION)) {
      const last = this.runtime.lastActivity(ROUTER_SESSION)
      if (last === undefined || now - last < this.options.stuckMs) return undefined
      const minutes = Math.round((now - last) / 60_000)
      this.runtime.cancel(ROUTER_SESSION)
      this.store.atomic(() => this.runtime.push(ROUTER_SESSION, { type: 'retry', error: `这一轮 ${minutes} 分钟没有进展，被 Watchdog 中断` }))
      return `主 Agent 的一轮 ${minutes} 分钟没有任何进展，已中断并重试`
    }
    const waiting = this.runtime.oldestWaiting(ROUTER_SESSION)
    if (waiting !== undefined && now - waiting > this.options.wakeAfterMs) {
      this.runtime.wake(ROUTER_SESSION, true)
      return now - waiting > this.options.stuckMs ? `主 Agent 有 ${Math.round((now - waiting) / 60_000)} 分钟前的消息还没处理，已重新唤醒` : undefined
    }
    return undefined
  }

  /** Probes and hands the findings to the watchdog agent. `healed`: the result of a `healRouter` the caller already ran (null: nothing). */
  tick(healed: string | null | undefined = this.healRouter()): Finding[] {
    const findings = this.probe()
    if (healed && this.fresh({ kind: 'system', detail: healed }, this.now())) findings.push({ kind: 'system', detail: healed })
    if (findings.length) this.store.atomic(() => { for (const f of findings) this.runtime.push(WATCHDOG_SESSION, { type: 'finding', ...f }) })
    return findings
  }

  private fresh(f: Finding, now: number): boolean {
    const key = `watchdog:seen:${f.kind}:${f.ticketId ?? f.detail.slice(0, 80)}`
    const seen = kvGet<number>(this.store, key)
    if (seen && now - seen < this.options.quietMs) return false
    kvSet(this.store, key, now)
    return true
  }

  /** The conversation where the watchdog talks with the owner (created on first use). */
  conversation(): string {
    const existing = this.store.db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.source, 'watchdog')).get()
    if (existing) return existing.id
    return this.engine.openConversation('🛡 Watchdog', { source: 'watchdog' })
  }

  register(): void {
    this.runtime.createSession('watchdog', 'watchdog', { id: WATCHDOG_SESSION })
    const describe = (ticket: Ticket) => {
      const events = this.store.db.select().from(schema.sessionEvents).where(eq(schema.sessionEvents.sessionId, ticket.sessionId))
        .orderBy(desc(schema.sessionEvents.id)).limit(14).all().reverse()
      const lines = events.map(e => {
        if (e.kind !== 'message') return `[${e.kind}] ${clip(JSON.stringify(e.payload), 200)}`
        const m = e.payload
        if (typeof m.content === 'string') return `${m.role}: ${clip(m.content, 400)}`
        return m.content.map((p: any) => p.type === 'tool-call' ? `${m.role} → ${p.toolName}(${clip(JSON.stringify(p.input), 200)})`
          : p.type === 'tool-result' ? `  ↳ ${clip(JSON.stringify(p.output), 300)}` : p.type === 'text' ? `${m.role}: ${clip(p.text, 300)}` : '').filter(Boolean).join('\n')
      })
      return `${this.engine.describeTicket(ticket)}\nrecent transcript (oldest first):\n${lines.join('\n')}`
    }
    const def: AgentDefinition = {
      role: 'watchdog',
      pool: 'router',
      maxSteps: 12,
      system: () => `${WATCHDOG_PROMPT}\n\nToday: ${today()}`,
      formatInbox: (items: InboxItem[]) => items.map(({ payload: p }) => {
        if (p.type === 'finding') {
          let body = ''
          if (p.ticketId) { try { body = describe(this.engine.ticket(p.ticketId)) } catch { body = '（任务已删除）' } }
          return `<finding kind="${p.kind}"${p.ticketId ? ` ticket_id="${p.ticketId}"` : ''}>\n${p.detail}\n${body}\n</finding>`
        }
        if (p.type === 'owner') return `<owner_message>\n${p.text}\n</owner_message>`
        if (p.type === 'recovery') return '<recovery>服务刚重启。</recovery>'
        return `<event>${JSON.stringify(p)}</event>`
      }).join('\n\n'),
      tools: () => ({
        nudge_task: tool({
          description: 'Send the worker of a task a note about what you observe and what to change. Wakes it.',
          inputSchema: z.object({ ticket_id: z.string(), text: z.string().min(1).max(800) }),
          execute: async ({ ticket_id, text }) => {
            const t = this.engine.ticket(ticket_id)
            if (t.ended) throw new Error('任务已结束')
            this.store.atomic(() => this.runtime.push(t.sessionId, { type: 'note', from: 'watchdog', text }))
            return { ok: true }
          },
        }),
        restart_task: tool({
          description: 'Cancel a task\'s current turn and start it again from its working directory (for a hung or hopelessly confused turn).',
          inputSchema: z.object({ ticket_id: z.string(), reason: z.string() }),
          execute: async ({ ticket_id, reason }) => {
            const t = this.engine.ticket(ticket_id)
            if (t.ended) throw new Error('任务已结束')
            this.runtime.cancel(t.sessionId)
            await new Promise(r => setTimeout(r, 200))
            this.engine.restart(ticket_id, `watchdog: ${reason}`)
            return { ok: true }
          },
        }),
        notify_owner: tool({
          description: 'Post a message to the owner in the watchdog conversation.',
          inputSchema: z.object({ text: z.string().min(1), ticket_id: z.string().optional() }),
          execute: async ({ text, ticket_id }, { toolCallId }) => ({ ok: true, message_id: this.engine.reply({ conversationId: this.conversation(), text, callId: toolCallId, ...(ticket_id ? { ticketId: ticket_id } : {}) }) }),
        }),
        list_tasks: tool({
          description: 'List open tasks with their stage.',
          inputSchema: z.object({}),
          execute: async () => this.engine.tickets({ open: true }).map(t => `${t.id} "${t.title}" ${this.engine.stage(t)}`).join('\n') || '（没有进行中的任务）',
        }),
        ...recallTool(this.runtime),
        ...(this.options.correctionTools?.() ?? {}),
      }),
    }
    this.runtime.register(def)
  }
}
