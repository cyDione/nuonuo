/** The assistant's name, face and status line. */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, type Persona, type Ticket } from './api'
import { cx } from './ui'

export const MASCOT = 'mascot'
/** 糯糯's own pink (Figma "10 · Logo 重做"): reads on both the pure white and the pure black window. */
export const BRAND = '#ff7a9a'
/** The assistant's official name. 小助 was the old default and is shown as 糯糯. */
export const OFFICIAL_NAME = '糯糯'
const FALLBACK: Persona = { name: OFFICIAL_NAME, avatar: MASCOT, color: BRAND, personality: '' }
// Earlier default colours: shown as the current brand pink.
const OLD_DEFAULTS = new Set(['#4f46e5', '#2f6bff', '#2b4bff', '#2b3cff', '#5c7bff', '#7d8bf0', '#e9845a'])

export const usePersona = () => {
  const p = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona'), staleTime: 60_000 }).data?.persona
  if (!p) return FALLBACK
  const avatar = p.avatar === '✨' ? MASCOT : p.avatar
  const name = p.name === '小助' ? OFFICIAL_NAME : p.name
  const old = OLD_DEFAULTS.has(p.color.toLowerCase())
  return avatar !== p.avatar || old || name !== p.name ? { ...p, name, avatar, color: old ? BRAND : p.color } : p
}

export const isMascot = (p: Persona) => !p.avatar || p.avatar === MASCOT || p.avatar === '✨'

export type Mood = 'idle' | 'working' | 'waiting' | 'thinking' | 'happy' | 'sleepy' | 'listening'
export const moodOf = (tone: 'idle' | 'working' | 'waiting'): Mood => tone

export function Avatar({ persona, size = 28, className, mood = 'idle', track }: { persona: Persona; size?: number; className?: string; mood?: Mood; track?: boolean }) {
  if (isMascot(persona)) return <Mascot color={persona.color} size={size} mood={mood} {...(className ? { className } : {})} {...(track ? { track } : {})} />
  return <span className={cx('inline-flex shrink-0 items-center justify-center rounded-[32%] leading-none select-none', className)}
    style={{ width: size, height: size, background: `${persona.color}22`, boxShadow: `inset 0 0 0 1px ${persona.color}44`, fontSize: size * 0.55 }} aria-hidden>
    {persona.avatar || persona.name.slice(0, 1)}
  </span>
}

const INK = '#14152B'
const SUN = '#FFC23D'
/** The eyes are cut out of the body, so they show the page behind: white on the light window, black on the dark one. */
const CUT = 'var(--bg)'
/** The mound: a circle on a rounded block (Figma 53:999). */
const BODY = 'M16 52 A34 34 0 0 1 84 52 V73 A12 12 0 0 1 72 85 H28 A12 12 0 0 1 16 73 Z'
const STAR = 'M74 9 C75.6 16.4 75.6 16.4 83 18 C75.6 19.6 75.6 19.6 74 27 C72.4 19.6 72.4 19.6 65 18 C72.4 16.4 72.4 16.4 74 9 Z'

/**
 * The assistant: a soft mochi with a star tucked on its head (Figma "v4 · 标志与角色", option A). Its face follows its mood;
 * with `track` its eyes follow the pointer. A mood change blinks first, so the new face never just snaps in.
 */
export function Mascot({ color, size = 28, mood = 'idle', className, track }: { color: string; size?: number; mood?: Mood; className?: string; track?: boolean }) {
  const eyes = useRef<SVGGElement>(null)
  const root = useRef<SVGSVGElement>(null)
  const [shown, setShown] = useState(mood)
  const [blink, setBlink] = useState(false)
  useEffect(() => {
    if (mood === shown) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(mood); return }
    setBlink(true)
    const t1 = setTimeout(() => setShown(mood), 90)
    const t2 = setTimeout(() => setBlink(false), 180)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [mood])
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
        eyes.current.style.transform = `translate(${(dx / d) * 3.4 * k}px, ${(dy / d) * 2.6 * k}px)`
      })
    }
    addEventListener('pointermove', onMove)
    return () => { removeEventListener('pointermove', onMove); cancelAnimationFrame(frame) }
  }, [track])

  const m = shown
  const closed = m === 'happy' || m === 'sleepy'
  const line = { stroke: CUT, strokeWidth: 2.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  const look = m === 'thinking' ? 'translate(2.2px, -2.4px)' : m === 'listening' ? 'translate(-1px, 1.5px)' : undefined
  return <svg ref={root} viewBox="0 0 100 100" width={size} height={size} className={cx('mascot shrink-0 overflow-visible', className)} data-mood={m} data-blink={blink || undefined} aria-hidden>
    <ellipse className="m-shadow" cx="50" cy="93" rx="28" ry="3.4" fill="currentColor" opacity="0.08" />
    <g className="m-body">
      <path d={BODY} fill={color} />
      {closed ? <g {...line} strokeWidth={3.3}>
        {m === 'happy' ? <><path d="M35 56 Q39.5 49.4 44 56" /><path d="M56 56 Q60.5 49.4 65 56" /></>
          : <><path d="M35 55 Q39.5 59.5 44 55" /><path d="M56 55 Q60.5 59.5 65 55" /></>}
      </g> : <g className="m-look"><g ref={eyes} className="m-pupils"><g style={look ? { transform: look } : undefined} className="m-pupils">
        <g className="m-eye"><rect x="35.5" y="48" width="8" height="15" rx="4" fill={CUT} /></g>
        <g className="m-eye"><rect x="56.5" y="48" width="8" height="15" rx="4" fill={CUT} /></g>
      </g></g></g>}
    </g>
    {(m === 'idle' || m === 'happy' || m === 'working') && <path className="m-star" d={STAR} fill={SUN} />}
    {m === 'waiting' && <g className="anim-pop">
      <circle cx="82" cy="22" r="8.5" fill={SUN} />
      <path d="M82 17.5 L82 23" stroke={INK} strokeWidth="2.6" strokeLinecap="round" /><circle cx="82" cy="26.4" r="1.5" fill={INK} />
    </g>}
    {m === 'thinking' && <g fill="currentColor"><circle className="m-dot" cx="76" cy="28" r="2.2" /><circle className="m-dot" cx="82" cy="22" r="3" /><circle className="m-dot" cx="89" cy="15" r="3.8" /></g>}
    {m === 'sleepy' && <path className="m-z" d="M78 14 H86 L78 22 H86" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.5" />}
  </svg>
}

/** "正在整理周报 · 1 件事等你": what the avatar's status line says. */
export function statusLine(tickets: Ticket[]): { text: string; tone: 'idle' | 'working' | 'waiting' } {
  const waiting = tickets.filter(t => t.stage.startsWith('person/'))
  const working = tickets.filter(t => t.stage === 'working' || t.stage === 'queued')
  const parts: string[] = []
  if (working.length) parts.push(working.length === 1 ? `正在做：${working[0]!.title}` : `正在做 ${working.length} 件事`)
  if (waiting.length) parts.push(`${waiting.length} 件事等你`)
  return { text: parts.join(' · ') || '在，有事叫我', tone: waiting.length ? 'waiting' : working.length ? 'working' : 'idle' }
}

/** 早上好 / 下午好 …, for the greeting on the main conversation's empty screen. */
export function greeting(now = new Date()) {
  const h = now.getHours()
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
}
