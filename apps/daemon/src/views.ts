/** Shapes the domain for the web UI: ticket rows, a ticket's page with its worker transcript, and what waits for the owner. */
import type { AgentRuntime } from '@super-agent/agent-runtime'
import { conversationOf, STAGE_LABEL, type Engine, type Ticket } from '@super-agent/core'
import { schema, type Store } from '@super-agent/db'
import { desc, eq } from 'drizzle-orm'

export function ticketView(engine: Engine, t: Ticket) {
  const stage = engine.stage(t)
  return {
    id: t.id, title: t.title, name: t.name, note: t.note, stage, stageLabel: STAGE_LABEL[stage],
    conversationId: conversationOf(t.threadId) ?? null, directory: t.directory,
    latestReport: t.latestReport, attention: t.attention, ended: t.ended, createdAt: t.createdAt, updatedAt: t.updatedAt,
  }
}
export type TicketView = ReturnType<typeof ticketView>

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字符）` : s)

/** A worker session's events as display items; tool outputs are clipped (the full text stays in the session log). */
export function transcript(agents: AgentRuntime, sessionId: string) {
  const items: { id: string; kind: string; [k: string]: unknown }[] = []
  for (const event of agents.events(sessionId)) {
    if (event.kind === 'marker') { items.push({ id: `${event.id}`, kind: 'marker', ...event.payload, at: event.at }); continue }
    if (event.kind === 'compaction') { items.push({ id: `${event.id}`, kind: 'compaction', summary: event.payload.summary, at: event.at }); continue }
    const m = event.payload
    if (m.role === 'user') { items.push({ id: `${event.id}`, kind: 'input', text: clip(String(m.content), 6_000), at: event.at }); continue }
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    parts.forEach((p: any, i: number) => {
      const id = `${event.id}.${i}`
      if (p.type === 'text' && p.text) items.push({ id, kind: 'text', text: p.text, at: event.at })
      else if (p.type === 'reasoning' && p.text) items.push({ id, kind: 'reasoning', text: clip(p.text, 4_000), at: event.at })
      else if (p.type === 'tool-call') items.push({ id, kind: 'tool-call', callId: p.toolCallId, tool: p.toolName, input: p.input, at: event.at })
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
