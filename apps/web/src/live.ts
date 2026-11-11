/** One EventSource per tab: keeps react-query caches fresh and holds the transient state (streaming replies, live worker text). */
import { useQueryClient } from '@tanstack/react-query'
import { playChime } from './sounds'
import { useEffect, useSyncExternalStore } from 'react'
import type { Notice, ServerEvent } from './api'
import { getPrefs } from './prefs'
import { speak } from './voice'

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
          void readAloud(e.conversationId, e.messageId)
          void qc.invalidateQueries({ queryKey: ['messages', e.conversationId] }).then(() => clearDraftAfterMessage(e.conversationId))
          soon('conversations', () => qc.invalidateQueries({ queryKey: ['conversations'] }))
          break
        case 'message.updated':
          qc.invalidateQueries({ queryKey: ['messages', e.conversationId] })
          break
        case 'conversation.updated':
          qc.invalidateQueries({ queryKey: ['conversations'] })
          break
        case 'notice':
          showNotice(e)
          break
        case 'persona.updated':
          qc.invalidateQueries({ queryKey: ['persona'] })
          break
        case 'goals.updated':
          qc.invalidateQueries({ queryKey: ['goals'] })
          break
        case 'ideas.updated':
          qc.invalidateQueries({ queryKey: ['ideas'] })
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
/** The service decided this is worth a banner (设置 → 通知). A browser tab shows it while in the background; the desktop app shows its own. */
function showNotice(n: Notice) {
  if ((window as { nuonuoDesktop?: unknown }).nuonuoDesktop) return
  if (!notificationsEnabled() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (n.kind !== 'test' && document.visibilityState === 'visible') return
  try {
    const note = new Notification(n.title || 'Nuonuo', { body: n.body, tag: n.id, silent: n.silent })
    if (n.chime) playChime(n.kind)
    note.onclick = () => { window.focus(); location.hash = n.hash; note.close() }
  } catch { /* best effort */ }
}

/** 设置 → 语音 → 把回复读出来: what it says in the chat on screen. */
async function readAloud(conversationId: string, messageId: string) {
  if (!getPrefs().readAloud || document.visibilityState !== 'visible' || typeof speechSynthesis === 'undefined') return
  const hash = location.hash.replace(/^#\/?/, '')
  const here = hash.match(/^c\/([^/]+)/)?.[1]
  if (!here && hash !== '') return
  try {
    if (here && here !== conversationId) return
    const res = await fetch(`/api/messages/${messageId}`, { credentials: 'same-origin' })
    const { message } = await res.json() as { message: { role: string; content: string; conversationId: string; meta: Record<string, any> } }
    if (message.role !== 'assistant' || message.meta.delivery) return
    if (!here) { const main = await fetch('/api/conversations/main', { credentials: 'same-origin' }).then(r => r.json()) as { id: string }; if (main.id !== conversationId) return }
    speak(message.content)
  } catch { /* best effort */ }
}
