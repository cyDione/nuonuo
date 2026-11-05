/** The assistant's identity in the UI (Muse): the name and avatar the owner chose, and a one-line status of its work. */
import { useQuery } from '@tanstack/react-query'
import { api, type Persona, type Ticket } from './api'
import { cx } from './ui'

export const usePersona = () => useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona'), staleTime: 60_000 }).data?.persona
  ?? { name: '小助', avatar: '✨', color: '#4f46e5', personality: '' }

export function Avatar({ persona, size = 28, className }: { persona: Persona; size?: number; className?: string }) {
  return <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full leading-none select-none', className)}
    style={{ width: size, height: size, background: `${persona.color}22`, boxShadow: `inset 0 0 0 1px ${persona.color}44`, fontSize: size * 0.55 }} aria-hidden>
    {persona.avatar || persona.name.slice(0, 1)}
  </span>
}

/** "正在整理周报 · 1 件事等你": what the avatar's status line says. */
export function statusLine(tickets: Ticket[]): { text: string; tone: 'idle' | 'working' | 'waiting' } {
  const waiting = tickets.filter(t => t.stage.startsWith('person/'))
  const working = tickets.filter(t => t.stage === 'working' || t.stage === 'queued')
  const parts: string[] = []
  if (working.length) parts.push(working.length === 1 ? `正在做：${working[0]!.title}` : `正在做 ${working.length} 件事`)
  if (waiting.length) parts.push(`${waiting.length} 件事等你`)
  return { text: parts.join(' · ') || '空闲', tone: waiting.length ? 'waiting' : working.length ? 'working' : 'idle' }
}
