/**
 * Turns bus events into what browsers need over SSE. The router's `reply` tool input is parsed while it streams, so the
 * owner sees the answer being written instead of waiting for the whole tool call.
 */
import type { BusEvent } from '@super-assistant/agent-runtime'

export type ClientEvent =
  | { type: 'message.created'; conversationId: string; messageId: string }
  | { type: 'message.updated'; conversationId: string; messageId: string }
  | { type: 'reply.delta'; conversationId: string; callId: string; text: string }
  | { type: 'ticket.updated'; ticketId: string }
  | { type: 'session.state'; role: string; sessionId: string; ticketId?: string | null; state: string }
  | { type: 'worker.part'; ticketId: string; part: unknown }
  | { type: 'conversation.updated'; conversationId: string }
  | { type: 'activity.updated' }
  | { type: 'persona.updated' }
  | { type: 'goals.updated' }
  | { type: 'skills.updated' }
  | { type: 'feed.updated' }
  | { type: 'ideas.updated' }
  | { type: 'notice'; id: string; kind: string; title: string; body: string; hash: string; silent: boolean }

/** Reads a possibly unfinished JSON object's string field, e.g. `"text":"hel` → `hel`. */
export function partialString(json: string, field: string): string | undefined {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(json)
  if (!m) return undefined
  let out = ''
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const ch = json[i]!
    if (ch === '"') return out
    if (ch !== '\\') { out += ch; continue }
    const next = json[i + 1]
    if (next === undefined) return out
    if (next === 'u') {
      const hex = json.slice(i + 2, i + 6)
      if (hex.length < 4) return out
      out += String.fromCharCode(parseInt(hex, 16)); i += 5; continue
    }
    out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next
    i++
  }
  return out
}

export class EventMapper {
  private replies = new Map<string, string>()

  map(event: BusEvent): ClientEvent[] {
    const e = event as any
    switch (event.type) {
      case 'message.created': return [{ type: 'message.created', conversationId: e.conversationId, messageId: e.messageId }]
      case 'message.updated': return [{ type: 'message.updated', conversationId: e.conversationId, messageId: e.messageId }]
      case 'conversation.updated': return [{ type: 'conversation.updated', conversationId: e.conversationId }]
      case 'ticket.updated': return [{ type: 'ticket.updated', ticketId: e.ticketId }]
      case 'activity.updated': return [{ type: 'activity.updated' }]
      case 'persona.updated': return [{ type: 'persona.updated' }]
      case 'goals.updated': return [{ type: 'goals.updated' }]
      case 'skills.updated': return [{ type: 'skills.updated' }]
      case 'feed.updated': return [{ type: 'feed.updated' }]
      case 'ideas.updated': return [{ type: 'ideas.updated' }]
      case 'notice': return [{ type: 'notice', id: e.id, kind: e.kind, title: e.title, body: e.body, hash: e.hash, silent: e.silent }]
      case 'approval.updated': return [{ type: 'ticket.updated', ticketId: e.ticketId }]
      // A subagent's state and text belong to its parent's work; the web shows only the helper itself.
      case 'session.state': return e.role === 'subagent' ? [] : [{ type: 'session.state', role: e.role, sessionId: e.sessionId, ticketId: e.ticketId, state: e.state }]
      case 'session.part': {
        const part = e.part
        if (e.role === 'router') {
          if (part.kind === 'tool-input-start' && part.tool === 'reply') { this.replies.set(part.id, ''); return [] }
          if (part.kind === 'tool-input-delta' && this.replies.has(part.id)) {
            const json = this.replies.get(part.id)! + part.delta
            this.replies.set(part.id, json)
            const conversationId = partialString(json, 'conversation_id')
            const text = partialString(json, 'text')
            // Only once the conversation id is complete (the text field follows it, or it closed).
            if (conversationId && text !== undefined && /"conversation_id"\s*:\s*"[^"]*"/.test(json)) {
              return [{ type: 'reply.delta', conversationId, callId: part.id, text }]
            }
            return []
          }
          if (part.kind === 'tool-call' || part.kind === 'tool-result') this.replies.delete(part.id)
          return []
        }
        if (e.ticketId && e.role === 'worker') return [{ type: 'worker.part', ticketId: e.ticketId, part }]
        // The watchdog's notify_owner streams like the router's reply.
        if (e.role === 'watchdog') return []
        return []
      }
      default: return []
    }
  }
}
