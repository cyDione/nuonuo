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

export interface Prefs { theme: Theme; accent: AccentId; showRaw: boolean }
const DEFAULTS: Prefs = { theme: 'system', accent: 'berry', showRaw: false }
const KEY = 'sa-prefs'

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    const p = { ...DEFAULTS, ...saved }
    if (!ACCENTS.some(a => a.id === p.accent)) p.accent = DEFAULTS.accent
    if (!['light', 'dark', 'system'].includes(p.theme)) p.theme = DEFAULTS.theme
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
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* private mode */ }
  applyPrefs()
  for (const l of listeners) l()
}

export const getPrefs = () => prefs
export const usePrefs = () => useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, () => prefs)
