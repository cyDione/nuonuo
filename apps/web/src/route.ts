import { useEffect, useState } from 'react'

export type Route = { page: 'chat'; id?: string; main?: boolean } | { page: 'activity' } | { page: 'library' } | { page: 'settings'; tab: SettingsTab; item?: string }
export type SettingsTab = 'persona' | 'providers' | 'roles' | 'instructions' | 'proactive' | 'sources' | 'plugins' | 'mcp' | 'routines' | 'review' | 'memory' | 'execution' | 'usage' | 'system'

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/')
  if (parts[0] === 'settings') {
    const tab = (['persona', 'providers', 'roles', 'instructions', 'proactive', 'sources', 'plugins', 'mcp', 'routines', 'review', 'memory', 'execution', 'usage', 'system'] as const).find(t => t === parts[1]) ?? 'persona'
    return parts[2] ? { page: 'settings', tab, item: decodeURIComponent(parts[2]) } : { page: 'settings', tab }
  }
  if (parts[0] === 'c' && parts[1]) return { page: 'chat', id: parts[1] }
  if (parts[0] === 'new') return { page: 'chat' }
  if (parts[0] === 'activity') return { page: 'activity' }
  if (parts[0] === 'library') return { page: 'library' }
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
