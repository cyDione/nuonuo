/**
 * Turns bus events into what browsers need over SSE. The router's `reply` tool input is parsed while it streams, so the
 * owner sees the answer being written instead of waiting for the whole tool call.
 */
import type { BusEvent } from '@nuonuo/agent-runtime'

/** Substantive Router action tools that create virtual `act_<callId>` activity items. */
export const ROUTER_ACTION_TOOLS = new Set([
  'update_my_settings',
  'update_instructions',
  'update_proactive',
  'schedule_routine',
  'update_routine',
  'remember',
  'propose_skill',
])

export function isRouterActionTool(tool: unknown): boolean {
  return typeof tool === 'string' && ROUTER_ACTION_TOOLS.has(tool)
}

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
  | { type: 'settings.updated'; keys: string[] }
  | { type: 'prefs.updated'; patch: Record<string, unknown> }
  | { type: 'notice'; id: string; kind: string; title: string; body: string; hash: string; silent: boolean; chime: boolean }

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
  private pendingRouterActionId: string | null = null

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
      case 'settings.updated': return [{ type: 'settings.updated', keys: Array.isArray(e.keys) ? e.keys.map(String) : [] }]
      case 'prefs.updated': return [{ type: 'prefs.updated', patch: e.patch && typeof e.patch === 'object' ? (e.patch as Record<string, unknown>) : {} }]
      case 'notice': return [{ type: 'notice', id: e.id, kind: e.kind, title: e.title, body: e.body, hash: e.hash, silent: e.silent, chime: e.chime }]
      case 'approval.updated': return [{ type: 'ticket.updated', ticketId: e.ticketId }]
      // A subagent's state and text belong to its parent's work; the web shows only the helper itself.
      case 'session.state': return e.role === 'subagent' ? [] : [{ type: 'session.state', role: e.role, sessionId: e.sessionId, ticketId: e.ticketId, state: e.state }]
      case 'session.message': {
        if (e.role === 'worker' && e.ticketId) {
          return [{ type: 'ticket.updated', ticketId: e.ticketId }]
        }
        if (e.role === 'router' && this.pendingRouterActionId) {
          const actionId = this.pendingRouterActionId
          this.pendingRouterActionId = null
          return [{ type: 'ticket.updated', ticketId: actionId }, { type: 'activity.updated' }]
        }
        return []
      }
      case 'session.part': {
        const part = e.part
        // Router and watchdog replies are shown only as complete messages once saved (message.created), never streamed as partial bubbles.
        // Substantive Router action tools (`update_my_settings`, `remember`, etc.) notify the UI so the Activity tab refreshes immediately.
        if (e.role === 'router') {
          if ((part?.kind === 'tool-call' || part?.kind === 'tool-result') && isRouterActionTool(part?.tool)) {
            const actionId = `act_${part.id}`
            this.pendingRouterActionId = actionId
            if (part.kind === 'tool-result') {
              return [{ type: 'ticket.updated', ticketId: actionId }, { type: 'activity.updated' }]
            }
          }
          return []
        }
        if (e.role === 'watchdog') return []
        if (e.ticketId && e.role === 'worker') {
          if (part?.kind === 'tool-call' || part?.kind === 'tool-result') {
            return [{ type: 'worker.part', ticketId: e.ticketId, part }, { type: 'ticket.updated', ticketId: e.ticketId }]
          }
          return [{ type: 'worker.part', ticketId: e.ticketId, part }]
        }
        return []
      }
      default: return []
    }
  }
}
