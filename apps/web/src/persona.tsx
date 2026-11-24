/** The assistant's name, face and status line. */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { api, type Persona, type Ticket } from './api'
import { cx } from './ui'
import { tx } from './i18n'

export const MASCOT = 'mascot'
/** 糯糯's colour follows the theme colour (设置 → 通用 → 主题色); 莓红, the default, gives its own pink (Figma "10 · Logo 重做"). */
export const BRAND = 'var(--mochi)'
/** The assistant's official name (Nuonuo in the English interface). 小助 was the old default and is shown as 糯糯. */
export const OFFICIAL_NAME = tx('糯糯')
const FALLBACK: Persona = { name: OFFICIAL_NAME, avatar: MASCOT, color: BRAND, personality: '', limits: [], role: 'all', language: 'auto' }

export const usePersona = () => {
  const p = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona'), staleTime: 60_000 }).data?.persona
  if (!p) return FALLBACK
  const avatar = p.avatar === '✨' ? MASCOT : p.avatar
  const name = p.name === '小助' || p.name === '糯糯' ? OFFICIAL_NAME : p.name
  // One colour for the whole app: the theme colour also colours 糯糯, so the colour saved on the persona is no longer used.
  return { ...p, name, avatar, color: BRAND }
}

export const isMascot = (p: Persona) => !p.avatar || p.avatar === MASCOT || p.avatar === '✨'
export const isImageAvatar = (avatar: string | undefined) => Boolean(avatar && /^https?:\/\/|^data:image\/|^\//.test(avatar))

export type Mood = 'idle' | 'working' | 'waiting' | 'thinking' | 'happy' | 'sleepy' | 'listening'
export const moodOf = (tone: 'idle' | 'working' | 'waiting'): Mood => tone

export function Avatar({ persona, size = 28, className, mood = 'idle', track }: { persona: Persona; size?: number; className?: string; mood?: Mood; track?: boolean }) {
  if (isMascot(persona)) return <Mascot color={persona.color} size={size} mood={mood} {...(className ? { className } : {})} {...(track ? { track } : {})} />
  if (isImageAvatar(persona.avatar)) {
    return <span className={cx('inline-flex shrink-0 overflow-hidden rounded-full bg-sunken select-none', className)} style={{ width: size, height: size }}>
      <img src={persona.avatar} alt={persona.name} className="size-full rounded-full object-cover" />
    </span>
  }
  return <span className={cx('inline-flex shrink-0 items-center justify-center rounded-[32%] leading-none select-none', className)}
    style={{ width: size, height: size, background: `color-mix(in oklab, ${persona.color} 13%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${persona.color} 27%, transparent)`, fontSize: size * 0.55 }} aria-hidden>
    {persona.avatar || persona.name.slice(0, 1)}
  </span>
}

const AMBER = '#F59E0B'
/** Eye fill contrasts against the ceramic body: porcelain white on berry daylight, deep midnight slate on dark porcelain. */
const EYE = 'var(--mochi-eye, #ffffff)'
/** Wide, low-slung hand-formed ceramic mochi silhouette (86x56, Figma v17 · 方向 2 卧糯眸影). */
const WIDE_BODY = 'M 24 80 C 11 80 7 70 7 56 C 7 35 22 24 50 24 C 78 24 93 35 93 56 C 93 70 89 80 76 80 Z'
/** Softly melted flat resting silhouette for sleepy / quiet night-guard state. */
const FLAT_BODY = 'M 22 82 C 10 82 6 74 6 62 C 6 45 21 36 50 36 C 79 36 94 45 94 62 C 94 74 90 82 78 82 Z'

/**
 * 卧糯眸影 · Resting Mochi (Figma v17 方向 2 & v15): a wide, serene ceramic mochi whose eyes rest at optical center
 * and gaze gently rightward toward the conversation. With `track`, its gaze follows the pointer softly; mood changes
 * blink first so expressions transition naturally.
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
        const dx = e.clientX - (box.left + box.width / 2), dy = e.clientY - (box.top + box.height * 0.52)
        const d = Math.hypot(dx, dy) || 1
        const k = Math.min(1, d / 280)
        eyes.current.style.transform = `translate(${(dx / d) * 3.2 * k}px, ${(dy / d) * 2.2 * k}px)`
      })
    }
    addEventListener('pointermove', onMove)
    return () => { removeEventListener('pointermove', onMove); cancelAnimationFrame(frame) }
  }, [track])

  const m = shown
  return <svg ref={root} viewBox="0 0 100 100" width={size} height={size} className={cx('mascot shrink-0 overflow-visible', className)} data-mood={m} data-blink={blink || undefined} aria-hidden>
    <g className="m-body">
      <path d={m === 'sleepy' ? FLAT_BODY : WIDE_BODY} style={{ fill: color }} opacity={m === 'sleepy' ? 0.92 : 1} />
      {m === 'happy' ? (
        <g stroke={EYE} strokeWidth="4.4" strokeLinecap="round" fill="none" transform="translate(0, -1)">
          <path d="M 39 52 Q 45 43.5 51 52" />
          <path d="M 59 52 Q 65 43.5 71 52" />
        </g>
      ) : m === 'sleepy' ? (
        <g stroke={EYE} strokeWidth="4.2" strokeLinecap="round" fill="none">
          <line x1="38" y1="60" x2="48" y2="60" />
          <line x1="58" y1="60" x2="68" y2="60" />
        </g>
      ) : m === 'working' ? (
        <g ref={eyes} className="m-pupils">
          <g className="m-eye"><circle cx="46" cy="51" r="4.3" fill={EYE} /></g>
          <g className="m-eye"><line x1="61" y1="51" x2="71" y2="51" stroke={EYE} strokeWidth="4.6" strokeLinecap="round" /></g>
        </g>
      ) : m === 'thinking' ? (
        <g ref={eyes} className="m-pupils">
          <g className="m-eye"><circle cx="38" cy="46" r="4.2" fill={EYE} /></g>
          <g className="m-eye"><circle cx="57" cy="46" r="4.2" fill={EYE} /></g>
          <circle className="m-dot" cx="71" cy="42" r="2.6" fill={EYE} opacity="0.65" />
        </g>
      ) : m === 'waiting' ? (
        <g ref={eyes} className="m-pupils">
          <g className="m-eye"><circle cx="44" cy="47" r="4.6" fill={EYE} /></g>
          <g className="m-eye"><circle cx="64" cy="47" r="4.6" fill={EYE} /></g>
        </g>
      ) : (
        <g ref={eyes} className="m-pupils">
          <g className="m-eye"><circle cx={m === 'listening' ? 46 : 45} cy={m === 'listening' ? 50.5 : 51} r={m === 'listening' ? 4.6 : 4.4} fill={EYE} /></g>
          <g className="m-eye"><circle cx={m === 'listening' ? 66 : 65} cy={m === 'listening' ? 50.5 : 51} r={m === 'listening' ? 4.6 : 4.4} fill={EYE} /></g>
        </g>
      )}
    </g>
    {m === 'waiting' && <circle className="m-beacon" cx="86" cy="22" r="6.5" fill={AMBER} />}
  </svg>
}

/** Official Nuonuo App Icon (Figma v17 Icon 2 · 东方卧糯白瓷): deep berry-crimson matte ceramic squircle + serene white Resting Mochi. */
export function BrandIcon({ size = 52, className }: { size?: number; className?: string }) {
  const gid = useId()
  return <svg viewBox="0 0 100 100" width={size} height={size} className={cx('shrink-0', className)} aria-hidden>
    <defs>
      <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#E32450" />
        <stop offset="100%" stopColor="#B9143C" />
      </linearGradient>
    </defs>
    <rect x="0.75" y="0.75" width="98.5" height="98.5" rx="22.8" fill={`url(#${gid})`} stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" />
    <g transform="translate(13, 13) scale(0.74)">
      <path d={WIDE_BODY} fill="#FFFFFF" />
      <circle cx="45" cy="51" r="4.5" fill="#C81742" />
      <circle cx="65" cy="51" r="4.5" fill="#C81742" />
    </g>
  </svg>
}

/** "正在整理周报 · 1 件事等你": what the avatar's status line says. */
export function statusLine(tickets: Ticket[]): { text: string; tone: 'idle' | 'working' | 'waiting' } {
  const waiting = tickets.filter(t => t.stage.startsWith('person/'))
  const working = tickets.filter(t => t.stage === 'working' || t.stage === 'queued')
  const parts: string[] = []
  if (working.length) parts.push(working.length === 1 ? tx('正在做：{0}', working[0]!.title) : tx('正在做 {0} 件事', working.length))
  if (waiting.length) parts.push(tx('{0} 件事等你', waiting.length))
  return { text: parts.join(' · ') || tx('在，有事叫我'), tone: waiting.length ? 'waiting' : working.length ? 'working' : 'idle' }
}

/** 早上好 / 下午好 …, for the greeting on the main conversation's empty screen. */
export function greeting(now = new Date()) {
  const h = now.getHours()
  return h < 5 ? tx('夜深了') : h < 11 ? tx('早上好') : h < 13 ? tx('中午好') : h < 18 ? tx('下午好') : tx('晚上好')
}
