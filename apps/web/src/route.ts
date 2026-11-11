import { useEffect, useState } from 'react'

export type Route = { page: 'chat'; id?: string; main?: boolean } | { page: 'activity' } | { page: 'library' } | { page: 'goals' } | { page: 'ideas' } | { page: 'settings'; tab: SettingsTab; item?: string } | { page: 'me' } | { page: 'quick' } | { page: 'waiting' }
export const SETTINGS_TABS = ['persona', 'routines', 'sources', 'plugins', 'mcp', 'execution', 'providers', 'roles', 'usage',
  'general', 'notifications', 'voice', 'shortcuts', 'data', 'system'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/')
  // Who the assistant is (性格 · 灵魂 · 记忆) lives in the right pane's 它是谁.
  if (parts[0] === 'me') return { page: 'me' }
  if (parts[0] === 'quick') return { page: 'quick' }
  // 等你点头 from the tray: the card itself (in its chat), or the top of the right pane's 活动.
  if (parts[0] === 'waiting') return { page: 'waiting' }
  if (parts[0] === 'settings' && (parts[1] === 'instructions' || parts[1] === 'memory')) return { page: 'me' }
  if (parts[0] === 'settings') {
    // 规则 moved to the right pane's 权限; what was left of 规则与审核 joined 执行环境 as 安全和执行 (v7).
    const tab = parts[1] === 'review' ? 'execution' : SETTINGS_TABS.find(t => t === parts[1]) ?? 'persona'
    return parts[2] ? { page: 'settings', tab, item: decodeURIComponent(parts[2]) } : { page: 'settings', tab }
  }
  if (parts[0] === 'c' && parts[1]) return { page: 'chat', id: parts[1] }
  if (parts[0] === 'new') return { page: 'chat' }
  if (parts[0] === 'activity') return { page: 'activity' }
  if (parts[0] === 'library') return { page: 'library' }
  if (parts[0] === 'goals') return { page: 'goals' }
  if (parts[0] === 'ideas') return { page: 'ideas' }
  return { page: 'chat', main: true }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash))
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export const go = (path: string) => { location.hash = path }

// Where 返回聊天 (and Esc) in the settings window goes: the last page outside settings.
let outside = typeof location !== 'undefined' && !location.hash.startsWith('#/settings') ? location.hash : ''
if (typeof window !== 'undefined') addEventListener('hashchange', () => { if (!location.hash.startsWith('#/settings')) outside = location.hash })
export const leaveSettings = () => { location.hash = outside && outside !== '#' ? outside : '#/' }
