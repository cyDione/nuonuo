/** The router and worker agent definitions: tool sets (enforced by code, not prompt) and how their inbox items read. */
import { fsTools, recallTool, shellTools, webTools, workerEnv, type AgentDefinition, type AgentRuntime, type InboxItem } from '@super-agent/agent-runtime'
import { schema, type Store } from '@super-agent/db'
import { tool } from 'ai'
import { asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { clip, DomainError, Engine, ROUTER_SESSION } from './engine'
import { conversationOf, STAGE_LABEL, webchatThread } from './model'
import { ROUTER_PROMPT, WORKER_PROMPT } from './prompts'

const CONTEXT_MESSAGES = 6

export function registerAgents(store: Store, runtime: AgentRuntime, engine: Engine): { reportedThisTurn: Set<string> } {
  const reportedThisTurn = new Set<string>()
  runtime.createSession('router', 'router', { id: ROUTER_SESSION })

  const conversationTitle = (id: string) => store.db.select({ t: schema.conversations.title }).from(schema.conversations).where(eq(schema.conversations.id, id)).get()?.t ?? ''

  /** Recent messages of a conversation as compact lines (Inline & Spill: long ones clipped, full text via recall). */
  const recent = (conversationId: string, before?: number, n = CONTEXT_MESSAGES) => {
    const rows = store.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.createdAt)).limit(n + 1).all().filter(m => before === undefined || m.createdAt < before).slice(0, n).reverse()
    return rows.map(m => {
      if (m.role === 'event') return `  [task card ${m.ticketId}: ${m.content}]`
      const who = m.role === 'user' ? 'owner' : 'agent'
      return `  ${who}${m.triggerId ? ` (${m.triggerId})` : ''}: ${clip(m.content.replace(/\s+/g, ' '), 300)}`
    }).join('\n')
  }

  const tasksIn = (conversationId: string) => engine.tickets({ threadId: webchatThread(conversationId) }).slice(0, 8)
    .map(t => `  - ${t.id} "${t.title}" ${t.ended ? `ended:${t.ended.outcome}` : engine.stage(t)}`).join('\n')

  const triggerCard = (triggerId: string, tag = 'message', extra = '') => {
    const trigger = store.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    if (!trigger) return `<${tag} trigger_id="${triggerId}">（已不存在）</${tag}>`
    const cnv = conversationOf(trigger.threadId) ?? ''
    const tasks = cnv ? tasksIn(cnv) : ''
    return [`<${tag} trigger_id="${trigger.id}" conversation_id="${cnv}" conversation="${conversationTitle(cnv)}" at="${new Date(trigger.at).toISOString()}"${extra}>`,
      cnv ? `recent context:\n${recent(cnv, trigger.at) || '  （新对话）'}` : '',
      tasks ? `tasks in this conversation:\n${tasks}` : '',
      `text:\n${trigger.text}`, `</${tag}>`].filter(Boolean).join('\n')
  }

  runtime.registerResolver('tkt', ref => { try { return engine.describeTicket(engine.ticket(ref)) } catch { return undefined } })
  runtime.registerResolver('trg', ref => {
    const t = store.db.select().from(schema.triggers).where(eq(schema.triggers.id, ref)).get()
    return t && `<trigger id="${t.id}" conversation="${conversationOf(t.threadId)}" at="${new Date(t.at).toISOString()}" disposition='${JSON.stringify(t.disposition)}'>\n${t.text}\n</trigger>`
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
      m.role === 'event' ? `[task card ${m.ticketId}]` : `${m.role === 'user' ? 'owner' : 'agent'}${m.triggerId ? ` (${m.triggerId})` : ''}: ${clip(m.content, 2_000)}`).join('\n')}\n</conversation>`
  })

  // ── Router ────────────────────────────────────────────────────────────────
  const router: AgentDefinition = {
    role: 'router',
    pool: 'router',
    maxSteps: 30,
    system: () => `${ROUTER_PROMPT}\n\nNow: ${new Date().toString()}`,
    formatInbox: items => items.map(item => renderRouterItem(item)).join('\n\n'),
    tools: () => ({
      reply: tool({
        description: 'Post a message to the owner in a conversation. The only way to talk to the owner.',
        inputSchema: z.object({ conversation_id: z.string(), text: z.string().min(1), ticket_id: z.string().optional() }),
        execute: async ({ conversation_id, text, ticket_id }, { toolCallId }) =>
          ({ ok: true, message_id: engine.reply({ conversationId: conversation_id, text, callId: toolCallId, ...(ticket_id ? { ticketId: ticket_id } : {}) }) }),
      }),
      start_task: tool({
        description: 'Start a task: a worker with shell, file and web tools works on the owner\'s original message(s) in its own session. Returns the task id.',
        inputSchema: z.object({
          conversation_id: z.string(),
          trigger_ids: z.array(z.string()).min(1).describe('The owner message(s) this task is for'),
          title: z.string().min(1).max(40).describe("Short title in the owner's language"),
          name: z.string().optional().describe('Optional ascii kebab-case name for the working directory, e.g. "weekly-report"'),
          ack: z.string().optional().describe('One sentence to the owner naming what will be done'),
          note: z.string().max(200).optional().describe('Routing facts only (≤30 words), never a plan'),
          directory: z.string().optional().describe('An existing project directory, only if the owner named one'),
        }),
        execute: async (input, { toolCallId }) => {
          const ticket = engine.startTask({ conversationId: input.conversation_id, triggerIds: input.trigger_ids, title: input.title, callId: toolCallId,
            ...(input.name ? { name: input.name } : {}), ...(input.ack ? { ack: input.ack } : {}), ...(input.note ? { note: input.note } : {}),
            ...(input.directory ? { directory: input.directory } : {}) })
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
          return list.length ? list.map(t => `${t.id} "${t.title}" ${engine.stage(t)} conversation=${conversationOf(t.threadId)}`).join('\n') : '（没有任务）'
        },
      }),
      ...recallTool(runtime),
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
        return [`<report ticket_id="${t.id}" title="${t.title}" status="${p.status}" conversation_id="${conversationOf(t.threadId)}">`,
          clip(p.summary, 3_000), p.humanAction ? `human_action: ${JSON.stringify(p.humanAction)}${answered ? ' (already answered by the owner — do not forward it)' : ''}` : '', '</report>'].filter(Boolean).join('\n')
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
      return `${WORKER_PROMPT}\n\n## Environment\n- Working directory: ${ticket.directory}\n- Task id: ${ticket.id}\n- OS: ${process.platform}\n- Now: ${new Date().toString()}`
    },
    formatInbox: (items, session) => items.map(item => renderWorkerItem(item, session.ticketId!)).join('\n\n'),
    tools: ctx => {
      const ticket = engine.ticket(ctx.session.ticketId!)
      const exec = engine.execution()
      return {
        ...fsTools(ticket.directory, runtime.blobs),
        ...shellTools(runtime.jobs, runtime.blobs, {
          sessionId: ctx.session.id, cwd: ticket.directory, signal: ctx.signal, blocked: exec.blockedCommands,
          env: workerEnv({ SUPERAGENT_TICKET: ticket.id, SUPERAGENT_DIR: ticket.directory }),
          foregroundMs: exec.foregroundSeconds * 1000, timeoutMs: exec.timeoutMinutes * 60_000,
        }),
        ...webTools(runtime.blobs),
        ...recallTool(runtime),
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
          const cnv = conversationOf(t.threadId) ?? ''
          return [`<assignment task_id="${t.id}" title="${t.title}" conversation_id="${cnv}">`,
            t.note ? `routing note: ${t.note}` : '',
            cnv ? `conversation context before the request:\n${recent(cnv, origin[0]?.at) || '  （无）'}` : '',
            `original request from the owner:\n${origin.map(o => `(${o.id}) ${o.text}`).join('\n\n')}`,
            '</assignment>'].filter(Boolean).join('\n')
        }
        if (p.reason === 'resume') return `<resume task_id="${t.id}">任务因主人的新消息恢复（见下一条）。</resume>`
        if (p.reason === 'retry') return `<retry task_id="${t.id}">主人要求重试。先检查工作目录里已有的进度，再继续。</retry>`
        return `<recovery task_id="${t.id}">服务重启打断了上一轮。先检查工作目录和已经做过的操作，不要重复对外操作，然后继续。</recovery>`
      }
      case 'trigger': {
        const trigger = store.db.select().from(schema.triggers).where(eq(schema.triggers.id, p.triggerId)).get()
        return `<owner_message trigger_id="${p.triggerId}"${p.note ? ` routing_note="${String(p.note).replace(/"/g, "'")}"` : ''}>\n${trigger?.text ?? ''}\n</owner_message>`
      }
      case 'note': return `<note from="main agent">${p.text}</note>`
      case 'job': return `<job_finished job_id="${p.jobId}" status="${p.status}"${p.exitCode !== undefined ? ` exit_code="${p.exitCode}"` : ''} command="${String(p.command).replace(/"/g, "'").slice(0, 200)}">\n${p.output ?? ''}\n</job_finished>`
      default: return `<event>${JSON.stringify(p)}</event>`
    }
  }

  runtime.register(router)
  runtime.register(worker)
  return { reportedThisTurn }
}

export { DomainError, STAGE_LABEL }
