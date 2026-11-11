/**
 * How the window looks on this device: light, dark or following the system, the theme colour, and whether task details
 * show the raw tool calls. Kept in localStorage and applied to <html> as data-theme / data-accent.
 */
import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'
export type AccentId = 'berry' | 'ink' | 'mint' | 'sea' | 'grape' | 'slate'
/** The six theme colours (Figma section 20, 快捷设置). 莓红 is the default and matches 糯糯. */
export const ACCENTS: { id: AccentId; label: string; color: string }[] = [
  { id: 'berry', label: '莓红', color: '#d43d6d' },
  { id: 'ink', label: '墨', color: '#141414' },
  { id: 'mint', label: '薄荷', color: '#13857a' },
  { id: 'sea', label: '海蓝', color: '#3d6fe0' },
  { id: 'grape', label: '葡萄', color: '#7a5cc8' },
  { id: 'slate', label: '石板', color: '#5b6b80' },
]

export type TextSize = 'small' | 'normal' | 'large'
export type VoiceRate = 'slow' | 'normal' | 'fast'
/** In-window shortcuts (设置 → 快捷键), as "Mod+K" style strings; Mod is ⌘ on macOS and Ctrl elsewhere. */
export interface Keys { search: string; newChat: string; mainChat: string; pane: string; settings: string }
export const DEFAULT_KEYS: Keys = { search: 'Mod+K', newChat: 'Mod+N', mainChat: 'Mod+1', pane: 'Mod+I', settings: 'Mod+,' }

export interface Prefs {
  theme: Theme; accent: AccentId; showRaw: boolean
  /** 设置 → 通用 */
  text: TextSize; reduceMotion: boolean
  /** 设置 → 语音 */
  voiceInput: boolean; voiceLang: string; autoSend: boolean; readAloud: boolean; voiceName: string; voiceRate: VoiceRate
  keys: Keys
}
const DEFAULTS: Prefs = {
  theme: 'system', accent: 'berry', showRaw: false, text: 'normal', reduceMotion: false,
  voiceInput: true, voiceLang: 'zh-CN', autoSend: false, readAloud: false, voiceName: '', voiceRate: 'normal', keys: DEFAULT_KEYS,
}
const KEY = 'sa-prefs'

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    const p = { ...DEFAULTS, ...saved }
    if (!ACCENTS.some(a => a.id === p.accent)) p.accent = DEFAULTS.accent
    if (!['light', 'dark', 'system'].includes(p.theme)) p.theme = DEFAULTS.theme
    if (!['small', 'normal', 'large'].includes(p.text)) p.text = DEFAULTS.text
    p.keys = { ...DEFAULT_KEYS, ...saved.keys }
    return p
  } catch { return DEFAULTS }
}

let prefs = load()
const listeners = new Set<() => void>()

/** Puts the theme and the accent on <html>; called before the first render so the page never flashes the wrong colours. */
export function applyPrefs(p: Prefs = prefs) {
  const root = document.documentElement
  if (p.theme === 'system') delete root.dataset.theme
  else root.dataset.theme = p.theme
  root.dataset.accent = p.accent
  if (p.text === 'normal') delete root.dataset.text
  else root.dataset.text = p.text
  if (p.reduceMotion) root.dataset.motion = 'reduce'
  else delete root.dataset.motion
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** Whether a key press is the shortcut `combo` ("Mod+Shift+K"). */
export function matchesKey(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false
  const parts = combo.split('+')
  const key = parts.pop()!
  const want = new Set(parts)
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (want.has('Mod') !== mod || want.has('Shift') !== e.shiftKey || want.has('Alt') !== e.altKey) return false
  if ((isMac ? e.ctrlKey : e.metaKey) && !want.has('Ctrl')) return false
  return e.key.length === 1 ? e.key.toUpperCase() === key.toUpperCase() || e.code === `Key${key.toUpperCase()}` || e.code === `Digit${key}` : e.key === key
}
/** "Mod+Shift+K" → "⌘ ⇧ K" on macOS, "Ctrl Shift K" elsewhere. */
/** ⌘ on a Mac, Ctrl elsewhere, for labels that name the main modifier. */
export const MOD = isMac ? '⌘' : 'Ctrl'
export function keyLabel(combo: string): string[] {
  if (!combo) return []
  return combo.split('+').map(k => k === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : k === 'Shift' ? (isMac ? '⇧' : 'Shift') : k === 'Alt' ? (isMac ? '⌥' : 'Alt')
    : k === 'Ctrl' || k === 'Control' ? (isMac ? '⌃' : 'Ctrl') : k === 'CommandOrControl' ? (isMac ? '⌘' : 'Ctrl') : k === 'Space' ? 'Space' : k.length === 1 ? k.toUpperCase() : k)
}
/** A key press as a shortcut string, or null while only modifiers are held. Needs a modifier. */
export function comboOf(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null
  const mods = [(isMac ? e.metaKey : e.ctrlKey) && 'Mod', isMac && e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]
  if (!mods.length) return null
  const key = e.code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key
  return [...mods, key].join('+')
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* private mode */ }
  applyPrefs()
  for (const l of listeners) l()
}

export const getPrefs = () => prefs
export const usePrefs = () => useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, () => prefs)
