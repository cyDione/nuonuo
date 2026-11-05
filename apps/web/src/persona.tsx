/**
 * The assistant's identity in the UI (Muse): the name and face the owner chose, and a one-line status of its work.
 * Its default face is a small, original character (a soft pebble with an antenna) (the mascot) whose expression follows what it is doing: breathing when idle,
 * looking around while it works, hopping when something waits for the owner, thinking while a reply is on its way.
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api, type Persona, type Ticket } from './api'
import { cx } from './ui'

export const MASCOT = 'mascot'
const FALLBACK: Persona = { name: '小助', avatar: MASCOT, color: '#2f6bff', personality: '' }

export const usePersona = () => {
  const p = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona'), staleTime: 60_000 }).data?.persona
  // Installs that never touched the old defaults (✨ on indigo) get the new look.
  return !p ? FALLBACK : p.avatar === '✨' && p.color === '#4f46e5' ? { ...p, avatar: MASCOT, color: FALLBACK.color } : p
}

/** The character is the face unless the owner picked an emoji ("✨" was the old default, so it maps to the character too). */
export const isMascot = (p: Persona) => !p.avatar || p.avatar === MASCOT || p.avatar === '✨'

export type Mood = 'idle' | 'working' | 'waiting' | 'thinking' | 'happy' | 'sleepy'
export const moodOf = (tone: 'idle' | 'working' | 'waiting'): Mood => tone

export function Avatar({ persona, size = 28, className, mood = 'idle', track }: { persona: Persona; size?: number; className?: string; mood?: Mood; track?: boolean }) {
  if (isMascot(persona)) return <Mascot color={persona.color} size={size} mood={mood} {...(className ? { className } : {})} {...(track ? { track } : {})} />
  return <span className={cx('inline-flex shrink-0 items-center justify-center rounded-[32%] leading-none select-none', className)}
    style={{ width: size, height: size, background: `${persona.color}22`, boxShadow: `inset 0 0 0 1px ${persona.color}44`, fontSize: size * 0.55 }} aria-hidden>
    {persona.avatar || persona.name.slice(0, 1)}
  </span>
}

const INK = '#121212'

/**
 * An original character: a soft cloud with dot eyes, a line smile and a curly antenna — flat, friendly, a "digital
 * colleague". Drawn in a 100×100 box; the owner's colour fills it.
 */
export function Mascot({ color, size = 28, mood = 'idle', className, track }: { color: string; size?: number; mood?: Mood; className?: string; track?: boolean }) {
  const eyes = useRef<SVGGElement>(null)
  const root = useRef<SVGSVGElement>(null)
  // Eyes follow the pointer (only on the large, decorative instances). Writes the transform directly; no React state per frame.
  useEffect(() => {
    if (!track || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    const onMove = (e: PointerEvent) => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const box = root.current?.getBoundingClientRect()
        if (!box || !eyes.current) return
        const dx = e.clientX - (box.left + box.width / 2), dy = e.clientY - (box.top + box.height * 0.55)
        const d = Math.hypot(dx, dy) || 1
        const k = Math.min(1, d / 260)
        eyes.current.style.transform = `translate(${(dx / d) * 4 * k}px, ${(dy / d) * 3.2 * k}px)`
      })
    }
    addEventListener('pointermove', onMove)
    return () => { removeEventListener('pointermove', onMove); cancelAnimationFrame(frame) }
  }, [track])

  const closed = mood === 'happy' || mood === 'sleepy'
  const line = { stroke: INK, strokeWidth: 2.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  return <svg ref={root} viewBox="0 0 100 100" width={size} height={size} className={cx('mascot shrink-0 overflow-visible', className)} data-mood={mood} aria-hidden>
    <ellipse cx="50" cy="94" rx="27" ry="3.2" fill="currentColor" opacity="0.08" />
    {mood === 'working' && <g className="m-orbit"><circle cx="50" cy="8" r="3.6" fill="var(--sun)" /></g>}
    <g className="m-body">
      {/* The curly antenna. */}
      <g className="m-sprout"><path d="M55 27 C53 19 56 12 62 12 C68 12 68 19 63 20 C58 21 58 13 64 8 C67 6 71 6 73 8" {...line} strokeWidth={2.4} /></g>
      {/* A cloud: one body and three soft bumps, all one colour. */}
      <g fill={color}>
        <ellipse cx="50" cy="64" rx="35" ry="27" />
        <circle cx="31" cy="48" r="17" /><circle cx="52" cy="38" r="19" /><circle cx="71" cy="49" r="16" />
      </g>
      {/* Arms: a shade darker, resting — one waves while something waits for the owner. */}
      <g style={{ fill: `color-mix(in oklab, ${color} 78%, #000)` }}>
        <ellipse cx="20" cy="73" rx="6.5" ry="9" transform="rotate(28 20 73)" />
        {mood === 'waiting' ? <g className="m-wave"><ellipse cx="85" cy="52" rx="6" ry="10" transform="rotate(-30 85 52)" /></g>
          : <ellipse cx="80" cy="73" rx="6.5" ry="9" transform="rotate(-28 80 73)" />}
      </g>
      {closed ? <g {...line}>
        {mood === 'happy' ? <><path d="M38 57 Q42 51 46 57" /><path d="M54 57 Q58 51 62 57" /></>
          : <><path d="M38 56 Q42 60 46 56" /><path d="M54 56 Q58 60 62 56" /></>}
      </g> : <g className="m-look"><g ref={eyes} className="m-pupils" style={mood === 'thinking' ? { transform: 'translate(3px, -3px)' } : undefined}>
        <g className="m-eye"><ellipse cx="43" cy="55" rx="3" ry="4.6" fill={INK} /></g>
        <g className="m-eye"><ellipse cx="57" cy="55" rx="3" ry="4.6" fill={INK} /></g>
      </g></g>}
      {mood === 'happy' ? <path d="M42 65 Q50 75 58 65 Z" fill={INK} stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
        : mood === 'waiting' ? <ellipse cx="50" cy="68" rx="3.2" ry="3.8" fill={INK} />
        : mood === 'thinking' ? <path d="M47 68 Q51 66 55 68" {...line} />
        : mood === 'sleepy' ? <path d="M46 68 L54 68" {...line} />
        : <path d="M43 65 Q50 72 57 64 M57 64 L59 62.5" {...line} />}
    </g>
    {mood === 'waiting' && <g className="anim-pop">
      <circle cx="86" cy="24" r="10" fill="var(--sun)" />
      <path d="M86 18 L86 25" stroke={INK} strokeWidth="3" strokeLinecap="round" /><circle cx="86" cy="29.6" r="1.8" fill={INK} />
    </g>}
    {mood === 'thinking' && <g fill="currentColor"><circle className="m-dot" cx="82" cy="26" r="3" /><circle className="m-dot" cx="89" cy="18" r="3.6" /><circle className="m-dot" cx="97" cy="9" r="4.2" /></g>}
    {mood === 'sleepy' && <text x="80" y="22" fontSize="16" fontWeight="700" fill="currentColor" opacity="0.55" fontFamily="var(--font-display)">z</text>}
  </svg>
}

/** "正在整理周报 · 1 件事等你": what the avatar's status line says. */
export function statusLine(tickets: Ticket[]): { text: string; tone: 'idle' | 'working' | 'waiting' } {
  const waiting = tickets.filter(t => t.stage.startsWith('person/'))
  const working = tickets.filter(t => t.stage === 'working' || t.stage === 'queued')
  const parts: string[] = []
  if (working.length) parts.push(working.length === 1 ? `正在做：${working[0]!.title}` : `正在做 ${working.length} 件事`)
  if (waiting.length) parts.push(`${waiting.length} 件事等你`)
  return { text: parts.join(' · ') || '空闲，随时可以找我', tone: waiting.length ? 'waiting' : working.length ? 'working' : 'idle' }
}

/** 早上好 / 下午好 …, for the greeting on the main conversation's empty screen. */
export function greeting(now = new Date()) {
  const h = now.getHours()
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
}
