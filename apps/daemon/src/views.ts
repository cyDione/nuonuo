/** Shapes the domain for the web UI: ticket rows, a ticket's page with its worker transcript, and what waits for the owner. */
import type { AgentRuntime } from '@nuonuo/agent-runtime'
import { canGrant, cleanSpokenBubbles, sourceOfThread, STAGE_LABEL, type Engine, type Ticket } from '@nuonuo/core'
import { schema, type Store } from '@nuonuo/db'
import { desc, eq } from 'drizzle-orm'
import { parseMarkerInput, summarizeTranscriptSteps, type CurrentStep, type StepIconKind } from './activity-runs'

export function ticketView(
  engine: Engine,
  t: Ticket,
  approvals: { id: string; tool: string; input: Record<string, unknown>; reason: string; risk: string; createdAt: number }[] = [],
  agents?: AgentRuntime,
) {
  const stage = engine.stage(t)
  const rtAgents = agents ?? (engine as unknown as { runtime?: AgentRuntime }).runtime
  const items = rtAgents ? transcript(rtAgents, t.sessionId) : []
  const { stepCount, currentStep, iconKind } = summarizeTranscriptSteps(items, {
    workDir: t.directory,
    stage,
    endedOutcome: t.ended?.outcome ?? null,
    isSessionRunning: rtAgents ? rtAgents.isRunning(t.sessionId) : false,
  })
  const runningJobs = rtAgents ? rtAgents.jobs.running(t.sessionId).length : 0
  return {
    approvals: approvals.map(a => ({ id: a.id, command: String(a.input.command ?? ''), reason: a.reason, risk: a.risk, createdAt: a.createdAt, card: (a.input.card as object | undefined) ?? null, standing: canGrant(a) })),
    id: t.id,
    kind: 'ticket' as 'ticket' | 'action',
    title: t.title,
    name: t.name,
    note: t.note,
    stage,
    stageLabel: STAGE_LABEL[stage],
    conversationId: engine.conversationOfThread(t.threadId) ?? null,
    source: sourceOfThread(t.threadId),
    directory: t.directory,
    latestReport: t.latestReport,
    attention: t.attention,
    ended: t.ended,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    proactive: t.mandate.strength === 'proactive',
    why: t.mandate.reason ?? null,
    stepCount,
    currentStep: currentStep as CurrentStep | null,
    iconKind: iconKind as StepIconKind,
    runningJobs,
  }
}
export type TicketView = ReturnType<typeof ticketView>

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字符）` : s)

/** A worker session's events as display items; tool outputs are clipped (the full text stays in the session log). */
export function transcript(agents: AgentRuntime, sessionId: string) {
  const rawEvents = agents.events(sessionId)
  const endedMarkerIds = new Set<number>()
  const messageCallIds = new Set<string>()
  for (const event of rawEvents) {
    if (event.kind === 'marker' && event.payload?.type === 'tool-end' && typeof event.payload.start === 'number') {
      endedMarkerIds.add(event.payload.start)
    } else if (event.kind === 'message') {
      const m = event.payload
      if (Array.isArray(m?.content)) {
        for (const p of m.content) {
          if (p?.type === 'tool-call' && p.toolCallId) messageCallIds.add(String(p.toolCallId))
        }
      }
    }
  }
  const sessionRunning = agents.isRunning(sessionId)
  const items: { id: string; kind: string; [k: string]: unknown }[] = []
  for (const event of rawEvents) {
    if (event.kind === 'marker') {
      items.push({ id: `${event.id}`, kind: 'marker', ...event.payload, at: event.at })
      if (event.payload?.type === 'tool-start') {
        const callId = String(event.payload.callId ?? `call_${event.id}`)
        if (!messageCallIds.has(callId) && (!endedMarkerIds.has(event.id) || sessionRunning)) {
          const parsedInput = parseMarkerInput(event.payload.input)
          items.push({
            id: `${event.id}.0`,
            kind: 'tool-call',
            callId,
            tool: String(event.payload.tool ?? ''),
            input: parsedInput,
            at: event.at,
          })
          if (endedMarkerIds.has(event.id)) {
            items.push({
              id: `${event.id}.1`,
              kind: 'tool-result',
              callId,
              tool: String(event.payload.tool ?? ''),
              output: '',
              at: event.at,
            })
          }
        }
      }
      continue
    }
    if (event.kind === 'compaction') { items.push({ id: `${event.id}`, kind: 'compaction', summary: event.payload.summary, at: event.at }); continue }
    const m = event.payload
    if (m.role === 'user') { items.push({ id: `${event.id}`, kind: 'input', text: clip(String(m.content), 6_000), at: event.at }); continue }
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    parts.forEach((p: any, i: number) => {
      const id = `${event.id}.${i}`
      if (p.type === 'text' && p.text) items.push({ id, kind: 'text', text: p.text, at: event.at })
      else if (p.type === 'reasoning' && p.text) items.push({ id, kind: 'reasoning', text: clip(p.text, 4_000), at: event.at })
      else if (p.type === 'tool-call') items.push({ id, kind: 'tool-call', callId: p.toolCallId, tool: p.toolName, input: p.input, ...(Array.isArray(p.input?.bubbles) ? { bubbles: cleanSpokenBubbles(p.input.bubbles) } : {}), at: event.at })
      else if (p.type === 'tool-result') {
        const v = p.output?.type === 'json' || p.output?.type === 'text' ? p.output.value : p.output?.type === 'error-text' || p.output?.type === 'error-json' ? { error: p.output.value } : p.output
        items.push({ id, kind: 'tool-result', callId: p.toolCallId, tool: p.toolName, output: clip(typeof v === 'string' ? v : JSON.stringify(v, null, 1), 4_000), at: event.at })
      }
    })
  }
  return items
}

export function reportsOf(store: Store, ticketId: string) {
  return store.db.select().from(schema.reports).where(eq(schema.reports.ticketId, ticketId)).orderBy(desc(schema.reports.at)).limit(50).all()
}

/** What became of an event, in plain words for the activity log. */
export function dispositionText(d: Record<string, any>): { tone: 'ok' | 'muted' | 'warn' | 'accent'; text: string } {
  if (d.startedTicket) return { tone: 'accent', text: d.proactive ? `主动处理：${d.proactive.reason ?? ''}` : '开始处理' }
  if (d.deliveredTo?.length) return { tone: 'ok', text: '交给了正在进行的事' }
  if (d.attachedTo) return { tone: 'ok', text: '并入了已有的事' }
  if (d.answered) return { tone: 'ok', text: '已回复' }
  if (d.screening) return { tone: 'muted', text: '正在判断是否值得处理…' }
  if (d.proactive) return d.proactive.act
    ? { tone: 'warn', text: `${d.proactive.mode === 'observe' ? '观察模式：本来会处理' : '值得处理'} —— ${d.proactive.reason}` }
    : { tone: 'muted', text: `不处理：${d.proactive.reason}` }
  if (d.ignored === 'router') return { tone: 'muted', text: `无需处理：${d.reason ?? ''}` }
  if (d.handedBack?.length) return { tone: 'muted', text: '转回给主 Agent' }
  const why: Record<string, string> = { bot: '机器人消息', not_allowed: '不是你或允许的账号', not_addressed: '没有找我', proactive_off: '主动处理已关闭',
    source_not_watched: '这个来源不在主动关注范围内', actor_ignored: '已忽略的账号', empty: '空消息', internal: '内部事件', no_screener: '没有主动处理' }
  if (d.ignored) return { tone: 'muted', text: `未处理：${why[d.ignored] ?? d.ignored}${d.fastPath && d.fastPath !== 'proactive_off' ? `（${why[d.fastPath] ?? d.fastPath}）` : ''}` }
  return { tone: 'muted', text: '已收到' }
}
