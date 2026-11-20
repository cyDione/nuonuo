/** One EventSource per tab: keeps react-query caches fresh and holds the transient state (streaming replies, live worker text). */
import { useQueryClient } from '@tanstack/react-query'
import { playChime } from './sounds'
import { useEffect, useSyncExternalStore } from 'react'
import type { Notice, ServerEvent } from './api'
import { authedFetch, streamAuthedSSE } from './connection'
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

export function useLiveEvents() {
  const qc = useQueryClient()
  useEffect(() => {
    let active = true
    let ctrl: AbortController | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const soon = (key: string, fn: () => void, ms = 300) => {
      if (timers.has(key)) return
      timers.set(key, setTimeout(() => { timers.delete(key); fn() }, ms))
    }
    const connect = () => {
      if (!active) return
      ctrl = new AbortController()
      void streamAuthedSSE('/events', (event, data) => {
        if (event === 'ready') {
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
      }, ctrl.signal).then(() => {
        if (!active) return
        set({ connected: false })
        retry = setTimeout(connect, 2_000)
      }).catch(() => {
        if (!active) return
        set({ connected: false })
        retry = setTimeout(connect, 2_000)
      })
    }
    const handle = (e: ServerEvent) => {
      switch (e.type) {
        case 'message.created':
          clearDraft(e.conversationId)
          void readAloud(e.conversationId, e.messageId)
          void qc.invalidateQueries({ queryKey: ['messages', e.conversationId] }).then(() => clearDraft(e.conversationId))
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
          if (e.role === 'router') set({ routerState: e.state, ...(e.state !== 'running' ? { drafts: {} } : {}) })
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
    connect()
    return () => { active = false; ctrl?.abort(); clearTimeout(retry); for (const t of timers.values()) clearTimeout(t) }
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
    const res = await authedFetch(`/messages/${messageId}`)
    const { message } = await res.json() as { message: { role: string; content: string; conversationId: string; meta: Record<string, any> } }
    if (message.role !== 'assistant' || message.meta.delivery) return
    if (!here) { const main = await authedFetch('/conversations/main').then(r => r.json()) as { id: string }; if (main.id !== conversationId) return }
    speak(message.content)
  } catch { /* best effort */ }
}
