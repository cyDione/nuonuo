/** The router and worker agent definitions: tool sets (enforced by code, not prompt) and how their inbox items read. */
import { fsTools, recallTool, type FsAccess, shellTools, today, webTools, workerEnv, type AgentDefinition, type AgentRuntime, type BrowserManager, type InboxItem, type McpManager, type TurnContext } from '@super-assistant/agent-runtime'
import { schema, type Store } from '@super-assistant/db'
import { tool, type ToolSet } from 'ai'
import { asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { clip, DomainError, Engine, ROUTER_SESSION } from './engine'
import { sourceOfThread, STAGE_LABEL, type Mandate, type Ticket } from './model'
import { PROACTIVE_WORKER_PROMPT, ROUTER_PROMPT, SUBAGENT_PROMPT, WORKER_PROMPT } from './prompts'
import type { LocalAccess } from './access'
import { gateSourceTools, type LocalApps } from './localapps'
import type { Instructions } from './instructions'
import { proactiveSettings, saveProactiveSettings } from './proactive'
import type { Memory, MemoryTrust } from './memory'
import { sandboxApplies, sandboxCommand } from './sandbox'
import type { Reviewer } from './review'

const CONTEXT_MESSAGES = 6
/** Chat channels keep replies short (article §4.2: ≤ 100 words); the full result stays in the work's details. */
const CHAT_SOURCES = new Set(['webchat', 'telegram', 'watchdog', 'cron'])
const CHAT_LIMIT = 120
const DETAILED_LIMIT = 600
const MAX_SUBAGENTS = 4
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g

/** Roughly words: Latin words plus CJK characters at ~1.6 per word. */
export function chatLength(text: string): number {
  const cjk = (text.match(CJK) ?? []).length
  const words = text.replace(CJK, ' ').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length
  return Math.ceil(cjk / 1.6) + words
}

const isProactive = (t: Ticket) => (t.mandate as Mandate).strength === 'proactive'

/** What source plugins and routines add to the agents. */
export interface AgentExtensions {
  routerTools?(): ToolSet
  /** Extra router prompt text (for example, how routines work). */
  routerPrompt?(): string
  workerTools?(ticket: Ticket, ctx: TurnContext): ToolSet
  /** Prompt sections for a worker whose task touches a source (e.g. how to use GitHub). */
  workerPrompt?(ticket: Ticket): string | undefined
  workerEnv?(ticket: Ticket): Record<string, string>
  /** One line describing an external thread for cards (repo, number, state, url). */
  threadInfo?(threadId: string): string | undefined
  /** Review of a worker's shell command (the Reviewer). */
  gateShell?(ticket: Ticket, sessionId: string, command: string, cwd: string): Promise<{ action: 'allow' } | { action: 'block'; reason: string } | { action: 'escalate'; approvalId: string; reason: string }>
  /** Wraps worker shell commands for the execution tier (Docker sandbox). */
  wrapShell?(ticket: Ticket): ((command: string) => string) | undefined
  /** Text added to every agent's system prompt (memory). */
  sharedPrompt?(role: 'router' | 'worker', ticket?: Ticket): string
  /** Context recalled for new input (memory): appended to the input it was recalled for. */
  inlineContext?(text: string, scope: string | undefined): Promise<string>
  /** Which of the owner's folders the file tools may reach (权限 → 文件夹). */
  fsAccess?(ticket: Ticket): FsAccess | undefined
}

export function registerAgents(store: Store, runtime: AgentRuntime, engine: Engine, ext: AgentExtensions = {}): { reportedThisTurn: Set<string> } {
  const reportedThisTurn = new Set<string>()
  runtime.createSession('router', 'router', { id: ROUTER_SESSION })

  const conversationTitle = (id: string) => store.db.select({ t: schema.conversations.title }).from(schema.conversations).where(eq(schema.conversations.id, id)).get()?.t ?? ''

  /** Recent messages of a conversation as compact lines (Inline & Spill: long ones clipped, full text via recall). */
  const recent = (conversationId: string, before?: number, n = CONTEXT_MESSAGES) => {
    const rows = store.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.createdAt)).limit(n + 1).all().filter(m => before === undefined || m.createdAt < before).slice(0, n).reverse()
    return rows.map(m => {
      if (m.role === 'event') return ''
      const actor = (m.meta as { actor?: string; source?: string }).actor
      const who = m.role === 'user' ? (actor && actor !== 'owner' ? `${actor} (${(m.meta as { source?: string }).source})` : 'owner') : 'agent'
      return `  ${who}${m.triggerId ? ` (${m.triggerId})` : ''}: ${clip(m.content.replace(/\s+/g, ' '), 300)}`
    }).filter(Boolean).join('\n')
  }

  const tasksIn = (conversationId: string) => {
    const threadId = engine.threadOf(conversationId)
    const own = engine.tickets({ threadId })
    const subscribed = engine.subscribers(threadId).filter(t => !own.some(o => o.id === t.id))
    return [...own, ...subscribed].slice(0, 8).map(t => `  - ${t.id} "${t.title}" ${t.ended ? `ended:${t.ended.outcome}` : engine.stage(t)}`).join('\n')
  }

  const triggerCard = (triggerId: string, tag = 'message', extra = '') => {
    const trigger = store.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    if (!trigger) return `<${tag} trigger_id="${triggerId}">（已不存在）</${tag}>`
    const cnv = engine.conversationOfThread(trigger.threadId) ?? ''
    const tasks = cnv ? tasksIn(cnv) : ''
    const external = trigger.source !== 'webchat'
    const url = (trigger.meta as { url?: string }).url
    const info = external ? ext.threadInfo?.(trigger.threadId) : undefined
    return [`<${tag} trigger_id="${trigger.id}" source="${trigger.source}"${external ? ` from="${trigger.actor}"` : ''} conversation_id="${cnv}" conversation="${conversationTitle(cnv)}"${external ? ` thread="${trigger.threadId}"` : ''} at="${new Date(trigger.at).toISOString()}"${url ? ` url="${url}"` : ''}${extra}>`,
      info ? `thread: ${info}` : '',
      cnv ? `recent context:\n${recent(cnv, trigger.at) || '  （新对话）'}` : '',
      tasks ? `tasks in this conversation:\n${tasks}` : '',
      `text:\n${trigger.text}`, `</${tag}>`].filter(Boolean).join('\n')
  }

  runtime.registerResolver('tkt', ref => { try { return engine.describeTicket(engine.ticket(ref)) } catch { return undefined } })
  runtime.registerResolver('trg', ref => {
    const t = store.db.select().from(schema.triggers).where(eq(schema.triggers.id, ref)).get()
    return t && `<trigger id="${t.id}" source="${t.source}" from="${t.actor}" thread="${t.threadId}" conversation="${engine.conversationOfThread(t.threadId) ?? ''}" at="${new Date(t.at).toISOString()}" disposition='${JSON.stringify(t.disposition)}'>\n${t.text}\n</trigger>`
  })
  runtime.registerResolver('cnv', (ref, page = 1) => {
    const rows = store.db.select().from(schema.messages).where(eq(schema.messages.conversationId, ref)).orderBy(asc(schema.messages.createdAt)).all()
    if (!rows.length) return undefined
    const per = 30
    const pages = Math.ceil(rows.length / per)
    const p = Math.min(Math.max(page, 1), pages)
    // Page 1 is the most recent.
    const slice = rows.slice(Math.max(0, rows.length - p * per), rows.length - (p - 1) * per)
    return `<conversation id="${ref}" title="${conversationTitle(ref)}" page="${p}/${pages}">\n${slice.map(m =>
      m.role === 'event' ? `[task card ${m.ticketId}]` : `${m.role === 'user' ? ((m.meta as { actor?: string }).actor ?? 'owner') : 'agent'}${m.triggerId ? ` (${m.triggerId})` : ''}: ${clip(m.content, 2_000)}`).join('\n')}\n</conversation>`
  })

  // Chain of recall (article §3.3): trigger → thread → task → session → another thread.
  runtime.registerResolver('thread', ref => {
    const thread = store.db.select().from(schema.threads).where(eq(schema.threads.id, ref)).get()
    if (!thread) return undefined
    const events = store.db.select().from(schema.triggers).where(eq(schema.triggers.threadId, ref)).orderBy(desc(schema.triggers.at)).limit(20).all().reverse()
    const tasks = engine.subscribers(ref)
    const meta = thread.meta as { title?: string; url?: string }
    return [`<thread id="${ref}" source="${thread.source}" title="${meta.title ?? ''}"${meta.url ? ` url="${meta.url}"` : ''} conversation="${engine.conversationOfThread(ref) ?? ''}">`,
      ext.threadInfo?.(ref) ?? '',
      tasks.length ? `work on this thread: ${tasks.map(t => `${t.id} "${t.title}" ${t.ended ? `ended:${t.ended.outcome}` : engine.stage(t)} session=${t.sessionId}`).join('; ')}` : '',
      'events (oldest first):',
      ...events.map(e => `- ${e.id} ${new Date(e.at).toISOString()} ${e.actor}${e.human ? '' : ' (bot)'}: ${clip(e.text.replace(/\s+/g, ' '), 300)}`),
      '</thread>'].filter(Boolean).join('\n')
  })
  runtime.registerResolver('ses', (ref, page = 1) => {
    const session = runtime.session(ref)
    if (!session) return undefined
    const lines: string[] = []
    for (const e of runtime.events(ref)) {
      if (e.kind !== 'message') continue
      const m = e.payload
      if (typeof m.content === 'string') { lines.push(`${m.role}: ${clip(m.content, 600)}`); continue }
      for (const p of m.content as any[]) {
        if (p.type === 'text' && p.text) lines.push(`${m.role}: ${clip(p.text, 600)}`)
        else if (p.type === 'tool-call') lines.push(`→ ${p.toolName} ${clip(JSON.stringify(p.input), 240)}`)
        else if (p.type === 'tool-result') lines.push(`  ↳ ${clip(JSON.stringify(p.output?.value ?? p.output), 300)}`)
      }
    }
    const per = 60
    const pages = Math.max(1, Math.ceil(lines.length / per))
    const p = Math.min(Math.max(page, 1), pages)
    // Page 1 is the most recent.
    const slice = lines.slice(Math.max(0, lines.length - p * per), lines.length - (p - 1) * per)
    return `<session id="${ref}" role="${session.role}" task="${session.ticketId ?? ''}" state="${session.state}" page="${p}/${pages}">\n${slice.join('\n')}\n</session>`
  })

  // ── Router ────────────────────────────────────────────────────────────────
  // Models sometimes answer in plain text, which nobody sees. A turn that had something to answer and ended with text but
  // no message gets one reminder carrying that text, so it is sent properly (or dropped) instead of lost.
  const SPEAKING = new Set(['reply', 'message_owner', 'start_task', 'attach', 'ignore', 'stop_task'])
  const ANSWERABLE = new Set(['trigger', 'handback', 'report', 'approval', 'unsent'])
  SPEAKING.add('start_silent_task')
  let spoke = false
  let answerable = false
  let reminded = false
  const router: AgentDefinition = {
    role: 'router',
    pool: 'router',
    maxSteps: 30,
    system: () => `${ROUTER_PROMPT}${ext.routerPrompt ? `\n\n${ext.routerPrompt()}` : ''}${ext.sharedPrompt ? `\n\n${ext.sharedPrompt('router')}` : ''}\n\nToday: ${today()}`,
    formatInbox: async items => {
      if (items.some(i => ANSWERABLE.has(i.payload.type) && (i.payload.type !== 'report' || ['ready', 'blocked', 'failed'].includes(i.payload.status) || i.payload.humanAction))) answerable = true
      // What the router may remember directly depends on whose words this batch carries, decided here in code.
      const requests = items.filter(i => i.payload.type === 'trigger' || i.payload.type === 'handback' || i.payload.type === 'proactive').map(i => String(i.payload.triggerId))
      if (requests.length) {
        routerContext.trust = requests.every(id => engine.isOwnerChat(id)) ? 'user' : 'external'
        routerContext.source = requests.at(-1)!
        const last = store.db.select({ threadId: schema.triggers.threadId }).from(schema.triggers).where(eq(schema.triggers.id, requests.at(-1)!)).get()
        routerContext.scope = last ? engine.scopeOfThread(last.threadId) : undefined
      }
      const body = items.map(item => renderRouterItem(item)).join('\n\n')
      return `${body}${await recallFor(requests)}`
    },
    onTurnEnd: (_session, info) => {
      const remind = answerable && !spoke && !reminded && !info.cancelled && info.lastText.trim().length > 0
      spoke = false
      answerable = false
      reminded = remind
      if (remind) store.atomic(() => runtime.push(ROUTER_SESSION, { type: 'unsent', text: clip(info.lastText.trim(), 3_000) }))
    },
    tools: () => wrapSpeaking({
      reply: tool({
        description: 'Post a message to the owner — the only way to speak. It also goes out to the source (e.g. a GitHub comment) when reply_to is a message from that source, or ticket_id is work that came from it; otherwise it stays in the web. The owner sees only your text: the full result and files stay in the work\'s details.',
        inputSchema: z.object({ conversation_id: z.string().optional().describe('Required unless ticket_id is given'), text: z.string().min(1),
          reply_to: z.string().optional().describe('trigger_id of the message you answer'),
          ticket_id: z.string().optional().describe('The work this message is about'),
          detailed: z.boolean().optional().describe('Only when the owner explicitly asked for a long, detailed answer in chat') }),
        execute: async ({ conversation_id, text, ticket_id, reply_to, detailed }, { toolCallId }) => {
          const conversationId = conversation_id ?? (ticket_id ? engine.conversationOfTicket(ticket_id) : undefined)
          if (!conversationId) return { ok: false, error: 'conversation_id is required without ticket_id' }
          const source = reply_to || ticket_id ? engine.replySource(reply_to, ticket_id) : conversationSource(conversationId)
          const length = chatLength(text)
          const limit = detailed ? DETAILED_LIMIT : CHAT_LIMIT
          if (CHAT_SOURCES.has(source) && length > limit) {
            return { ok: false, error: `Not sent: about ${length} words; chat replies must stay under ${limit}. Say only the outcome and key facts${ticket_id ? ' — the full result stays in the work\'s details' : ''}, then call reply again.` }
          }
          return { ok: true, message_id: engine.reply({ conversationId, text, callId: toolCallId, ...(ticket_id ? { ticketId: ticket_id } : {}), ...(reply_to ? { replyTo: reply_to } : {}) }) }
        },
      }),
      start_silent_task: tool({
        description: 'Start silent work on an event that passed the proactive filter (<proactive>): a helper investigates or prepares something locally, posts nothing anywhere, and reports back with proactive="true". Use ignore instead if it is not worth it after all.',
        inputSchema: z.object({ trigger_id: z.string(), title: z.string().min(1).max(40).describe("Short title in the owner's language"), goal: z.string().max(300).optional() }),
        execute: async ({ trigger_id, title, goal }) => {
          const trigger = store.db.select().from(schema.triggers).where(eq(schema.triggers.id, trigger_id)).get()
          const verdict = (trigger?.disposition as { proactive?: { act?: boolean; reason?: string } } | undefined)?.proactive
          if (!verdict?.act) return { ok: false, error: 'Only events the proactive filter picked can get silent work.' }
          try {
            const ticket = engine.startProactive(trigger_id, { title, reason: verdict.reason ?? '', ...(goal ? { goal } : {}) })
            return { ok: true, ticket_id: ticket.id }
          } catch (error) {
            if (error instanceof DomainError && error.code === 'conflict') return { ok: false, error: `${error.message}. Use ignore with this reason; it stays on the activity page for the owner.` }
            throw error
          }
        },
      }),
      ignore: tool({
        description: 'Record that message(s) need nothing from you (thanks, chatter, bots, already handled), with the reason. Nothing is posted.',
        inputSchema: z.object({ trigger_ids: z.array(z.string()).min(1), reason: z.string().min(1).max(200) }),
        execute: async ({ trigger_ids, reason }) => { engine.ignore(trigger_ids, reason); return { ok: true } },
      }),
      react: tool({
        description: 'Optionally put a small reaction on the owner\'s message, alone or with a reply, only when their words call for it, the way a friend would (most messages get none): 👌 got it, 👀 looking into it, 😂 that was funny, ❤️ thanks, 👍 agreed. A reaction alone is enough for thanks or a joke.',
        inputSchema: z.object({ trigger_id: z.string().describe('trigger_id of the owner\'s message'), emoji: z.enum(['👌', '👀', '😂', '❤️', '👍']) }),
        execute: async ({ trigger_id, emoji }) => engine.react(trigger_id, emoji) ? { ok: true } : { ok: false, error: 'No owner message with this trigger_id.' },
      }),
      message_owner: tool({
        description: 'Say something to the owner on your own initiative, in the main conversation (a heads-up, a follow-up, a reminder). Only when it is worth an interruption.',
        inputSchema: z.object({ text: z.string().min(1), ticket_id: z.string().optional().describe('The work it is about') }),
        execute: async ({ text, ticket_id }, { toolCallId }) => {
          if (chatLength(text) > CHAT_LIMIT) return { ok: false, error: `Not sent: chat messages must stay under ${CHAT_LIMIT} words.` }
          return { ok: true, message_id: engine.reply({ conversationId: engine.mainConversation(), text, callId: toolCallId, ...(ticket_id ? { ticketId: ticket_id } : {}) }) }
        },
      }),
      start_task: tool({
        description: 'Start a task: a worker with shell, file and web tools works on the owner\'s original message(s) in its own session. Returns the task id.',
        inputSchema: z.object({
          conversation_id: z.string().optional(),
          trigger_ids: z.array(z.string()).min(1).describe('The message(s) this task is for, all from one conversation/thread'),
          title: z.string().min(1).max(40).describe("Short title in the owner's language"),
          name: z.string().optional().describe('Optional ascii kebab-case name for the working directory, e.g. "weekly-report"'),
          ack: z.string().optional().describe('One sentence to the owner naming what will be done'),
          note: z.string().max(200).optional().describe('Routing facts only (≤30 words), never a plan'),
          directory: z.string().optional().describe('An existing project directory, only if the owner named one'),
          project: z.string().optional().describe('The project this belongs to (e.g. a repository or a long-running effort), for project memory'),
        }),
        execute: async (input, { toolCallId }) => {
          const ticket = engine.startTask({ ...(input.conversation_id ? { conversationId: input.conversation_id } : {}), triggerIds: input.trigger_ids, title: input.title, callId: toolCallId,
            ...(input.name ? { name: input.name } : {}), ...(input.ack ? { ack: input.ack } : {}), ...(input.note ? { note: input.note } : {}),
            ...(input.directory ? { directory: input.directory } : {}), ...(input.project ? { project: input.project } : {}) })
          return { ok: true, ticket_id: ticket.id, directory: ticket.directory }
        },
      }),
      attach: tool({
        description: 'Route an owner message to an existing task it explicitly refers to. An ended task resumes.',
        inputSchema: z.object({ ticket_id: z.string(), trigger_id: z.string(), note: z.string().max(200).optional() }),
        execute: async ({ ticket_id, trigger_id, note }) => { engine.attach({ ticketId: ticket_id, triggerId: trigger_id, ...(note ? { note } : {}) }); return { ok: true } },
      }),
      stop_task: tool({
        description: 'Stop a task. Only when the owner asks.',
        inputSchema: z.object({ ticket_id: z.string(), reason: z.string() }),
        execute: async ({ ticket_id, reason }) => { engine.stopTask(ticket_id, 'person', reason); return { ok: true } },
      }),
      note_task: tool({
        description: 'Give a task\'s worker a fact from elsewhere (≤100 words). Grants no new scope.',
        inputSchema: z.object({ ticket_id: z.string(), text: z.string().max(800) }),
        execute: async ({ ticket_id, text }) => { engine.note(ticket_id, text); return { ok: true } },
      }),
      list_tasks: tool({
        description: 'List tasks (open ones, or recent ones including ended).',
        inputSchema: z.object({ include_ended: z.boolean().optional() }),
        execute: async ({ include_ended }) => {
          const list = engine.tickets(include_ended ? {} : { open: true }).slice(0, 30)
          return list.length ? list.map(t => `${t.id} "${t.title}" ${engine.stage(t)} conversation=${engine.conversationOfThread(t.threadId) ?? ''}`).join('\n') : '（没有任务）'
        },
      }),
      ...recallTool(runtime),
      ...(ext.routerTools?.() ?? {}),
    }),
    onTurnError: (_s, error) => { spoke = false; answerable = false; console.error('[router] turn failed:', error instanceof Error ? error.message : error) },
  }

  /** Marks the turn as having spoken when a speaking tool succeeds. */
  function wrapSpeaking(tools: ToolSet): ToolSet {
    for (const [name, t] of Object.entries(tools)) {
      if (!SPEAKING.has(name) || !t.execute) continue
      const run = t.execute
      t.execute = async (input: any, options: any) => {
        const result = await run(input, options)
        if (!(result && typeof result === 'object' && (result as { ok?: boolean }).ok === false)) spoke = true
        return result
      }
    }
    return tools
  }

  /** Memories relevant to the requests in a batch, recalled within their project (Inline & Spill). */
  async function recallFor(triggerIds: string[]): Promise<string> {
    if (!ext.inlineContext || !triggerIds.length) return ''
    const rows = store.db.select().from(schema.triggers).where(inArray(schema.triggers.id, triggerIds)).all()
    if (!rows.length) return ''
    try {
      const block = await ext.inlineContext(rows.map(r => r.text).join('\n').slice(0, 4_000), engine.scopeOfThread(rows.at(-1)!.threadId))
      return block ? `\n\n${block}` : ''
    } catch { return '' }
  }

  function conversationSource(id: string): string {
    return store.db.select({ s: schema.conversations.source }).from(schema.conversations).where(eq(schema.conversations.id, id)).get()?.s ?? 'webchat'
  }

  function renderRouterItem(item: InboxItem): string {
    const p = item.payload
    switch (p.type) {
      case 'trigger': return triggerCard(p.triggerId)
      case 'followup': return triggerCard(p.triggerId, 'followup', ` delivered_to="${p.ticketIds.join(',')}"`)
      case 'handback': return triggerCard(p.triggerId, 'handback', ` from_task="${p.ticketId}" reason="${String(p.reason).replace(/"/g, "'")}"`)
      case 'report': {
        let t
        try { t = engine.ticket(p.ticketId) } catch { return `<report ticket_id="${p.ticketId}">（任务已删除）</report>` }
        // A question the owner already answered (from the task card) must not be forwarded again.
        const answered = p.humanAction && !t.attention
        const proactive = isProactive(t)
        return [`<report ticket_id="${t.id}" title="${t.title}" status="${p.status}" conversation_id="${engine.conversationOfThread(t.threadId) ?? ''}" origin="${sourceOfThread(t.threadId)}"${proactive ? ` proactive="true" why="${String((t.mandate as Mandate).reason ?? '').replace(/"/g, "'")}"` : ''}>`,
          clip(p.summary, 3_000), p.files?.length ? `files (kept in the work\'s details): ${p.files.join(', ')}` : '',
          p.humanAction ? `human_action: ${JSON.stringify(p.humanAction)}${answered ? ' (already answered by the owner — do not forward it)' : ''}` : '', '</report>'].filter(Boolean).join('\n')
      }
      case 'approval': {
        let title = p.ticketId
        try { title = engine.ticket(p.ticketId).title } catch { /* gone */ }
        return `<approval approval_id="${p.approvalId}" ticket_id="${p.ticketId}" title="${title}" conversation_id="${(() => { try { return engine.conversationOfThread(engine.ticket(p.ticketId).threadId) ?? '' } catch { return '' } })()}">\nThe worker wants to run: ${String(p.command).slice(0, 500)}\nWhy it needs the owner: ${p.reason}\n</approval>`
      }
      case 'proactive': return triggerCard(p.triggerId, 'proactive', ` filter_reason="${String(p.reason ?? '').replace(/"/g, "'")}"${p.title ? ` suggested_title="${String(p.title).replace(/"/g, "'")}"` : ''}${p.goal ? ` suggested_goal="${String(p.goal).replace(/"/g, "'")}"` : ''}`)
      case 'ticket-ended': return `<task_ended ticket_id="${p.ticketId}" outcome="${p.outcome}" by="${p.by}" />`
      case 'recovery': return '<recovery>服务刚刚重启。检查 list_tasks，不要重复已经发出的消息或已经开始的任务。</recovery>'
      case 'unsent': return `<unsent>Your last turn ended with plain text and no message, so the owner saw NOTHING. Only the reply tool posts messages. If the text below was meant for the owner, send it now with reply (conversation_id, and ticket_id when it is about finished work); if not, end your turn without output.\n---\n${p.text}\n</unsent>`
      default: return `<event>${JSON.stringify(p)}</event>`
    }
  }

  // ── Worker ────────────────────────────────────────────────────────────────
  const worker: AgentDefinition = {
    role: 'worker',
    pool: 'worker',
    maxSteps: 150,
    system: session => {
      const ticket = engine.ticket(session.ticketId!)
      const extra = [isProactive(ticket) ? PROACTIVE_WORKER_PROMPT : '', ext.workerPrompt?.(ticket), ext.sharedPrompt?.('worker', ticket)].filter(Boolean).join('\n\n')
      return `${WORKER_PROMPT}${extra ? `\n\n${extra}` : ''}\n\n## Environment\n- Working directory: ${ticket.directory}\n- Task id: ${ticket.id}\n- OS: ${process.platform}\n- Today: ${today()}`
    },
    formatInbox: async (items, session) => {
      const body = items.map(item => renderWorkerItem(item, session.ticketId!, session.id)).join('\n\n')
      const start = items.find(i => i.payload.type === 'assignment' && i.payload.reason === 'start')
      if (!start || !ext.inlineContext) return body
      try {
        const t = engine.ticket(session.ticketId!)
        const origin = store.db.select().from(schema.triggers).where(inArray(schema.triggers.id, t.origin.triggerIds)).all()
        const block = await ext.inlineContext(`${t.title}\n${origin.map(o => o.text).join('\n')}`.slice(0, 4_000), engine.projectOf(t))
        return block ? `${body}\n\n${block}` : body
      } catch { return body }
    },
    tools: ctx => {
      const ticket = engine.ticket(ctx.session.ticketId!)
      const exec = engine.execution()
      return {
        ...fsTools(ticket.directory, runtime.blobs, ext.fsAccess?.(ticket)),
        ...shellTools(runtime.jobs, runtime.blobs, {
          sessionId: ctx.session.id, cwd: ticket.directory, signal: ctx.signal, blocked: exec.blockedCommands,
          env: workerEnv({ SUPER_ASSISTANT_TICKET: ticket.id, SUPER_ASSISTANT_DIR: ticket.directory, ...(ext.workerEnv?.(ticket) ?? {}) }),
          foregroundMs: exec.foregroundSeconds * 1000, timeoutMs: exec.timeoutMinutes * 60_000,
          ...(ext.gateShell ? { gate: (command: string) => ext.gateShell!(ticket, ctx.session.id, command, ticket.directory) } : {}),
          ...(ext.wrapShell?.(ticket) ? { wrap: ext.wrapShell(ticket)! } : {}),
        }),
        ...webTools(runtime.blobs),
        ...recallTool(runtime),
        ...(ext.workerTools?.(ticket, ctx) ?? {}),
        report: tool({
          description: 'Report this work\'s state to the assistant. Required once at the end of every turn.',
          inputSchema: z.object({
            status: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
            summary: z.string().min(1),
            human_action: z.object({ question: z.string().min(1), options: z.array(z.string()).max(6).optional() }).optional()
              .describe('One concrete question for the owner, with status waiting'),
            files: z.array(z.string()).max(20).optional().describe('Deliverable files the work produced (paths relative to the working directory), kept in the work\'s details and file library'),
          }),
          execute: async ({ status, summary, human_action, files }) => {
            const { rejectedFiles } = engine.report(ticket.id, { status, summary, ...(human_action ? { humanAction: human_action } : {}), ...(files?.length ? { files } : {}) })
            reportedThisTurn.add(ctx.session.id)
            return { ok: true, note: status === 'ready' || status === 'dropped' ? 'Work ended. Finish your turn now.' : 'Recorded. End your turn unless you have more to do now.',
              ...(rejectedFiles.length ? { not_attached: rejectedFiles, why: 'not a file inside the working directory' } : {}) }
          },
        }),
        subagent_start: tool({
          description: 'Start a subagent on one focused, independent sub-job (it shares your working directory and tools, but not your context). Returns at once; its result arrives later as a <subagent_result> message. Use for parallel research or trying alternatives.',
          inputSchema: z.object({ job: z.string().min(1).max(4_000).describe('What to do and what to return, self-contained'), context: z.string().max(4_000).optional() }),
          execute: async ({ job, context }) => {
            const running = runtime.children(ctx.session.id).filter(id => { const s = runtime.session(id); return s && (s.state === 'running' || s.state === 'queued' || runtime.pending(id).length > 0) })
            if (running.length >= MAX_SUBAGENTS) return { ok: false, error: `${MAX_SUBAGENTS} subagents are already running; wait for one to finish or stop one.` }
            let id = ''
            store.atomic(() => {
              id = runtime.createSession('subagent', 'subagent', { ticketId: ticket.id, meta: { parent: ctx.session.id, job: clip(job, 200) } })
              runtime.push(id, { type: 'subtask', job, ...(context ? { context } : {}) })
            })
            return { ok: true, subagent_id: id, note: 'Running. Do not wait: continue other work or report progress and end your turn.' }
          },
        }),
        subagent_stop: tool({
          description: 'Stop a subagent you started.',
          inputSchema: z.object({ subagent_id: z.string() }),
          execute: async ({ subagent_id }) => {
            if (runtime.session(subagent_id)?.meta.parent !== ctx.session.id) return { ok: false, error: 'not your subagent' }
            runtime.discardPending(subagent_id)
            runtime.cancel(subagent_id)
            stoppedSubagents.add(subagent_id)
            return { ok: true }
          },
        }),
        unfollow_thread: tool({
          description: 'Stop receiving events from a thread you followed but no longer need (not your own origin thread).',
          inputSchema: z.object({ thread_id: z.string() }),
          execute: async ({ thread_id }) => { engine.unfollow(ticket.id, thread_id); return { ok: true } },
        }),
        handback: tool({
          description: 'Hand an owner message back to the main agent because it is not about this task. Do not answer it yourself.',
          inputSchema: z.object({ trigger_id: z.string(), reason: z.string() }),
          execute: async ({ trigger_id, reason }) => { engine.handback(ticket.id, trigger_id, reason); return { ok: true } },
        }),
      }
    },
    onTurnEnd: (session, info) => {
      const reported = reportedThisTurn.delete(session.id)
      try { engine.turnEnded(session.ticketId!, { reported, ...info }) } catch (error) { console.error('[worker] turnEnded', error) }
    },
    onTurnError: (session, error) => {
      reportedThisTurn.delete(session.id)
      try { engine.turnFailed(session.ticketId!, error instanceof Error ? error.message : String(error)) } catch { /* ticket gone */ }
    },
  }

  /** Subscriptions are not locks: a worker learns who else works on its thread, so it can avoid conflicting changes. */
  function otherWork(t: Ticket): string {
    const others = engine.subscribers(t.threadId).filter(x => x.id !== t.id && !x.ended)
    return others.length ? `other open work on this thread (coordinate; do not duplicate or overwrite it): ${others.map(x => `${x.id} "${x.title}"`).join(', ')}` : ''
  }

  function renderWorkerItem(item: InboxItem, ticketId: string, sessionId: string): string {
    const p = item.payload
    switch (p.type) {
      case 'assignment': {
        const t = engine.ticket(ticketId)
        if (p.reason === 'start' && isProactive(t)) {
          const origin = store.db.select().from(schema.triggers).where(inArray(schema.triggers.id, t.origin.triggerIds)).all()
          const info = ext.threadInfo?.(t.threadId)
          return [`<assignment task_id="${t.id}" title="${t.title}" source="${sourceOfThread(t.threadId)}" mode="silent">`,
            info ? `thread: ${info}` : `thread: ${t.threadId}`,
            `why the owner's strategy picked it: ${(t.mandate as Mandate).reason ?? ''}`,
            otherWork(t),
            `the event (not addressed to the assistant):\n${origin.map(o => `(${o.id}, ${o.source} @${o.actor}${o.human ? '' : ' bot'}) ${o.text}`).join('\n\n')}`,
            '</assignment>'].filter(Boolean).join('\n')
        }
        if (p.reason === 'start') {
          const origin = store.db.select().from(schema.triggers).where(inArray(schema.triggers.id, t.origin.triggerIds)).orderBy(asc(schema.triggers.at)).all()
          const cnv = engine.conversationOfThread(t.threadId) ?? ''
          const info = sourceOfThread(t.threadId) !== 'webchat' ? ext.threadInfo?.(t.threadId) : undefined
          return [`<assignment task_id="${t.id}" title="${t.title}" conversation_id="${cnv}" source="${sourceOfThread(t.threadId)}">`,
            info ? `thread: ${info}` : '',
            t.note ? `routing note: ${t.note}` : '',
            cnv ? `conversation context before the request:\n${recent(cnv, origin[0]?.at) || '  （无）'}` : '',
            otherWork(t),
            `original request from the owner:\n${origin.map(o => `(${o.id}${o.source !== 'webchat' ? `, ${o.source} @${o.actor}` : ''}) ${o.text}`).join('\n\n')}`,
            '</assignment>'].filter(Boolean).join('\n')
        }
        if (p.reason === 'resume') return `<resume task_id="${t.id}">任务因主人的新消息恢复（见下一条）。</resume>`
        if (p.reason === 'retry') return `<retry task_id="${t.id}">主人要求重试。先检查工作目录里已有的进度，再继续。</retry>`
        return `<recovery task_id="${t.id}">服务重启打断了上一轮。先检查工作目录和已经做过的操作，不要重复对外操作，然后继续。</recovery>`
      }
      case 'trigger': {
        const trigger = store.db.select().from(schema.triggers).where(eq(schema.triggers.id, p.triggerId)).get()
        if (trigger && (trigger.source !== 'webchat' || trigger.actor !== 'owner')) {
          if (!engine.isOwnerTrigger(trigger.id)) engine.taint(sessionId)
          const url = (trigger.meta as { url?: string }).url
          return `<message trigger_id="${p.triggerId}" source="${trigger.source}" from="${trigger.actor}"${trigger.human ? '' : ' bot="true"'}${url ? ` url="${url}"` : ''}${p.note ? ` routing_note="${String(p.note).replace(/"/g, "'")}"` : ''}>\n${trigger.text}\n</message>`
        }
        return `<owner_message trigger_id="${p.triggerId}"${p.note ? ` routing_note="${String(p.note).replace(/"/g, "'")}"` : ''}>\n${trigger?.text ?? ''}\n</owner_message>`
      }
      case 'note': return `<note from="${p.from ?? 'main agent'}">${p.text}</note>`
      case 'subagent': return `<subagent_result subagent_id="${p.subagentId}" status="${p.status}">\n${p.result}\n</subagent_result>`
      case 'approval-result': return `<approval_result approval_id="${p.approvalId}">${p.error ? `批准后执行失败：${p.error}` : `批准后已执行 ${p.command}，结果：\n${p.output}`}</approval_result>`
      case 'approval': return p.status === 'approved'
        ? `<approval approval_id="${p.approvalId}" status="approved">主人批准了：${p.command}${p.note ? `（备注：${p.note}）` : ''}。已开始执行，结果会作为新消息送达。</approval>`
        : `<approval approval_id="${p.approvalId}" status="denied">主人拒绝了：${p.command}${p.note ? `（理由：${p.note}）` : ''}。不要再尝试这条命令或它的变体；调整方案，或用 report 说明。</approval>`
      case 'job': return `<job_finished job_id="${p.jobId}" status="${p.status}"${p.exitCode !== undefined ? ` exit_code="${p.exitCode}"` : ''} command="${String(p.command).replace(/"/g, "'").slice(0, 200)}">\n${p.output ?? ''}\n</job_finished>`
      default: return `<event>${JSON.stringify(p)}</event>`
    }
  }

  // ── Subagent: a worker's parallel helper (article §2.2, §4.1) ────────────────
  const stoppedSubagents = new Set<string>()
  const finished = new Map<string, string>()
  const toParent = (session: { id: string; meta: Record<string, unknown>; ticketId: string | null }, status: 'done' | 'failed' | 'stopped', result: string) => {
    const parent = String(session.meta.parent ?? '')
    if (!parent || !session.ticketId) return
    try { if (engine.ticket(session.ticketId).ended) return } catch { return }
    store.atomic(() => runtime.push(parent, { type: 'subagent', subagentId: session.id, status, result: runtime.blobs.spill('subagent-result', result) }))
  }
  const subagent: AgentDefinition = {
    role: 'subagent',
    pool: 'worker',
    maxSteps: 60,
    system: session => {
      const ticket = engine.ticket(session.ticketId!)
      return `${SUBAGENT_PROMPT}\n\n## Environment\n- Working directory: ${ticket.directory}\n- OS: ${process.platform}\n- Today: ${today()}`
    },
    formatInbox: items => items.map(({ payload: p }) => {
      if (p.type === 'subtask') return `<subtask>\n${p.job}${p.context ? `\n\ncontext:\n${p.context}` : ''}\n</subtask>`
      if (p.type === 'job') return `<job_finished job_id="${p.jobId}" status="${p.status}"${p.exitCode !== undefined ? ` exit_code="${p.exitCode}"` : ''}>\n${p.output ?? ''}\n</job_finished>`
      if (p.type === 'recovery') return '<recovery>服务重启打断了你。检查工作目录里已有的结果，继续，然后 finish。</recovery>'
      return `<event>${JSON.stringify(p)}</event>`
    }).join('\n\n'),
    tools: ctx => {
      const ticket = engine.ticket(ctx.session.ticketId!)
      const exec = engine.execution()
      return {
        ...fsTools(ticket.directory, runtime.blobs, ext.fsAccess?.(ticket)),
        ...shellTools(runtime.jobs, runtime.blobs, {
          sessionId: ctx.session.id, cwd: ticket.directory, signal: ctx.signal, blocked: exec.blockedCommands,
          env: workerEnv({ SUPER_ASSISTANT_TICKET: ticket.id, SUPER_ASSISTANT_DIR: ticket.directory, ...(ext.workerEnv?.(ticket) ?? {}) }),
          foregroundMs: exec.foregroundSeconds * 1000, timeoutMs: exec.timeoutMinutes * 60_000,
          ...(ext.gateShell ? { gate: (command: string) => ext.gateShell!(ticket, ctx.session.id, command, ticket.directory) } : {}),
          ...(ext.wrapShell?.(ticket) ? { wrap: ext.wrapShell(ticket)! } : {}),
        }),
        ...webTools(runtime.blobs),
        ...recallTool(runtime),
        finish: tool({
          description: 'Return your result to the helper that started you. Ends your work.',
          inputSchema: z.object({ result: z.string().min(1) }),
          execute: async ({ result }) => { finished.set(ctx.session.id, result); return { ok: true, note: 'Delivered. End your turn now.' } },
        }),
      }
    },
    onTurnEnd: (session, info) => {
      if (stoppedSubagents.delete(session.id) || info.cancelled) return
      const result = finished.get(session.id)
      finished.delete(session.id)
      if (result !== undefined) return toParent(session, 'done', result)
      // Still waiting on a background command: it will wake the subagent again.
      if (info.runningJobs > 0) return
      toParent(session, info.stepLimit ? 'failed' : 'done', info.lastText || '（子任务结束，没有给出结果）')
    },
    onTurnError: (session, error) => {
      finished.delete(session.id)
      toParent(session, 'failed', `子任务出错：${error instanceof Error ? error.message : String(error)}`)
    },
  }

  runtime.register(router)
  runtime.register(worker)
  runtime.register(subagent)
  return { reportedThisTurn }
}

export { DomainError, STAGE_LABEL }

/** Merges several extension sets (sources, memory, review) into one. */
export function combineExtensions(...exts: AgentExtensions[]): AgentExtensions {
  const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join('\n\n')
  const gate = exts.find(e => e.gateShell)?.gateShell
  const wrap = exts.find(e => e.wrapShell)?.wrapShell
  const fsAccess = exts.find(e => e.fsAccess)?.fsAccess
  return {
    routerPrompt: () => join(exts.map(e => e.routerPrompt?.())),
    routerTools: () => Object.assign({}, ...exts.map(e => e.routerTools?.() ?? {})),
    workerPrompt: t => join(exts.map(e => e.workerPrompt?.(t))),
    workerTools: (t, ctx) => Object.assign({}, ...exts.map(e => e.workerTools?.(t, ctx) ?? {})),
    workerEnv: t => Object.assign({}, ...exts.map(e => e.workerEnv?.(t) ?? {})),
    threadInfo: id => exts.map(e => e.threadInfo?.(id)).find(Boolean),
    sharedPrompt: (role, t) => join(exts.map(e => e.sharedPrompt?.(role, t))),
    inlineContext: async (text, scope) => join(await Promise.all(exts.map(e => e.inlineContext?.(text, scope) ?? Promise.resolve('')))),
    ...(gate ? { gateShell: gate } : {}),
    ...(wrap ? { wrapShell: wrap } : {}),
    ...(fsAccess ? { fsAccess } : {}),
  }
}

/** Puts source tools that reach the owner's apps (Google Calendar) under the same 权限 levels as the local ones. */
export function gatedSourceExtension(ext: AgentExtensions, access: LocalAccess, reviewer: Reviewer | undefined): AgentExtensions {
  return { ...ext, workerTools: (ticket, ctx) => gateSourceTools(ext.workerTools?.(ticket, ctx) ?? {}, ticket, ctx.session.id, access, reviewer) }
}

/** The owner's apps on this Mac (日历, 提醒事项, 备忘录, 通讯录, 照片), at their levels in 权限. */
export function localAppsExtension(apps: LocalApps): AgentExtensions {
  return {
    workerTools: (ticket, ctx) => isProactive(ticket) ? {} : apps.tools(ticket, ctx.session.id),
    workerPrompt: ticket => isProactive(ticket) ? undefined : apps.prompt(),
  }
}

/** The owner's folder rules for workers: file tools reach allowed folders and the attachments, never the never-touch ones. */
export function accessExtension(access: LocalAccess, uploadsDir: string): AgentExtensions {
  return {
    fsAccess: () => (path, mode) => access.check(path, mode, [uploadsDir]),
    workerPrompt: () => `## The owner's folders\n${access.describe()}\nFiles the owner attached to messages are under ${uploadsDir} (read them, view_image for pictures); copy one into the working directory before changing it.`,
  }
}

/** What the router is answering right now; set per batch in code, read by the memory tools. */
const routerContext: { trust: MemoryTrust; source: string; scope: string | undefined } = { trust: 'external', source: '', scope: undefined }

/**
 * Memory for both agents: the prompt section, recall into each input, and remember / forget / search_memory.
 * Trust comes from code, never from the model: the router writes directly only while answering the owner's own words;
 * a worker only while its work came from the owner and no one else's words have reached it; silent work never does.
 */
export function memoryExtension(memory: Memory, engine: Engine): AgentExtensions {
  return {
    sharedPrompt: (role, ticket) => memory.prompt(role, ticket ? engine.projectOf(ticket) : undefined),
    inlineContext: (text, scope) => memory.inline(text, scope),
    routerTools: () => memory.tools({ by: 'router', trust: () => routerContext.trust, scope: () => routerContext.scope, source: () => routerContext.source }),
    workerTools: (ticket, ctx) => memory.tools({
      by: ticket.id,
      trust: () => {
        const t = engine.ticket(ticket.id)
        const fromOwner = (t.mandate as Mandate).strength === 'explicit' && t.origin.triggerIds.every(id => engine.isOwnerTrigger(id))
        return fromOwner && !engine.tainted(ctx.session.id) ? 'system' : 'external'
      },
      scope: () => engine.projectOf(ticket),
      source: () => ticket.id,
    }),
  }
}

/** Runs worker shell commands in the Docker sandbox when the execution settings say so. */
export function sandboxExtension(engine: Engine): AgentExtensions {
  return {
    wrapShell: ticket => {
      const settings = engine.execution().sandbox
      return sandboxApplies(settings, ticket) ? (command: string) => sandboxCommand(settings, ticket, command) : undefined
    },
    workerPrompt: ticket => sandboxApplies(engine.execution().sandbox, ticket)
      ? `## Sandbox\nYour shell commands run in a Docker container (${engine.execution().sandbox.image}, network ${engine.execution().sandbox.network}) that only sees your working directory. Tools you need must be installed inside it.`
      : undefined,
  }
}

/** The worker's browser, and handing its page to the owner. */
export function browserExtension(browser: BrowserManager, engine: Engine, runtime: AgentRuntime): AgentExtensions {
  return {
    workerTools: ticket => browser.tools(ticket.id, ticket.directory, runtime.blobs,
      reason => engine.report(ticket.id, { status: 'waiting', summary: `需要主人接管浏览器：${reason}`, humanAction: { question: reason, kind: 'handoff' } })),
    workerPrompt: () => `## Browser
You have a real browser (browser_open / browser_snapshot / browser_click / browser_type / browser_screenshot) with the owner's persistent profile, so sites they logged into stay logged in. Use it for pages that need JavaScript or a login; plain pages are cheaper with web_fetch. When a page needs the owner — logging in, 2FA, a captcha, a payment — call request_handoff with what they should do, then end your turn; never type passwords or payment details yourself.`,
  }
}

/** MCP tools for both agents; worker calls to servers marked for review pass the review layer. */
export function mcpExtension(mcp: McpManager, engine: Engine, reviewer?: Reviewer): AgentExtensions {
  reviewer?.registerExecutor('mcp', input => mcp.call(String(input.server), String(input.tool), (input.args ?? {}) as Record<string, unknown>))
  return {
    // The router must know what workers can reach, or it answers "no such tool" instead of starting a task.
    routerPrompt: () => {
      const servers = mcp.status().filter(s => s.state === 'connected' && s.tools.length)
      return servers.length ? `## MCP tools available to workers\n${servers.map(s => `- ${s.name}: ${s.tools.map(t => t.name).join(', ')}`).join('\n')}\nA request that needs one of these tools (or names the server) is a task: start_task.` : ''
    },
    routerTools: () => mcp.tools('router'),
    workerTools: (ticket, ctx) => mcp.tools('worker', reviewer
      ? (server, tool, args) => reviewer.gateTool(ticket, ctx.session.id, 'mcp', `${server.name}.${tool} ${JSON.stringify(args)}`, { server: server.name, tool, args })
      : undefined),
  }
}

/** The owner's standing instructions in every prompt; the main agent can record new ones. */
export function instructionsExtension(instructions: Instructions): AgentExtensions {
  return {
    sharedPrompt: () => instructions.prompt(),
    routerTools: () => instructions.tools('router'),
  }
}

/** Lets the main agent change the proactive strategy when the owner asks. */
export function proactiveExtension(store: Store, engine?: Engine): AgentExtensions {
  return {
    routerPrompt: () => {
      const s = proactiveSettings(store)
      return s.mode === 'off' ? '' : `## Proactive strategy (mode ${s.mode})\nEvents nobody addressed to you are screened against the owner's strategy; silent work reports back with proactive="true".\n${s.strategy}`
    },
    routerTools: () => ({ update_proactive: proactiveTool(store, 'router', engine) }),
  }
}

export function proactiveTool(store: Store, by: string, engine?: Engine) {
  return tool({
    description: 'Change how you act on events nobody addressed to you: the mode (off: never; observe: only record what you would have done; auto: work on them silently, report only what is worth it) and the strategy, written in the owner\'s words.',
    inputSchema: z.object({
      mode: z.enum(['off', 'observe', 'auto']).optional(),
      strategy_append: z.string().max(1_000).optional().describe('One line added to the strategy'),
      strategy_replace: z.string().max(4_000).optional().describe('The whole new strategy'),
      ignore_actors_add: z.array(z.string().min(1).max(100)).max(20).optional().describe('Fast Path rule: accounts never screened'),
      ignore_actors_remove: z.array(z.string()).max(20).optional(),
      sources: z.array(z.string()).max(20).optional().describe('Fast Path rule: sources whose events are screened ([] = all)'),
    }),
    execute: async ({ mode, strategy_append, strategy_replace, ignore_actors_add, ignore_actors_remove, sources }) => {
      const cur = proactiveSettings(store)
      const strategy = strategy_replace ?? (strategy_append ? [cur.strategy, strategy_append.startsWith('-') ? strategy_append : `- ${strategy_append}`].filter(Boolean).join('\n') : cur.strategy)
      const drop = new Set((ignore_actors_remove ?? []).map(a => a.toLowerCase()))
      const ignoreActors = [...new Set([...cur.ignoreActors, ...(ignore_actors_add ?? [])])].filter(a => !drop.has(a.toLowerCase()))
      const next = saveProactiveSettings(store, { ...(mode ? { mode } : {}), strategy, ignoreActors, ...(sources ? { sources } : {}) }, by)
      const stopped = cur.mode !== 'off' && next.mode === 'off' ? engine?.revokeProactive('主动处理已关闭') ?? [] : []
      return { ok: true, version: next.version, mode: next.mode, ignore_actors: next.ignoreActors, sources: next.sources, ...(stopped.length ? { stopped_silent_work: stopped.length } : {}) }
    },
  })
}
