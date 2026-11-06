/** One EventSource per tab: keeps react-query caches fresh and holds the transient state (streaming replies, live worker text). */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import type { ServerEvent } from './api'

interface LiveState {
  connected: boolean
  routerState: string
  /** Streaming router replies by conversation. */
  drafts: Record<string, { callId: string; text: string }>
  /** Text the worker is writing in its current step, by ticket. */
  workerText: Record<string, string>
  workerState: Record<string, string>
}

let state: LiveState = { connected: false, routerState: 'idle', drafts: {}, workerText: {}, workerState: {} }
const listeners = new Set<() => void>()
const set = (patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) => {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }

export function useLive<T>(select: (s: LiveState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state))
}

export function clearDraft(conversationId: string, callId?: string) {
  if (!state.drafts[conversationId] || (callId && state.drafts[conversationId]!.callId !== callId)) return
  set(s => { const drafts = { ...s.drafts }; delete drafts[conversationId]; return { drafts } })
}

export function useLiveEvents() {
  const qc = useQueryClient()
  useEffect(() => {
    let source: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const soon = (key: string, fn: () => void, ms = 300) => {
      if (timers.has(key)) return
      timers.set(key, setTimeout(() => { timers.delete(key); fn() }, ms))
    }
    const connect = () => {
      source = new EventSource('/api/events')
      source.addEventListener('ready', () => {
        set({ connected: true })
        // Anything may have changed while disconnected.
        qc.invalidateQueries()
      })
      source.addEventListener('message', ev => handle(JSON.parse((ev as MessageEvent).data) as ServerEvent))
      source.onerror = () => {
        set({ connected: false })
        source?.close()
        retry = setTimeout(connect, 2_000)
      }
    }
    const handle = (e: ServerEvent) => {
      switch (e.type) {
        case 'message.created':
          void maybeNotify(e.conversationId, e.messageId)
          void qc.invalidateQueries({ queryKey: ['messages', e.conversationId] }).then(() => clearDraftAfterMessage(e.conversationId))
          soon('conversations', () => qc.invalidateQueries({ queryKey: ['conversations'] }))
          break
        case 'conversation.updated':
          qc.invalidateQueries({ queryKey: ['conversations'] })
          break
        case 'persona.updated':
          qc.invalidateQueries({ queryKey: ['persona'] })
          break
        case 'goals.updated':
          qc.invalidateQueries({ queryKey: ['goals'] })
          break
        case 'feed.updated':
          qc.invalidateQueries({ queryKey: ['feed'] })
          break
        case 'activity.updated':
          soon('activity', () => qc.invalidateQueries({ queryKey: ['activity'] }), 500)
          break
        case 'reply.delta':
          set(s => ({ drafts: { ...s.drafts, [e.conversationId]: { callId: e.callId, text: e.text } } }))
          break
        case 'ticket.updated':
          soon(`ticket:${e.ticketId}`, () => {
            qc.invalidateQueries({ queryKey: ['tickets'] })
            qc.invalidateQueries({ queryKey: ['ticket', e.ticketId] })
            qc.invalidateQueries({ queryKey: ['inbox'] })
            qc.invalidateQueries({ queryKey: ['activity'] })
            qc.invalidateQueries({ queryKey: ['artifacts'] })
            qc.invalidateQueries({ queryKey: ['grants'] })
          }, 150)
          break
        case 'session.state':
          if (e.role === 'router') set({ routerState: e.state })
          else if (e.ticketId) {
            set(s => ({ workerState: { ...s.workerState, [e.ticketId!]: e.state }, ...(e.state !== 'running' ? { workerText: { ...s.workerText, [e.ticketId!]: '' } } : {}) }))
            soon(`ticket:${e.ticketId}`, () => { qc.invalidateQueries({ queryKey: ['tickets'] }); qc.invalidateQueries({ queryKey: ['ticket', e.ticketId] }) }, 150)
          }
          break
        case 'worker.part': {
          const { part, ticketId } = e
          if (part.kind === 'text' || part.kind === 'reasoning') set(s => ({ workerText: { ...s.workerText, [ticketId]: (s.workerText[ticketId] ?? '') + (part.delta ?? '') } }))
          if (part.kind === 'step-start') set(s => ({ workerText: { ...s.workerText, [ticketId]: '' } }))
          if (part.kind === 'tool-call' || part.kind === 'tool-result' || part.kind === 'step-start') soon(`transcript:${ticketId}`, () => qc.invalidateQueries({ queryKey: ['ticket', ticketId] }), 400)
          break
        }
      }
    }
    const clearDraftAfterMessage = (conversationId: string) => {
      const draft = state.drafts[conversationId]
      if (!draft) return
      const data = qc.getQueryData<{ messages: { meta: Record<string, any> }[] }>(['messages', conversationId])
      if (data?.messages.some(m => m.meta?.callId === draft.callId)) clearDraft(conversationId)
    }
    connect()
    return () => { source?.close(); clearTimeout(retry); for (const t of timers.values()) clearTimeout(t) }
  }, [qc])
}

// ── UI state shared across components ──────────────────────────────────────
let activityOpen = false
const activityListeners = new Set<() => void>()
/** The activity panel (Muse: tap the avatar to see what it is doing and what you allowed). */
export function openActivity(open: boolean) { activityOpen = open; for (const l of activityListeners) l() }
export function useActivityOpen(): boolean {
  return useSyncExternalStore(l => { activityListeners.add(l); return () => activityListeners.delete(l) }, () => activityOpen)
}

let openTaskId: string | null = null
const uiListeners = new Set<() => void>()
export function openTask(id: string | null) { openTaskId = id; for (const l of uiListeners) l() }
export function useOpenTask(): string | null {
  return useSyncExternalStore(l => { uiListeners.add(l); return () => uiListeners.delete(l) }, () => openTaskId)
}

// ── Desktop notifications for what the agent says while the tab is hidden ──
export const notificationsEnabled = () => { try { return localStorage.getItem('sa-notify') === '1' } catch { return false } }
export async function setNotifications(on: boolean): Promise<boolean> {
  if (on && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
    if ((await Notification.requestPermission()) !== 'granted') return false
  }
  try { localStorage.setItem('sa-notify', on ? '1' : '0') } catch { /* private mode */ }
  return on
}
const notified = new Set<string>()
async function maybeNotify(conversationId: string, messageId: string) {
  // Inside the desktop app, the app shows native notifications itself.
  if ((window as { superAssistantDesktop?: unknown }).superAssistantDesktop) return
  if (!notificationsEnabled() || document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (notified.has(messageId)) return
  notified.add(messageId)
  try {
    const res = await fetch(`/api/messages/${messageId}`, { credentials: 'same-origin' })
    const { message } = await res.json() as { message: { role: string; content: string; meta: Record<string, any> } }
    const fromOwner = message.role === 'user' && (message.meta.source ?? 'webchat') === 'webchat'
    if (fromOwner || message.role === 'event' || message.meta.delivery) return
    const n = new Notification(message.role === 'assistant' ? 'Super-assistant' : `${message.meta.actor ?? message.meta.source}`, { body: message.content.slice(0, 160), tag: conversationId })
    n.onclick = () => { window.focus(); location.hash = `/c/${conversationId}`; n.close() }
  } catch { /* best effort */ }
}
