/** One EventSource per tab: keeps react-query caches fresh and holds the transient state (streaming replies, live worker text). */
import { useQueryClient } from '@tanstack/react-query'
import { playChime } from './sounds'
import { useEffect, useSyncExternalStore } from 'react'
import type { Conversation, Message, Notice, ServerEvent } from './api'
import { authedFetch, getConnection, streamAuthedSSE, useConnection } from './connection'
import { setUiLanguage, uiLanguage, type UiLanguage } from './i18n'
import { ACCENTS, getPrefs, setPrefs, type AccentId, type Prefs } from './prefs'
import { desktop, type DesktopPrefs } from './shell'
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

export function getLiveState(): LiveState {
  return state
}

export function clearDraft(conversationId: string, callId?: string) {
  if (!state.drafts[conversationId] || (callId && state.drafts[conversationId]!.callId !== callId)) return
  set(s => { const drafts = { ...s.drafts }; delete drafts[conversationId]; return { drafts } })
}

const currentAsset = () =>
  typeof document !== 'undefined' ? document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? undefined : undefined
let bootVersion: string | undefined
let checkingFresh = false

function reloadOnce(target: string) {
  try {
    if (sessionStorage.getItem('nuonuo:reloaded-for') === target) return
    sessionStorage.setItem('nuonuo:reloaded-for', target)
  } catch {
    return
  }
  void fetch(location.pathname + location.search, { cache: 'reload', credentials: 'same-origin' })
    .catch(() => {})
    .finally(() => location.reload())
}

/** Checks daemon version across reconnects; in `--web` mode reloads once when the served JS bundle hash changed. */
async function checkFreshUi() {
  if (checkingFresh) return
  checkingFresh = true
  try {
    const res = await authedFetch('/health', { cache: 'no-store' })
    if (res.ok) {
      const health = await res.json() as { version?: string; webUi?: boolean }
      if (health.version) {
        if (bootVersion === undefined) bootVersion = health.version
        else if (bootVersion !== health.version && health.webUi && !desktop) { reloadOnce(health.version); return }
      }
    }
    const asset = !desktop ? currentAsset() : undefined
    if (asset) {
      const html = await fetch('/', { cache: 'no-store', headers: { pragma: 'no-cache' } })
      if (html.ok) {
        const nextAsset = (await html.text()).match(/\/assets\/index-[^"']+\.js/)?.[0]
        if (nextAsset && nextAsset !== asset) reloadOnce(nextAsset)
      }
    }
  } catch { /* offline or restarting */ } finally {
    checkingFresh = false
  }
}

const MODULE_EPOCH = Symbol('live')
const HEARTBEAT_TIMEOUT_MS = 45_000
const HEARTBEAT_CHECK_MS = 10_000
const CONNECT_TIMEOUT_MS = 15_000
const VISIBLE_STALE_MS = 25_000
const REPLY_POLL_CONNECTED_MS = 3_500
const REPLY_POLL_OFFLINE_MS = 1_500
const REPLY_WAIT_WINDOW_MS = 120_000

/**
 * Pure helper deciding whether a chat view should run a temporary safety-net poll for a pending reply.
 * Returns `false` (zero polling) once the assistant has replied or the conversation is idle.
 */
export function pendingReplyPollInterval(input: {
  messages: readonly Message[] | undefined
  routerBusy: boolean
  working: boolean
  awaitingDelivery: boolean
  connected: boolean
  lastSentAt: number
  now?: number
}): number | false {
  const now = input.now ?? Date.now()
  const said = (input.messages ?? []).filter(m =>
    (m.role === 'user' && !m.meta?.edited) || (m.role === 'assistant' && !m.meta?.superseded),
  )
  const last = said.at(-1)
  const waitingOnUserMsg = Boolean(last?.role === 'user' && now - last.createdAt < REPLY_WAIT_WINDOW_MS)
  const recentlySent = Boolean(input.lastSentAt > 0 && now - input.lastSentAt < REPLY_WAIT_WINDOW_MS && (!last || last.role === 'user' || last.createdAt < input.lastSentAt))
  const pending = input.routerBusy || input.working || input.awaitingDelivery || waitingOnUserMsg || recentlySent
  if (!pending) return false
  return input.connected ? REPLY_POLL_CONNECTED_MS : REPLY_POLL_OFFLINE_MS
}

/** Upserts a message carried in an SSE event directly into the React Query thread cache for instant UI updates. */
export function upsertConversationMessage(
  old: { conversation: Conversation; messages: Message[] } | undefined,
  message: Message | undefined,
): { conversation: Conversation; messages: Message[] } | undefined {
  if (!old || !message) return old
  const idx = old.messages.findIndex(m => m.id === message.id)
  if (idx >= 0) {
    const next = old.messages.slice()
    next[idx] = message
    return { ...old, messages: next }
  }
  return { ...old, messages: [...old.messages, message] }
}

export function useLiveEvents() {
  const qc = useQueryClient()
  const { status, baseUrl, activeProfileId, sessionId } = useConnection()
  useEffect(() => {
    if (status !== 'ready') {
      set({ connected: false })
      return
    }
    let active = true
    let ctrl: AbortController | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let lastEventAt = Date.now()
    let connectStartedAt = Date.now()
    let isConnected = false
    let inFlight = false
    let reconnectImmediately = false
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const soon = (key: string, fn: () => void, ms = 300) => {
      if (timers.has(key)) return
      timers.set(key, setTimeout(() => { timers.delete(key); fn() }, ms))
    }
    const refreshThread = (conversationId: string, message?: Message) => {
      const key = ['messages', conversationId] as const
      if (message) {
        qc.setQueryData<{ conversation: Conversation; messages: Message[] }>(
          key,
          old => upsertConversationMessage(old, message),
        )
      }
      const qState = qc.getQueryState(key)
      if (qState?.fetchStatus === 'fetching' && qState.data === undefined) {
        // TanStack Query v5 skips cancelRefetch when cached data is still undefined;
        // cancel the stale initial fetch explicitly so it cannot overwrite the newly arrived message.
        return qc.cancelQueries({ queryKey: key }).finally(() => qc.invalidateQueries({ queryKey: key }))
      }
      return qc.invalidateQueries({ queryKey: key })
    }
    const scheduleReconnect = () => {
      if (!active || retry) return
      if (getConnection().status !== 'ready') return
      const delay = Math.min(10_000, 1_000 * 2 ** Math.min(attempt, 3))
      attempt++
      retry = setTimeout(() => {
        retry = undefined
        connect()
      }, delay)
    }
    const reconnectNow = () => {
      if (!active || getConnection().status !== 'ready') return
      if (retry) { clearTimeout(retry); retry = undefined }
      attempt = 0
      if (inFlight) {
        reconnectImmediately = true
        ctrl?.abort()
        return
      }
      connect()
    }
    const connect = () => {
      if (!active || inFlight || getConnection().status !== 'ready') return
      inFlight = true
      connectStartedAt = Date.now()
      lastEventAt = connectStartedAt
      const currentCtrl = new AbortController()
      ctrl = currentCtrl
      const onDone = () => {
        if (ctrl === currentCtrl) ctrl = undefined
        const immediate = reconnectImmediately
        reconnectImmediately = false
        inFlight = false
        isConnected = false
        if (!active) return
        set({ connected: false })
        if (getConnection().status !== 'ready') return
        if (immediate) { attempt = 0; connect() } else scheduleReconnect()
      }
      void streamAuthedSSE('/events', (event, data) => {
        if (!active) return
        lastEventAt = Date.now()
        if (event === 'ready') {
          attempt = 0
          isConnected = true
          set({ connected: true })
          void checkFreshUi()
          const p = getPrefs()
          void authedFetch('/settings/client-prefs', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              theme: p.theme,
              accent: p.accent,
              uiLanguage,
              text: p.text,
              reduceMotion: p.reduceMotion,
              voiceInput: p.voiceInput,
              voiceLang: p.voiceLang,
              autoSend: p.autoSend,
              readAloud: p.readAloud,
              voiceRate: p.voiceRate,
              showRaw: p.showRaw,
              broadcast: false,
            }),
          }).catch(() => {})
          qc.invalidateQueries()
          return
        }
        if (event === 'message' && data) {
          try { handle(JSON.parse(data) as ServerEvent) } catch { /* ignore */ }
        }
      }, currentCtrl.signal).then(onDone, onDone)
    }
    const handle = (e: ServerEvent) => {
      switch (e.type) {
        case 'message.created':
          clearDraft(e.conversationId)
          void readAloud(e.conversationId, e.messageId)
          void refreshThread(e.conversationId, e.message).then(() => clearDraft(e.conversationId))
          soon('conversations', () => qc.invalidateQueries({ queryKey: ['conversations'] }))
          break
        case 'message.updated':
          void refreshThread(e.conversationId, e.message)
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
        case 'settings.updated':
          for (const k of e.keys ?? []) {
            qc.invalidateQueries({ queryKey: [k] })
          }
          break
        case 'prefs.updated': {
          const raw = (e.patch ?? {}) as Record<string, unknown>
          const webPatch: Partial<Prefs> = {}
          if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') webPatch.theme = raw.theme
          if (typeof raw.accent === 'string' && ACCENTS.some(a => a.id === raw.accent)) webPatch.accent = raw.accent as AccentId
          const nextText = raw.text ?? raw.text_size
          if (nextText === 'small' || nextText === 'normal' || nextText === 'large') webPatch.text = nextText
          const nextMotion = raw.reduceMotion ?? raw.reduce_motion
          if (typeof nextMotion === 'boolean') webPatch.reduceMotion = nextMotion
          const nextVoiceInput = raw.voiceInput ?? raw.voice_input
          if (typeof nextVoiceInput === 'boolean') webPatch.voiceInput = nextVoiceInput
          const nextVoiceLang = raw.voiceLang ?? raw.voice_lang
          if (typeof nextVoiceLang === 'string' && nextVoiceLang) webPatch.voiceLang = nextVoiceLang
          const nextAutoSend = raw.autoSend ?? raw.auto_send
          if (typeof nextAutoSend === 'boolean') webPatch.autoSend = nextAutoSend
          const nextReadAloud = raw.readAloud ?? raw.read_aloud
          if (typeof nextReadAloud === 'boolean') webPatch.readAloud = nextReadAloud
          const nextVoiceRate = raw.voiceRate ?? raw.voice_rate
          if (nextVoiceRate === 'slow' || nextVoiceRate === 'normal' || nextVoiceRate === 'fast') webPatch.voiceRate = nextVoiceRate
          const nextShowRaw = raw.showRaw ?? raw.show_raw
          if (typeof nextShowRaw === 'boolean') webPatch.showRaw = nextShowRaw
          if (Object.keys(webPatch).length > 0) setPrefs(webPatch, { fromServer: true })

          const desktopPatch: Partial<Omit<DesktopPrefs, 'registered'>> = {}
          const nextOpenAtLogin = raw.openAtLogin ?? raw.open_at_login
          if (typeof nextOpenAtLogin === 'boolean') desktopPatch.openAtLogin = nextOpenAtLogin
          if (typeof raw.tray === 'boolean') desktopPatch.tray = raw.tray
          const nextClose = raw.close ?? raw.close_action
          if (nextClose === 'hide' || nextClose === 'quit') desktopPatch.close = nextClose
          if (Object.keys(desktopPatch).length > 0 && desktop?.prefs) {
            void desktop.prefs.set(desktopPatch).then(d => qc.setQueryData(['desktop-prefs'], d)).catch(() => {})
          }

          const nextLang = (raw.uiLanguage ?? raw.ui_language) as UiLanguage | undefined
          if ((nextLang === 'zh' || nextLang === 'en' || nextLang === 'system') && nextLang !== uiLanguage) {
            setUiLanguage(nextLang)
          }
          break
        }
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
          // Streaming partial chat bubbles are disabled; replies appear only once saved (message.created).
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
          if (e.role === 'router') {
            const wasRunning = state.routerState === 'running'
            set({ routerState: e.state, ...(e.state !== 'running' ? { drafts: {} } : {}) })
            // When the router finishes a turn, ensure any active chat thread reconciles with persisted replies.
            if (wasRunning && e.state !== 'running') {
              soon('router-idle-sync', () => {
                qc.invalidateQueries({ queryKey: ['messages'] })
                qc.invalidateQueries({ queryKey: ['conversations'] })
              }, 120)
            }
          } else if (e.ticketId) {
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
    const watchdog = setInterval(() => {
      if (!active || getConnection().status !== 'ready') return
      const now = Date.now()
      if (isConnected && now - lastEventAt > HEARTBEAT_TIMEOUT_MS) {
        reconnectNow()
      } else if (inFlight && !isConnected && now - connectStartedAt > CONNECT_TIMEOUT_MS) {
        // Recover wedged pre-`ready` SSE connections (e.g., half-open socket after sleep or proxy drop).
        reconnectNow()
      } else if (!inFlight && !retry) {
        connect()
      }
    }, HEARTBEAT_CHECK_MS)
    const onOnline = () => {
      if (!isConnected) reconnectNow()
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!isConnected || Date.now() - lastEventAt > VISIBLE_STALE_MS) {
        reconnectNow()
      } else {
        qc.invalidateQueries({ queryKey: ['messages'] })
        qc.invalidateQueries({ queryKey: ['conversations'] })
      }
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    connect()
    return () => {
      active = false
      clearInterval(watchdog)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      ctrl?.abort()
      if (retry) clearTimeout(retry)
      for (const t of timers.values()) clearTimeout(t)
      set({ connected: false })
    }
  }, [qc, status, baseUrl, activeProfileId, sessionId, MODULE_EPOCH])
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
    const res = await authedFetch(`/messages/${messageId}`)
    const { message } = await res.json() as { message: { role: string; content: string; conversationId: string; meta: Record<string, any> } }
    if (message.role !== 'assistant' || message.meta.delivery) return
    if (!here) { const main = await authedFetch('/conversations/main').then(r => r.json()) as { id: string }; if (main.id !== conversationId) return }
    speak(message.content)
  } catch { /* best effort */ }
}
