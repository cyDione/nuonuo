import { useEffect, useState } from 'react'

export type Route = { page: 'chat'; id?: string } | { page: 'settings'; tab: SettingsTab }
export type SettingsTab = 'providers' | 'roles' | 'usage' | 'system'

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/')
  if (parts[0] === 'settings') {
    const tab = (['providers', 'roles', 'usage', 'system'] as const).find(t => t === parts[1]) ?? 'providers'
    return { page: 'settings', tab }
  }
  if (parts[0] === 'c' && parts[1]) return { page: 'chat', id: parts[1] }
  return { page: 'chat' }
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
