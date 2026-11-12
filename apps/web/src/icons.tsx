import { useQuery } from '@tanstack/react-query'
import { AlarmClock, Bell, BookOpen, CalendarDays, Cloud, Code, FileText, Globe, Hash, HardDrive, Inbox, Mail, MessageCircle, MessageSquare, Newspaper, Rss, Send, Shield,
  ShoppingCart, SquareCheck, Users, Video, type LucideIcon } from 'lucide-react'
import { api, type SourceInfo } from './api'
import { tx } from './i18n'

/** The GitHub mark (lucide no longer ships brand icons). */
export function GithubIcon({ size = 14, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.34.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
}

/**
 * Icons a source can name in its `icon` (SourceKind.icon). A plugin naming one not listed here gets the speech bubble:
 * shipping every Lucide icon would multiply the bundle.
 */
const ICONS: Record<string, LucideIcon> = {
  'alarm-clock': AlarmClock, bell: Bell, 'book-open': BookOpen, calendar: CalendarDays, 'calendar-days': CalendarDays, cloud: Cloud,
  code: Code, 'file-text': FileText, globe: Globe, hash: Hash, 'hard-drive': HardDrive, inbox: Inbox, mail: Mail,
  'message-circle': MessageCircle, 'message-square': MessageSquare, newspaper: Newspaper, rss: Rss, send: Send, shield: Shield,
  'shopping-cart': ShoppingCart, 'square-check': SquareCheck, users: Users, video: Video,
}

/** Conversations that are not from a source kind. */
const CORE: Record<string, { title: string; icon: string }> = {
  webchat: { title: '对话', icon: 'message-square' },
  watchdog: { title: 'Watchdog', icon: 'shield' },
}

/** Every source's title and icon, as the sources themselves declare them (built-in and plugins alike). */
export function useSourceMeta(): (id: string) => { title: string; icon?: string } {
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[] }>('/sources'), staleTime: 60_000 }).data?.sources
  return id => {
    const core = CORE[id]
    if (core) return { title: tx(core.title), icon: core.icon }
    const s = sources?.find(x => x.id === id)
    return s ? { title: tx(s.title), ...(s.icon ? { icon: s.icon } : {}) } : { title: id }
  }
}

export function SourceIcon({ source, size = 14, className }: { source: string; size?: number; className?: string }) {
  const icon = useSourceMeta()(source).icon
  if (icon === 'github') return <GithubIcon size={size} {...(className ? { className } : {})} />
  const Icon = (icon && ICONS[icon]) || MessageSquare
  return <Icon size={size} {...(className ? { className } : {})} />
}

/** A source's name, as it declares it. */
export function SourceName({ source }: { source: string }) {
  return <>{useSourceMeta()(source).title}</>
}
