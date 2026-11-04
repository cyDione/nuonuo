/** The router and worker agent definitions: tool sets (enforced by code, not prompt) and how their inbox items read. */
import { fsTools, recallTool, shellTools, webTools, workerEnv, type AgentDefinition, type AgentRuntime, type BrowserManager, type InboxItem, type TurnContext } from '@super-agent/agent-runtime'
import { schema, type Store } from '@super-agent/db'
import { tool, type ToolSet } from 'ai'
import { asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { clip, DomainError, Engine, ROUTER_SESSION } from './engine'
import { sourceOfThread, STAGE_LABEL, type Ticket } from './model'
import { ROUTER_PROMPT, WORKER_PROMPT } from './prompts'
import type { Memory } from './memory'
import { sandboxApplies, sandboxCommand } from './sandbox'

const CONTEXT_MESSAGES = 6

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
      if (m.role === 'event') return `  [task card ${m.ticketId}: ${m.content}]`
      const actor = (m.meta as { actor?: string; source?: string }).actor
      const who = m.role === 'user' ? (actor && actor !== 'owner' ? `${actor} (${(m.meta as { source?: string }).source})` : 'owner') : 'agent'
      return `  ${who}${m.triggerId ? ` (${m.triggerId})` : ''}: ${clip(m.content.replace(/\s+/g, ' '), 300)}`
    }).join('\n')
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
    return [`<${tag} trigger_id="${trigger.id}" source="${trigger.source}"${external ? ` from="${trigger.actor}"` : ''} conversation_id="${cnv}" conversation="${conversationTitle(cnv)}" at="${new Date(trigger.at).toISOString()}"${url ? ` url="${url}"` : ''}${extra}>`,
      info ? `thread: ${info}` : '',
      cnv ? `recent context:\n${recent(cnv, trigger.at) || '  （新对话）'}` : '',
      tasks ? `tasks in this conversation:\n${tasks}` : '',
      `text:\n${trigger.text}`, `</${tag}>`].filter(Boolean).join('\n')
  }

  runtime.registerResolver('tkt', ref => { try { return engine.describeTicket(engine.ticket(ref)) } catch { return undefined } })
  runtime.registerResolver('trg', ref => {
    const t = store.db.select().from(schema.triggers).where(eq(schema.triggers.id, ref)).get()
    return t && `<trigger id="${t.id}" source="${t.source}" from="${t.actor}" conversation="${engine.conversationOfThread(t.threadId) ?? ''}" at="${new Date(t.at).toISOString()}" disposition='${JSON.stringify(t.disposition)}'>\n${t.text}\n</trigger>`
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

  // ── Router ────────────────────────────────────────────────────────────────
  const router: AgentDefinition = {
    role: 'router',
    pool: 'router',
    maxSteps: 30,
    system: () => `${ROUTER_PROMPT}${ext.routerPrompt ? `\n\n${ext.routerPrompt()}` : ''}${ext.sharedPrompt ? `\n\n${ext.sharedPrompt('router')}` : ''}\n\nNow: ${new Date().toString()}`,
    formatInbox: items => items.map(item => renderRouterItem(item)).join('\n\n'),
    tools: () => ({
      reply: tool({
        description: 'Post a message in a conversation — the only way to speak. It also goes out to the source (e.g. a GitHub comment) when reply_to is a message from that source, or ticket_id is a task that came from it; otherwise it stays in the web.',
        inputSchema: z.object({ conversation_id: z.string(), text: z.string().min(1), reply_to: z.string().optional().describe('trigger_id of the message you answer'),
          ticket_id: z.string().optional().describe('The task this message is about') }),
        execute: async ({ conversation_id, text, ticket_id, reply_to }, { toolCallId }) =>
          ({ ok: true, message_id: engine.reply({ conversationId: conversation_id, text, callId: toolCallId, ...(ticket_id ? { ticketId: ticket_id } : {}), ...(reply_to ? { replyTo: reply_to } : {}) }) }),
      }),
      new_conversation: tool({
        description: 'Open a new conversation on your own initiative and post the first message (a notification, a heads-up about something you noticed). Use sparingly.',
        inputSchema: z.object({ title: z.string().min(1).max(40), text: z.string().min(1) }),
        execute: async ({ title, text }, { toolCallId }) => {
          const id = engine.openConversation(title)
          engine.reply({ conversationId: id, text, callId: toolCallId })
          return { ok: true, conversation_id: id }
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
    onTurnError: (_s, error) => console.error('[router] turn failed:', error instanceof Error ? error.message : error),
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
        return [`<report ticket_id="${t.id}" title="${t.title}" status="${p.status}" conversation_id="${engine.conversationOfThread(t.threadId) ?? ''}" origin="${sourceOfThread(t.threadId)}">`,
          clip(p.summary, 3_000), p.humanAction ? `human_action: ${JSON.stringify(p.humanAction)}${answered ? ' (already answered by the owner — do not forward it)' : ''}` : '', '</report>'].filter(Boolean).join('\n')
      }
      case 'approval': {
        let title = p.ticketId
        try { title = engine.ticket(p.ticketId).title } catch { /* gone */ }
        return `<approval approval_id="${p.approvalId}" ticket_id="${p.ticketId}" title="${title}" conversation_id="${(() => { try { return engine.conversationOfThread(engine.ticket(p.ticketId).threadId) ?? '' } catch { return '' } })()}">\nThe worker wants to run: ${String(p.command).slice(0, 500)}\nWhy it needs the owner: ${p.reason}\n</approval>`
      }
      case 'ticket-ended': return `<task_ended ticket_id="${p.ticketId}" outcome="${p.outcome}" by="${p.by}" />`
      case 'recovery': return '<recovery>服务刚刚重启。检查 list_tasks，不要重复已经发出的消息或已经开始的任务。</recovery>'
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
      const extra = [ext.workerPrompt?.(ticket), ext.sharedPrompt?.('worker', ticket)].filter(Boolean).join('\n\n')
      return `${WORKER_PROMPT}${extra ? `\n\n${extra}` : ''}\n\n## Environment\n- Working directory: ${ticket.directory}\n- Task id: ${ticket.id}\n- OS: ${process.platform}\n- Now: ${new Date().toString()}`
    },
    formatInbox: (items, session) => items.map(item => renderWorkerItem(item, session.ticketId!)).join('\n\n'),
    tools: ctx => {
      const ticket = engine.ticket(ctx.session.ticketId!)
      const exec = engine.execution()
      return {
        ...fsTools(ticket.directory, runtime.blobs),
        ...shellTools(runtime.jobs, runtime.blobs, {
          sessionId: ctx.session.id, cwd: ticket.directory, signal: ctx.signal, blocked: exec.blockedCommands,
          env: workerEnv({ SUPERAGENT_TICKET: ticket.id, SUPERAGENT_DIR: ticket.directory, ...(ext.workerEnv?.(ticket) ?? {}) }),
          foregroundMs: exec.foregroundSeconds * 1000, timeoutMs: exec.timeoutMinutes * 60_000,
          ...(ext.gateShell ? { gate: (command: string) => ext.gateShell!(ticket, ctx.session.id, command, ticket.directory) } : {}),
          ...(ext.wrapShell?.(ticket) ? { wrap: ext.wrapShell(ticket)! } : {}),
        }),
        ...webTools(runtime.blobs),
        ...recallTool(runtime),
        ...(ext.workerTools?.(ticket, ctx) ?? {}),
        report: tool({
          description: 'Report this task\'s state to the main agent. Required once at the end of every turn.',
          inputSchema: z.object({
            status: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
            summary: z.string().min(1),
            human_action: z.object({ question: z.string().min(1), options: z.array(z.string()).max(6).optional() }).optional()
              .describe('One concrete question for the owner, with status waiting'),
          }),
          execute: async ({ status, summary, human_action }) => {
            engine.report(ticket.id, { status, summary, ...(human_action ? { humanAction: human_action } : {}) })
            reportedThisTurn.add(ctx.session.id)
            return { ok: true, note: status === 'ready' || status === 'dropped' ? 'Task ended. Finish your turn now.' : 'Recorded. End your turn unless you have more to do now.' }
          },
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

  function renderWorkerItem(item: InboxItem, ticketId: string): string {
    const p = item.payload
    switch (p.type) {
      case 'assignment': {
        const t = engine.ticket(ticketId)
        if (p.reason === 'start') {
          const origin = store.db.select().from(schema.triggers).where(inArray(schema.triggers.id, t.origin.triggerIds)).orderBy(asc(schema.triggers.at)).all()
          const cnv = engine.conversationOfThread(t.threadId) ?? ''
          const info = sourceOfThread(t.threadId) !== 'webchat' ? ext.threadInfo?.(t.threadId) : undefined
          return [`<assignment task_id="${t.id}" title="${t.title}" conversation_id="${cnv}" source="${sourceOfThread(t.threadId)}">`,
            info ? `thread: ${info}` : '',
            t.note ? `routing note: ${t.note}` : '',
            cnv ? `conversation context before the request:\n${recent(cnv, origin[0]?.at) || '  （无）'}` : '',
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
          const url = (trigger.meta as { url?: string }).url
          return `<message trigger_id="${p.triggerId}" source="${trigger.source}" from="${trigger.actor}"${trigger.human ? '' : ' bot="true"'}${url ? ` url="${url}"` : ''}${p.note ? ` routing_note="${String(p.note).replace(/"/g, "'")}"` : ''}>\n${trigger.text}\n</message>`
        }
        return `<owner_message trigger_id="${p.triggerId}"${p.note ? ` routing_note="${String(p.note).replace(/"/g, "'")}"` : ''}>\n${trigger?.text ?? ''}\n</owner_message>`
      }
      case 'note': return `<note from="${p.from ?? 'main agent'}">${p.text}</note>`
      case 'approval': return p.status === 'approved'
        ? `<approval approval_id="${p.approvalId}" status="approved">主人批准了：${p.command}${p.note ? `（备注：${p.note}）` : ''}。命令已在后台开始运行，结果会以 job_finished 送达。</approval>`
        : `<approval approval_id="${p.approvalId}" status="denied">主人拒绝了：${p.command}${p.note ? `（理由：${p.note}）` : ''}。不要再尝试这条命令或它的变体；调整方案，或用 report 说明。</approval>`
      case 'job': return `<job_finished job_id="${p.jobId}" status="${p.status}"${p.exitCode !== undefined ? ` exit_code="${p.exitCode}"` : ''} command="${String(p.command).replace(/"/g, "'").slice(0, 200)}">\n${p.output ?? ''}\n</job_finished>`
      default: return `<event>${JSON.stringify(p)}</event>`
    }
  }

  runtime.register(router)
  runtime.register(worker)
  return { reportedThisTurn }
}

export { DomainError, STAGE_LABEL }

/** Merges several extension sets (sources, memory, review) into one. */
export function combineExtensions(...exts: AgentExtensions[]): AgentExtensions {
  const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join('\n\n')
  const gate = exts.find(e => e.gateShell)?.gateShell
  const wrap = exts.find(e => e.wrapShell)?.wrapShell
  return {
    routerPrompt: () => join(exts.map(e => e.routerPrompt?.())),
    routerTools: () => Object.assign({}, ...exts.map(e => e.routerTools?.() ?? {})),
    workerPrompt: t => join(exts.map(e => e.workerPrompt?.(t))),
    workerTools: (t, ctx) => Object.assign({}, ...exts.map(e => e.workerTools?.(t, ctx) ?? {})),
    workerEnv: t => Object.assign({}, ...exts.map(e => e.workerEnv?.(t) ?? {})),
    threadInfo: id => exts.map(e => e.threadInfo?.(id)).find(Boolean),
    sharedPrompt: (role, t) => join(exts.map(e => e.sharedPrompt?.(role, t))),
    ...(gate ? { gateShell: gate } : {}),
    ...(wrap ? { wrapShell: wrap } : {}),
  }
}

/** Memory for both agents: the prompt section and remember / forget / search_memory. */
export function memoryExtension(memory: Memory, engine: Engine): AgentExtensions {
  return {
    sharedPrompt: (_role, ticket) => memory.prompt(ticket ? engine.projectOf(ticket) : undefined),
    routerTools: () => memory.tools(() => 'router'),
    workerTools: ticket => memory.tools(() => ticket.id, () => engine.projectOf(ticket)),
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
