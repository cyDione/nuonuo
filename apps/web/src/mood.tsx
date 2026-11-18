/**
 * 个性与心境 (Figma sections 29, 31 and 33 · 210:1187). On by default (switched on/off in 设置 · 主动).
 * In 它是谁: a framed live card with stance pill + qualitative state, a 2×2 micro-capsule grid for all four dimensions
 * (心情 · 精力 · 耐心 · 信任), a compact sparkline once turns accumulate, and the personality base underneath.
 * 「打开」 (or tapping the card) opens the window with three pages:
 *   此刻 — the stance and why, four values to drag (they apply from the next message), the last 50 turns (tap for why).
 *   性格 — its personality base (the persona's 性格), its limits and how much praise / being brushed off move it.
 *   日记 — what it wrote down in its own words; pin or delete.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, ChevronRight, Pin, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { api, type Persona } from './api'
import { locale, tx } from './i18n'
import { usePrefs } from './prefs'
import { Switch } from './skills'
import { cx, Seg } from './ui'

export type ToneId = 'natural' | 'warm' | 'witty' | 'calm' | 'sharp'
export interface ToneState {
  x: number
  y: number
  id: ToneId
  label: string
  strength: number
}

interface MoodPoint { at: number; mood: number; undertone?: number; energy: number; patience?: number; trust: number; attitude?: string; note?: string }
interface DiaryEntry { id: string; at: number; text: string; mood: number; pinned: boolean }
interface Baseline { mood: number; energy: number; patience: number; trust: number }
export interface MoodView {
  enabled: boolean; mood: number; undertone?: number; energy: number; patience: number; trust: number; summary: string; history: MoodPoint[]
  stance: { id: string; name: string; why: string }; config: { up: number; down: number; diary: boolean }; baseline: Baseline; diary: DiaryEntry[]
  tone?: ToneState
}
type Values = Pick<MoodView, 'mood' | 'energy' | 'patience' | 'trust'>

const TONE_NAME: Record<ToneId, () => string> = {
  natural: () => tx('自然'),
  warm: () => tx('温和'),
  witty: () => tx('风趣'),
  calm: () => tx('沉静'),
  sharp: () => tx('犀利'),
}
const TONE_SUB: Record<ToneId, () => string> = {
  natural: () => tx('默认均衡'),
  warm: () => tx('温和亲切'),
  witty: () => tx('轻松打趣'),
  calm: () => tx('惜字克制'),
  sharp: () => tx('直率干脆'),
}
const TONE_DOT: Record<ToneId, { light: string; dark: string }> = {
  natural: { light: '#8A9099', dark: '#A0A8B4' },
  warm: { light: '#D98A9E', dark: '#E598AC' },
  witty: { light: '#D69E66', dark: '#E2AE78' },
  calm: { light: '#6899C3', dark: '#84B4DC' },
  sharp: { light: '#5EB095', dark: '#7BC8AE' },
}
const toneDotHex = (id: ToneId, dark: boolean) => (TONE_DOT[id] ?? TONE_DOT.natural)[dark ? 'dark' : 'light']

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const round2 = (v: number) => Math.round(v * 100) / 100
const TONE_NATURAL_RADIUS = 0.08

export function resolveTone(raw?: Partial<ToneState> | { x: number; y: number } | null): ToneState {
  const x = round2(clamp(Number(raw?.x) || 0, -1, 1))
  const y = round2(clamp(Number(raw?.y) || 0, -1, 1))
  const dist = clamp(Math.hypot(x, y), 0, 1)
  const computedId: ToneId = dist < TONE_NATURAL_RADIUS ? 'natural' : x <= 0 ? (y >= 0 ? 'warm' : 'calm') : (y >= 0 ? 'witty' : 'sharp')
  const rawId = raw && 'id' in raw ? raw.id : undefined
  const id: ToneId = rawId && ['natural', 'warm', 'witty', 'calm', 'sharp'].includes(rawId) && dist >= TONE_NATURAL_RADIUS ? rawId : computedId
  const rawStrength = raw && 'strength' in raw && typeof raw.strength === 'number' && Number.isFinite(raw.strength) ? raw.strength : undefined
  const strength = id === 'natural' ? 0 : rawStrength !== undefined ? clamp(rawStrength > 1 ? rawStrength / 100 : rawStrength, 0, 1) : round2(dist)
  return { x, y, id, label: TONE_NAME[id](), strength }
}

function useIsDark(): boolean {
  const { theme } = usePrefs()
  const compute = () => {
    if (typeof document === 'undefined') return false
    const root = document.documentElement
    if (root.dataset.theme === 'dark' || root.classList.contains('dark')) return true
    if (root.dataset.theme === 'light') return false
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  }
  const [dark, setDark] = useState(compute)
  useEffect(() => {
    setDark(compute())
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    const update = () => setDark(compute())
    mq?.addEventListener?.('change', update)
    const obs = typeof MutationObserver !== 'undefined' ? new MutationObserver(update) : null
    obs?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    return () => {
      mq?.removeEventListener?.('change', update)
      obs?.disconnect()
    }
  }, [theme])
  return dark
}

const moodShort = (v: number) => v < -0.55 ? tx('低落') : v < -0.15 ? tx('有点闷') : v <= 0.25 ? tx('平静') : v < 0.65 ? tx('开心') : tx('很开心')
const energyShort = (v: number) => v < 0.34 ? tx('没什么劲') : v < 0.67 ? tx('平稳') : tx('有精神')
const patienceShort = (v: number) => v < 20 ? tx('见底了') : v < 35 ? tx('不耐烦') : v < 80 ? tx('有耐心') : tx('包容')
const trustShort = (v: number) => v < 30 ? tx('疏远') : v < 48 ? tx('保留') : v < 60 ? tx('熟悉') : tx('默契')

/** The same words the assistant hears about itself (packages/plugins/src/mood.ts). */
export function moodLine(m: { mood: number; energy: number }): string {
  const mood = m.mood < -0.55 ? tx('低落') : m.mood < -0.15 ? tx('有点闷') : m.mood <= 0.25 ? tx('心情平静') : m.mood < 0.65 ? tx('心情不错') : tx('心情很好')
  const energy = energyShort(m.energy)
  return tx('{0}，{1}', mood, energy)
}
const STANCE: Record<string, string> = { cool: tx('冷淡抽离'), guarded: tx('防备克制'), comrade: tx('战友破局'), listen: tx('先接住'), focus: tx('专注干活'), banter: tx('老友互怼'), partner: tx('清醒搭档') }
const STANCE_DOT: Record<string, string> = { partner: 'bg-accent', banter: 'bg-accent', comrade: 'bg-sky', focus: 'bg-sky', listen: 'bg-ok', guarded: 'bg-warn', cool: 'bg-faint' }
const stanceDot = (id: string) => STANCE_DOT[id] ?? 'bg-accent'
const sign = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`

export function useMood() {
  const qc = useQueryClient()
  const view = useQuery({ queryKey: ['mood'], queryFn: () => api.get<{ mood: MoodView }>('/mood'), refetchInterval: 20_000 }).data?.mood
  const put = (data: { mood: MoodView }) => qc.setQueryData(['mood'], data)
  const update = useMutation({
    mutationFn: (body: { enabled?: boolean; values?: Partial<Values>; config?: Partial<MoodView['config']>; tone?: { x: number; y: number } }) => api.put<{ mood: MoodView }>('/mood', body),
    onMutate: body => qc.setQueryData<{ mood: MoodView }>(['mood'], old => old && {
      mood: {
        ...old.mood,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.values ?? {}),
        config: { ...old.mood.config, ...(body.config ?? {}) },
        ...(body.tone ? { tone: resolveTone(body.tone) } : {}),
      },
    }),
    onSuccess: put, onError: () => qc.invalidateQueries({ queryKey: ['mood'] }),
  })
  return { view, put, update }
}

// ── iOS Photographic Styles Pure Dot-Matrix Pad (Bilinear Color Mesh + Gaussian Ripple) ──

type RGB = [number, number, number]
const PAD_PALETTE = {
  light: {
    tl: [242, 223, 227] as RGB, // #F2DFE3 温和 (柔雾暖粉珊瑚)
    tr: [243, 230, 211] as RGB, // #F3E6D3 风趣 (暖杏晨光)
    bl: [217, 232, 244] as RGB, // #D9E8F4 沉静 (冰川雾蓝)
    br: [219, 239, 232] as RGB, // #DBEFE8 犀利 (青瓷薄荷)
    dotRgb: '20, 24, 30',
    dotBaseAlpha: 0.24,
    dotPeakAlpha: 0.82,
    ringAlpha: 0.38,
    thumbFill: 'rgba(255, 255, 255, 0.84)',
    thumbStroke: 'rgba(24, 28, 34, 0.22)',
    thumbShadow: 'rgba(20, 24, 30, 0.16)',
    glowAlpha: 0.28,
  },
  dark: {
    tl: [126, 99, 108] as RGB,  // #7E636C 温和 (通透雾玫瑰灰)
    tr: [133, 115, 91] as RGB,  // #85735B 风趣 (通透暖砂琥珀)
    bl: [88, 122, 147] as RGB,  // #587A93 沉静 (通透雾霾冰蓝)
    br: [87, 128, 119] as RGB,  // #578077 犀利 (通透青雾鼠尾草)
    dotRgb: '255, 255, 255',
    dotBaseAlpha: 0.42,
    dotPeakAlpha: 0.96,
    ringAlpha: 0.58,
    thumbFill: 'rgba(255, 255, 255, 0.62)',
    thumbStroke: 'rgba(255, 255, 255, 0.92)',
    thumbShadow: 'rgba(0, 0, 0, 0.22)',
    glowAlpha: 0.07,
  },
}

const meshCache: Partial<Record<'light' | 'dark', HTMLCanvasElement>> = {}
function getBilinearMesh(mode: 'light' | 'dark'): HTMLCanvasElement {
  if (meshCache[mode]) return meshCache[mode]!
  const mw = 96, mh = 48
  const c = document.createElement('canvas')
  c.width = mw
  c.height = mh
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(mw, mh)
  const { tl, tr, bl, br } = PAD_PALETTE[mode]
  let idx = 0
  for (let j = 0; j < mh; j++) {
    const v = j / (mh - 1), iv = 1 - v
    for (let i = 0; i < mw; i++) {
      const u = i / (mw - 1), iu = 1 - u
      const wTL = iu * iv, wTR = u * iv, wBL = iu * v, wBR = u * v
      img.data[idx++] = Math.round(wTL * tl[0] + wTR * tr[0] + wBL * bl[0] + wBR * br[0])
      img.data[idx++] = Math.round(wTL * tl[1] + wTR * tr[1] + wBL * bl[1] + wBR * br[1])
      img.data[idx++] = Math.round(wTL * tl[2] + wTR * tr[2] + wBL * bl[2] + wBR * br[2])
      img.data[idx++] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  meshCache[mode] = c
  return c
}

export function ToneDotPad({ value, compact, className, onLiveChange, onCommit }: {
  value: { x: number; y: number }
  compact?: boolean
  className?: string
  onLiveChange?(pos: { x: number; y: number }): void
  onCommit(pos: { x: number; y: number }): void
}) {
  const isDark = useIsDark()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: value.x, y: value.y })
  const [hoverNorm, setHoverNorm] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: compact ? 288 : 592, h: compact ? 124 : 136 })

  useEffect(() => {
    if (!dragging.current) setPos({ x: value.x, y: value.y })
  }, [value.x, value.y])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const updateSize = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height })
    }
    updateSize()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateSize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = compact ? 15 : 19
  const rows = 7
  const midCol = Math.floor(cols / 2)
  const midRow = Math.floor(rows / 2)
  const padX = compact ? 18 : 24
  const padY = compact ? 21 : 23

  const clientToNorm = (clientX: number, clientY: number) => {
    const el = wrapRef.current
    if (!el) return pos
    const r = el.getBoundingClientRect()
    const innerW = Math.max(1, r.width - padX * 2)
    const innerH = Math.max(1, r.height - padY * 2)
    const u = clamp((clientX - r.left - padX) / innerW, 0, 1)
    const v = clamp((clientY - r.top - padY) / innerH, 0, 1)
    const x = round2(u * 2 - 1)
    const y = round2(1 - v * 2)
    return Math.hypot(x, y) < 0.06 ? { x: 0, y: 0 } : { x, y }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const W = size.w, H = size.h
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1
    const bw = Math.max(1, Math.round(W * dpr))
    const bh = Math.max(1, Math.round(H * dpr))
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const mode = isDark ? 'dark' : 'light'
    const pal = PAD_PALETTE[mode]
    const innerW = Math.max(1, W - padX * 2)
    const innerH = Math.max(1, H - padY * 2)
    const thumbX = padX + ((pos.x + 1) / 2) * innerW
    const thumbY = padY + ((1 - pos.y) / 2) * innerH
    const focusX = hoverNorm ? padX + ((hoverNorm.x + 1) / 2) * innerW : thumbX
    const focusY = hoverNorm ? padY + ((1 - hoverNorm.y) / 2) * innerH : thumbY
    const hasThumbOffset = Math.hypot(pos.x, pos.y) >= 0.06
    const sigma = 24
    const twoSigmaSq = 2 * sigma * sigma

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    // 1. 100% Continuous Bilinear 4-Corner Color Mesh (zero center dark hole)
    ctx.drawImage(getBilinearMesh(mode), 0, 0, W, H)

    // 2. Soft local brightness halo (+6%) at active thumb / focus
    const haloR = compact ? 68 : 88
    const grad = ctx.createRadialGradient(focusX, focusY, 0, focusX, focusY, haloR)
    grad.addColorStop(0, `rgba(255, 255, 255, ${pal.glowAlpha})`)
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // 3. Translucent frosted thumb disc (drawn underneath high-opacity Gaussian dots so bright dots shine through)
    if (hasThumbOffset || dragging.current) {
      const tr = compact ? 9.5 : 11
      ctx.save()
      ctx.shadowColor = pal.thumbShadow
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 2
      ctx.beginPath()
      ctx.arc(thumbX, thumbY, tr, 0, Math.PI * 2)
      ctx.fillStyle = pal.thumbFill
      ctx.fill()
      ctx.restore()

      ctx.beginPath()
      ctx.arc(thumbX, thumbY, tr, 0, Math.PI * 2)
      ctx.lineWidth = 1.25
      ctx.strokeStyle = pal.thumbStroke
      ctx.stroke()
    }

    // 4. Pure dot matrix + center hollow ring ○ + Gaussian magnification ripple cluster
    for (let r = 0; r < rows; r++) {
      const gy = padY + (r / (rows - 1)) * innerH
      for (let c = 0; c < cols; c++) {
        const gx = padX + (c / (cols - 1)) * innerW
        const dFocus = Math.hypot(gx - focusX, gy - focusY)
        let g = Math.exp(-(dFocus * dFocus) / twoSigmaSq)
        if (!hoverNorm && !hasThumbOffset) {
          g *= 0.22
        } else if (hoverNorm && hasThumbOffset) {
          const dThumb = Math.hypot(gx - thumbX, gy - thumbY)
          const gThumb = Math.exp(-(dThumb * dThumb) / twoSigmaSq) * 0.65
          if (gThumb > g) g = gThumb
        }

        if (c === midCol && r === midRow) {
          const ringR = 3 + g * 1.1
          const ringAlpha = clamp(pal.ringAlpha + g * (pal.dotPeakAlpha - pal.ringAlpha), 0, 0.96)
          ctx.beginPath()
          ctx.arc(gx, gy, ringR, 0, Math.PI * 2)
          ctx.lineWidth = 1.5
          ctx.strokeStyle = `rgba(${pal.dotRgb}, ${ringAlpha})`
          ctx.stroke()
        } else {
          const dotR = 1.4 + g * (4.4 - 1.4)
          const dotAlpha = pal.dotBaseAlpha + g * (pal.dotPeakAlpha - pal.dotBaseAlpha)
          ctx.beginPath()
          ctx.arc(gx, gy, dotR, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${pal.dotRgb}, ${dotAlpha})`
          ctx.fill()
        }
      }
    }

    ctx.restore()
  }, [size.w, size.h, pos.x, pos.y, hoverNorm?.x, hoverNorm?.y, isDark, compact, cols, rows, midCol, midRow, padX, padY])

  const active = hoverNorm ?? pos
  const activeDist = Math.hypot(active.x, active.y)
  const qTL = activeDist >= TONE_NATURAL_RADIUS && active.x <= 0 && active.y >= 0
  const qTR = activeDist >= TONE_NATURAL_RADIUS && active.x > 0 && active.y >= 0
  const qBL = activeDist >= TONE_NATURAL_RADIUS && active.x <= 0 && active.y < 0
  const qBR = activeDist >= TONE_NATURAL_RADIUS && active.x > 0 && active.y < 0

  const setAndNotify = (next: { x: number; y: number }, commit?: boolean) => {
    setPos(next)
    onLiveChange?.(next)
    if (commit) onCommit(next)
  }

  const toneInfo = resolveTone(pos)
  const cornerCls = (lit: boolean) => cx(
    'pointer-events-none absolute px-2.5 py-1.5 text-[10px] leading-none select-none transition-opacity duration-150',
    isDark ? 'text-white' : 'text-[#181C22]',
    lit ? 'font-medium opacity-90' : 'opacity-45',
  )

  return <div
    ref={wrapRef}
    role="slider"
    tabIndex={0}
    aria-label={tx('语调偏向')}
    aria-valuemin={-100}
    aria-valuemax={100}
    aria-valuenow={Math.round(toneInfo.strength * 100)}
    aria-valuetext={toneInfo.id === 'natural' ? tx('自然') : tx('偏{0} · {1}%', toneInfo.label, Math.round(toneInfo.strength * 100))}
    onClick={e => e.stopPropagation()}
    onDoubleClick={e => {
      e.stopPropagation()
      setAndNotify({ x: 0, y: 0 }, true)
    }}
    onPointerDown={e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      e.stopPropagation()
      dragging.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      const next = clientToNorm(e.clientX, e.clientY)
      setHoverNorm(next)
      setAndNotify(next, false)
    }}
    onPointerMove={e => {
      const next = clientToNorm(e.clientX, e.clientY)
      setHoverNorm(next)
      if (dragging.current) setAndNotify(next, false)
    }}
    onPointerUp={e => {
      if (!dragging.current) return
      e.stopPropagation()
      dragging.current = false
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      const next = clientToNorm(e.clientX, e.clientY)
      setAndNotify(next, true)
    }}
    onPointerCancel={e => {
      if (!dragging.current) return
      dragging.current = false
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      setAndNotify(pos, true)
    }}
    onPointerLeave={() => {
      if (!dragging.current) setHoverNorm(null)
    }}
    onKeyDown={e => {
      let nx = pos.x, ny = pos.y
      if (e.key === 'ArrowRight') nx = round2(clamp(pos.x + 0.1, -1, 1))
      else if (e.key === 'ArrowLeft') nx = round2(clamp(pos.x - 0.1, -1, 1))
      else if (e.key === 'ArrowUp') ny = round2(clamp(pos.y + 0.1, -1, 1))
      else if (e.key === 'ArrowDown') ny = round2(clamp(pos.y - 0.1, -1, 1))
      else if (e.key === 'Home' || e.key === '0') { nx = 0; ny = 0 }
      else return
      e.preventDefault()
      setAndNotify({ x: nx, y: ny }, true)
    }}
    className={cx(
      'relative cursor-crosshair overflow-hidden rounded-[14px] select-none touch-none outline-none focus-visible:ring-2 focus-visible:ring-accent',
      isDark ? 'ring-1 ring-inset ring-white/15' : 'ring-1 ring-inset ring-black/[0.08]',
      className,
    )}
  >
    <canvas ref={canvasRef} className="block size-full" />
    <span className={cx(cornerCls(qTL), 'top-0 left-0')}>{tx('温和')}</span>
    <span className={cx(cornerCls(qTR), 'top-0 right-0')}>{tx('风趣')}</span>
    <span className={cx(cornerCls(qBL), 'bottom-0 left-0')}>{tx('沉静')}</span>
    <span className={cx(cornerCls(qBR), 'right-0 bottom-0')}>{tx('犀利')}</span>
  </div>
}

// ── 它是谁 ──────────────────────────────────────────────────────────────────

/** Symmetrical bipolar micro-capsules (-1..+1) anchored around a center equilibrium notch. */
function BipolarTile({ label, sub, value, shown }: { label: string; sub: string; value: number; shown: string }) {
  const v = Math.max(-1, Math.min(1, value))
  const steps = Math.abs(v) < 0.06 ? 0 : Math.min(4, Math.max(1, Math.round(Math.abs(v) * 4)))
  return <div className="rounded-[10px] border border-line bg-card px-3 py-2.5" role="meter" aria-label={label} aria-valuemin={-1} aria-valuemax={1} aria-valuenow={v} aria-valuetext={`${sub} ${shown}`}>
    <div className="mb-2 flex items-baseline gap-1.5">
      <span className="shrink-0 text-xs font-medium text-fg">{label}</span>
      <span className={cx('min-w-0 truncate text-[11px]', v >= 0.65 ? 'text-accent' : 'text-muted')}>{sub}</span>
      <span className="ml-auto shrink-0 text-xs font-semibold text-fg tabular-nums">{shown}</span>
    </div>
    <div className="flex h-2.5 items-center gap-[3px]" aria-hidden>
      {[3, 2, 1, 0].map(slot => {
        const lit = v < 0 && slot < steps
        return <span key={`l${slot}`} className="h-[5px] flex-1 rounded-full bg-fg/[0.09] dark:bg-fg/[0.14]">
          <span className={cx('block size-full rounded-full bg-muted transition-[transform,opacity] duration-[180ms] ease-[var(--ease-out-strong)] motion-reduce:transition-none', lit ? 'scale-100 opacity-100' : 'scale-90 opacity-0')} />
        </span>
      })}
      <span className={cx('mx-[1px] h-[10px] w-[1.5px] shrink-0 rounded-full', steps === 0 ? 'bg-fg/45' : 'bg-faint/80')} />
      {[0, 1, 2, 3].map(slot => {
        const lit = v > 0 && slot < steps
        return <span key={`r${slot}`} className="h-[5px] flex-1 rounded-full bg-fg/[0.09] dark:bg-fg/[0.14]">
          <span className={cx('block size-full rounded-full bg-accent transition-[transform,opacity] duration-[180ms] ease-[var(--ease-out-strong)] motion-reduce:transition-none', lit ? 'scale-100 opacity-100' : 'scale-90 opacity-0')} />
        </span>
      })}
    </div>
  </div>
}

/** 8-capsule unipolar micro-gauge (0..1); shifts to warm amber warning when patience runs low. */
function PipTile({ label, sub, value, shown, warn }: { label: string; sub: string; value: number; shown: string; warn?: boolean }) {
  const u = Math.max(0, Math.min(1, value))
  const litCount = u <= 0.02 ? 0 : Math.min(8, Math.max(1, Math.round(u * 8)))
  return <div className="rounded-[10px] border border-line bg-card px-3 py-2.5" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={u} aria-valuetext={`${sub} ${shown}`}>
    <div className="mb-2 flex items-baseline gap-1.5">
      <span className="shrink-0 text-xs font-medium text-fg">{label}</span>
      <span className={cx('min-w-0 truncate text-[11px]', warn ? 'text-warn' : 'text-muted')}>{sub}</span>
      <span className={cx('ml-auto shrink-0 text-xs font-semibold tabular-nums', warn ? 'text-warn' : 'text-fg')}>{shown}</span>
    </div>
    <div className="flex h-2.5 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => <span key={i} className="h-[5px] flex-1 rounded-full bg-fg/[0.09] dark:bg-fg/[0.14]">
        <span className={cx('block size-full rounded-full transition-[transform,opacity] duration-[180ms] ease-[var(--ease-out-strong)] motion-reduce:transition-none', warn ? 'bg-warn' : 'bg-fg/[0.78]', i < litCount ? 'scale-100 opacity-100' : 'scale-90 opacity-0')} />
      </span>)}
    </div>
  </div>
}

/** Compact 140×26 mood sparkline for the card footer; dashed rule marks where mood settles back to. */
function Trend({ points, base, positive }: { points: MoodPoint[]; base: number; positive: boolean }) {
  const gid = useId()
  const W = 140, H = 26, pad = 3
  const x = (i: number) => pad + (i / Math.max(1, points.length - 1)) * (W - pad * 2)
  const y = (v: number) => H / 2 - Math.max(-1, Math.min(1, v)) * (H / 2 - pad)
  const lineD = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.mood).toFixed(1)}`).join(' ')
  const areaD = `${lineD} L${x(points.length - 1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z`
  const last = points.at(-1)!
  return <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className={cx('block h-[26px] w-[140px] shrink-0 overflow-visible', positive ? 'text-accent' : 'text-muted')} aria-hidden>
    <defs>
      <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
        <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
      </linearGradient>
    </defs>
    <line x1={pad} x2={W - pad} y1={y(base)} y2={y(base)} className="stroke-fg/15" strokeDasharray="2.5 2.5" vectorEffect="non-scaling-stroke" />
    <path d={areaD} fill={`url(#${gid})`} />
    <path d={lineD} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    <circle cx={x(points.length - 1)} cy={y(last.mood)} r={2.5} fill="currentColor" />
  </svg>
}

type Tab = 'now' | 'persona' | 'diary'
type CardMode = 'mood' | 'tone'

export function MoodSection({ Head }: { Head: React.ComponentType<{ title: string; count?: number | string | undefined; action?: React.ReactNode }> }) {
  const { view, update } = useMood()
  const isDark = useIsDark()
  const persona = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona') }).data?.persona
  const [openTab, setOpenTab] = useState<Tab | null>(null)
  const [cardMode, setCardMode] = useState<CardMode>('mood')
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null)
  if (!view) return null
  const base = persona?.personality.trim()
  const savedTone = resolveTone(view.tone)
  const activeTone = livePos ? resolveTone(livePos) : savedTone
  const commitTone = (next: { x: number; y: number }) => {
    setLivePos(null)
    update.mutate({ tone: next })
  }
  return <section className="border-t border-line pt-5">
    <Head title={tx('个性与心境')} action={
      <button type="button" onClick={() => setOpenTab(cardMode === 'tone' ? 'persona' : 'now')} className="press -my-1 -mr-1.5 inline-flex h-7 items-center gap-0.5 rounded-lg px-1.5 text-xs font-medium text-fg hover:bg-sunken">
        {tx('打开')}<ChevronRight size={13} className="text-muted" />
      </button>
    } />
    {view.enabled ? <div className="rounded-2xl bg-sunken p-3">
      <div className="mb-2.5 flex h-[26px] items-center gap-1.5">
        {cardMode === 'mood' ? <>
          <button type="button" onClick={() => setOpenTab('now')} className="press inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-card py-1 pr-2.5 pl-2 text-xs font-medium text-fg hover:border-faint">
            <span className={cx('size-[7px] shrink-0 rounded-full', stanceDot(view.stance.id))} />
            {STANCE[view.stance.id] ?? view.stance.name}
          </button>
          <button type="button" onClick={() => setOpenTab('now')} className="min-w-0 flex-1 truncate text-left text-xs text-muted hover:text-fg">{moodLine(view)}</button>
        </> : <>
          <button type="button" onClick={() => setOpenTab('persona')} className="press inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-card py-1 pr-2.5 pl-2 text-xs font-medium text-fg tabular-nums hover:border-faint">
            <span className={cx('size-[7px] shrink-0 rounded-full', activeTone.id === 'natural' && 'border border-muted bg-transparent')}
              style={activeTone.id === 'natural' ? undefined : { backgroundColor: toneDotHex(activeTone.id, isDark) }} />
            {activeTone.id === 'natural' ? tx('自然') : tx('偏{0} · {1}%', activeTone.label, Math.round(activeTone.strength * 100))}
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{TONE_SUB[activeTone.id]()}</span>
        </>}
        <div role="tablist" aria-label={tx('心境与语调')} className="inline-flex h-6 shrink-0 items-center rounded-lg border border-line bg-card p-0.5 text-[11px]">
          <button type="button" role="tab" aria-selected={cardMode === 'mood'} onClick={() => setCardMode('mood')}
            className={cx('h-5 rounded-[6px] px-2 font-medium transition-colors', cardMode === 'mood' ? 'bg-sunken text-fg' : 'text-muted hover:text-fg')}>
            {tx('心境')}
          </button>
          <button type="button" role="tab" aria-selected={cardMode === 'tone'} onClick={() => setCardMode('tone')}
            className={cx('h-5 rounded-[6px] px-2 font-medium transition-colors', cardMode === 'tone' ? 'bg-sunken text-fg' : 'text-muted hover:text-fg')}>
            {tx('语调')}
          </button>
        </div>
      </div>
      <div className="h-[124px]">
        {cardMode === 'mood' ? <div onClick={() => setOpenTab('now')} className="grid h-[124px] cursor-pointer grid-cols-2 grid-rows-2 gap-2">
          <BipolarTile label={tx('心情')} sub={moodShort(view.mood)} value={view.mood} shown={sign(view.mood)} />
          <PipTile label={tx('精力')} sub={energyShort(view.energy)} value={view.energy} shown={`${Math.round(view.energy * 100)}%`} />
          <PipTile label={tx('耐心')} sub={patienceShort(view.patience)} value={view.patience / 100} shown={String(Math.round(view.patience))} warn={view.patience < 35} />
          <PipTile label={tx('信任')} sub={trustShort(view.trust)} value={view.trust / 100} shown={String(Math.round(view.trust))} />
        </div> : <ToneDotPad compact value={{ x: savedTone.x, y: savedTone.y }} onLiveChange={setLivePos} onCommit={commitTone} className="h-[124px] w-full" />}
      </div>
      <div className="mt-2.5 flex h-[36px] items-center justify-between gap-2 border-t border-line pt-2.5">
        {cardMode === 'mood' ? <>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint tabular-nums">
            <span className="shrink-0">{view.history.length > 1 ? tx('最近 {0} 轮', view.history.length) : tx('还没有记录')}</span>
            {savedTone.id !== 'natural' && <>
              <span>·</span>
              <button type="button" onClick={() => setCardMode('tone')} className="inline-flex min-w-0 items-center gap-1 truncate text-muted hover:text-fg">
                <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: toneDotHex(savedTone.id, isDark) }} />
                <span className="truncate">{tx('偏{0}', savedTone.label)}</span>
              </button>
            </>}
          </div>
          {view.history.length > 1 ? <Trend points={view.history} base={view.undertone ?? view.baseline.mood} positive={view.mood >= 0} /> : <span className="shrink-0 text-[11px] text-faint">{tx('聊几轮后出现曲线')}</span>}
        </> : <>
          <span className="min-w-0 truncate text-[11px] text-faint">{tx('拖到哪就按哪种口气接话')}</span>
          {activeTone.id !== 'natural' && <button type="button" onClick={() => commitTone({ x: 0, y: 0 })}
            className="press shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-card hover:text-fg">
            {tx('归中')}
          </button>}
        </>}
      </div>
    </div> : <div className="flex items-center justify-between gap-3 rounded-2xl bg-sunken px-3.5 py-3">
      <span className="min-w-0 flex-1 text-xs text-muted text-pretty">{tx('心境已关闭，性格底色照常生效')}</span>
      <a href="#/settings/persona" className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-fg hover:opacity-75">
        {tx('去设置开启')}<ChevronRight size={13} className="text-muted" />
      </a>
    </div>}
    <button type="button" onClick={() => setOpenTab('persona')} className="mt-2.5 block w-full rounded-lg px-0.5 text-left text-xs text-pretty transition-colors duration-150">
      <span className={cx('line-clamp-2', base ? 'text-muted hover:text-fg' : 'text-faint hover:text-muted')}>
        {base ? tx('底色：{0}', base) : tx('还没写性格底色，点这里写一句。')}
      </span>
    </button>
    {openTab && <MindWindow initialTab={openTab} onClose={() => setOpenTab(null)} />}
  </section>
}

// ── The window ──────────────────────────────────────────────────────────────

function MindWindow({ initialTab = 'now', onClose }: { initialTab?: Tab; onClose(): void }) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [leaving, setLeaving] = useState(false)
  const dirty = useRef(false)
  const opener = useRef<Element | null>(document.activeElement)
  const box = useRef<HTMLDivElement>(null)
  const latest = useRef(onClose)
  latest.current = onClose
  const close = () => {
    if (dirty.current && !confirm(tx('改的还没保存，确定关掉？'))) return
    const done = () => { latest.current(); (opener.current as HTMLElement | null)?.focus?.() }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return done()
    setLeaving(true)
    setTimeout(done, 120)
  }
  useEffect(() => {
    box.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  const switchTab = (t: Tab) => { if (t !== tab && dirty.current && !confirm(tx('改的还没保存，确定离开？'))) return; dirty.current = false; setTab(t) }
  return <div className={cx('anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4 max-sm:p-0', leaving && 'out-fade')}
    onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tx('个性与心境')}
      className={cx('anim-pop flex h-[min(720px,88dvh)] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-[20px] border border-line bg-panel shadow-2xl outline-none max-sm:h-dvh max-sm:w-full max-sm:rounded-none max-sm:border-0', leaving && 'out-pop')}>
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-line pr-3 pl-6">
        <h2 className="text-[17px] font-semibold whitespace-nowrap">{tx('个性与心境')}</h2>
        <Seg label={tx('个性与心境')} value={tab} onChange={v => switchTab(v as Tab)} options={[{ id: 'now', label: tx('此刻') }, { id: 'persona', label: tx('性格') }, { id: 'diary', label: tx('日记') }]} className="w-[190px]" />
        <span className="flex-1" />
        <button type="button" onClick={close} aria-label={tx('关闭')} title={tx('关闭')} className="press flex size-8 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-fg"><X size={16} /></button>
      </header>
      {tab === 'now' && <NowPage onClose={close} />}
      {tab === 'persona' && <PersonaPage onDirty={d => { dirty.current = d }} />}
      {tab === 'diary' && <DiaryPage />}
    </div>
  </div>
}

/** A slider drawn like Figma 31 & 33D: a capsule rail, fill from the origin, a crisp baseline tick, and an 18px ring knob. */
function Slider({ label, note, value, min, max, base, origin, step, shown, accent, warn, onCommit }: {
  label: string; note: string | ((v: number) => string); value: number; min: number; max: number; base: number; origin?: number; step: number; shown(v: number): string; accent?: boolean; warn?: boolean; onCommit(v: number): void
}) {
  const [v, setV] = useState(value)
  const dragging = useRef(false)
  useEffect(() => { if (!dragging.current) setV(value) }, [value])
  const pct = (x: number) => `${((Math.max(min, Math.min(max, x)) - min) / (max - min)) * 100}%`
  const o = origin ?? min
  const lo = Math.min(o, v), hi = Math.max(o, v)
  const commit = () => { dragging.current = false; if (v !== value) onCommit(v) }
  const noteText = typeof note === 'function' ? note(v) : note
  const fillCls = accent ? (v >= 0 ? 'bg-accent' : 'bg-muted') : warn ? 'bg-warn' : 'bg-fg'
  return <div>
    <div className="mb-2 flex items-baseline gap-2">
      <span className="text-[13px] font-medium">{label}</span><span className={cx('text-xs', warn ? 'text-warn' : 'text-muted')}>{noteText}</span>
      <span className={cx('ml-auto text-[13px] font-semibold tabular-nums', accent && v > 0 ? 'text-accent' : warn ? 'text-warn' : 'text-fg')}>{shown(v)}</span>
    </div>
    <div className="relative flex h-6 items-center">
      <input type="range" aria-label={label} min={min} max={max} step={step} value={v}
        onChange={e => { dragging.current = true; setV(Number(e.target.value)) }} onPointerUp={commit} onPointerCancel={commit} onKeyUp={commit} onBlur={commit}
        className="peer absolute -inset-y-1 inset-x-0 z-10 h-8 w-full cursor-pointer opacity-0" />
      <span className="pointer-events-none relative h-1.5 w-full rounded-full bg-fg/[0.10] dark:bg-fg/[0.15]">
        <span className={cx('absolute inset-y-0 rounded-full', fillCls)} style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }} />
      </span>
      <span title={tx('平时')} className="pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted" style={{ left: pct(base) }} />
      <span className="pointer-events-none absolute top-1/2 size-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-fg bg-panel shadow-[0_1px_3px_rgb(0_0_0/0.18)] transition-transform duration-150 ease-[var(--ease-out-strong)] peer-hover:scale-105 peer-active:scale-110 peer-focus-visible:ring-4 peer-focus-visible:ring-accent/25 motion-reduce:transition-none" style={{ left: pct(v) }} />
    </div>
  </div>
}

const when = (at: number) => {
  const d = new Date(at), now = new Date()
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (d.toDateString() === now.toDateString()) return tx('今天 {0}', time)
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return tx('昨天 {0}', time)
  return tx('{0} 月 {1} 日 {2}', d.getMonth() + 1, d.getDate(), time)
}

function NowPage({ onClose }: { onClose(): void }) {
  const { view, update, put } = useMood()
  const reset = useMutation({ mutationFn: () => api.post<{ mood: MoodView }>('/mood/reset', {}), onSuccess: put })
  if (!view) return <div className="flex-1" />
  const set = (values: Partial<Values>) => update.mutate({ values })
  return <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
    {!view.enabled && <div className="flex items-center gap-3 rounded-xl bg-sunken px-4 py-2.5 text-xs text-muted">
      <span className="flex-1 text-pretty">{tx('心境变化已关闭：这些数不会随对话变，也不影响它说话。')}</span>
      <a href="#/settings/persona" onClick={onClose} className="shrink-0 font-medium text-muted underline underline-offset-2 hover:text-fg">{tx('设置')}</a>
      <button type="button" onClick={() => update.mutate({ enabled: true })} className="press h-7 shrink-0 rounded-lg bg-ink px-2.5 font-medium text-ink-fg">{tx('打开心境')}</button>
    </div>}
    <div className="flex items-center gap-3">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-line py-1 pr-3 pl-2.5 text-[13px] font-medium">
        <span className={cx('size-[7px] rounded-full', stanceDot(view.stance.id))} />{STANCE[view.stance.id] ?? view.stance.name}
      </span>
      <p className="min-w-0 text-[13px] text-muted text-pretty">{tx(view.stance.why)}</p>
    </div>
    <div className="space-y-4 rounded-2xl bg-sunken px-4 py-4">
      <Slider label={tx('心情')} note={v => moodShort(v)} value={view.mood} min={-1} max={1} origin={0} step={0.01} base={view.undertone ?? view.baseline.mood} shown={sign} accent onCommit={mood => set({ mood })} />
      <Slider label={tx('精力')} note={v => energyShort(v)} value={view.energy} min={0} max={1} step={0.01} base={view.baseline.energy} shown={v => `${Math.round(v * 100)}%`} onCommit={energy => set({ energy })} />
      <Slider label={tx('耐心')} note={v => patienceShort(v)} value={view.patience} min={0} max={100} step={1} base={view.baseline.patience} shown={v => String(Math.round(v))} warn={view.patience < 35} onCommit={patience => set({ patience })} />
      <Slider label={tx('信任')} note={v => `${trustShort(v)} · ${tx('变得很慢')}`} value={view.trust} min={0} max={100} step={1} base={view.baseline.trust} shown={v => String(Math.round(v))} onCommit={trust => set({ trust })} />
    </div>
    <div className="flex items-center gap-3">
      <p className="flex-1 text-xs text-muted text-pretty">{tx('拖动就生效，下一句话开始用新的状态。灰色短线是它平时的样子，心情和耐心会慢慢回去。')}</p>
      <button type="button" onClick={() => reset.mutate()} disabled={reset.isPending} className="press flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs hover:bg-sunken"><RotateCcw size={13} />{tx('回到平时')}</button>
    </div>
    <Chart points={view.history} />
  </div>
}

/** The last 50 turns: mood (ink), patience (grey), trust (light grey). Tap a turn to see what moved it. */
function Chart({ points }: { points: MoodPoint[] }) {
  const [at, setAt] = useState<number>()
  const W = 592, H = 120
  const x = (i: number) => points.length === 1 ? W : i / (points.length - 1) * W
  const line = (f: (p: MoodPoint) => number) => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${(H - 4 - f(p) * (H - 8)).toFixed(1)}`).join(' ')
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setAt(Math.round(((e.clientX - r.left) / r.width) * Math.max(0, points.length - 1)))
  }
  const p = at !== undefined ? points[at] : undefined
  return <div>
    <div className="mb-2.5 flex items-center gap-3.5 text-xs text-muted">
      <span className="flex-1 text-[13px] font-medium text-fg">{points.length ? tx('最近 {0} 轮', points.length) : tx('还没有记录')}</span>
      <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-fg" />{tx('心情')}</span>
      <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-muted" />{tx('耐心')}</span>
      <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-faint" />{tx('信任')}</span>
    </div>
    {points.length > 1 ? <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full cursor-crosshair overflow-visible" onPointerDown={pick} onPointerMove={e => { if (e.buttons) pick(e) }} role="img" aria-label={tx('最近 {0} 轮', points.length)}>
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} className="stroke-line" strokeDasharray="3 3" />
        <path d={line(q => q.trust / 100)} fill="none" className="stroke-faint" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <path d={line(q => (q.patience ?? 60) / 100)} fill="none" className="stroke-muted" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <path d={line(q => (q.mood + 1) / 2)} fill="none" className="stroke-fg" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {p && <line x1={x(at!)} x2={x(at!)} y1={0} y2={H} className="stroke-line" />}
      </svg>
      {p && <div className="pointer-events-none absolute top-1 max-w-[260px] rounded-[10px] border border-line bg-panel px-2.5 py-2 shadow-[0_4px_12px_rgb(0_0_0/0.1)]"
        style={at! / Math.max(1, points.length - 1) > 0.5 ? { right: `${(1 - x(at!) / W) * 100}%` } : { left: `${(x(at!) / W) * 100}%` }}>
        <p className="text-[11px] text-muted tabular-nums">{when(p.at)} · {tx('心情')} {sign(p.mood)}</p>
        {p.note && <p className="mt-0.5 truncate text-xs">{p.attitude === 'stopped' ? p.note : tx('你说「{0}」', p.note)}</p>}
      </div>}
    </div> : <p className="py-6 text-center text-xs text-faint">{tx('聊几轮之后这里会有曲线。')}</p>}
  </div>
}

function PersonaPage({ onDirty }: { onDirty(d: boolean): void }) {
  const qc = useQueryClient()
  const { view, update } = useMood()
  const isDark = useIsDark()
  const persona = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona') }).data?.persona
  const [draft, setDraft] = useState<{ personality: string; limits: string[]; up: number; down: number }>()
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null)
  const initial = persona && view ? { personality: persona.personality, limits: persona.limits ?? [], up: view.config.up, down: view.config.down } : undefined
  useEffect(() => { if (initial && !draft) setDraft(initial) }, [Boolean(initial)])
  const changed = draft && initial ? [draft.personality.trim() !== initial.personality, JSON.stringify(draft.limits.map(l => l.trim()).filter(Boolean)) !== JSON.stringify(initial.limits), draft.up !== initial.up, draft.down !== initial.down].filter(Boolean).length : 0
  useEffect(() => onDirty(changed > 0), [changed])
  const save = useMutation({
    mutationFn: async (d: NonNullable<typeof draft>) => {
      await api.put('/persona', { personality: d.personality.trim(), limits: d.limits.map(l => l.trim()).filter(Boolean) })
      if (d.up !== initial!.up || d.down !== initial!.down) await update.mutateAsync({ config: { up: d.up, down: d.down } })
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['persona'] }); setDraft(undefined) },
  })
  useEffect(() => { if (!draft && initial && !save.isPending) setDraft(initial) }, [draft, persona])
  if (!draft || !view) return <div className="flex-1" />
  const set = (p: Partial<typeof draft>) => setDraft({ ...draft, ...p })
  const savedTone = resolveTone(view.tone)
  const activeTone = livePos ? resolveTone(livePos) : savedTone
  const commitTone = (next: { x: number; y: number }) => {
    setLivePos(null)
    update.mutate({ tone: next })
  }
  const Head = ({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) => (
    <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className="text-[13px] font-medium">{title}</h3>
      <p className="text-xs text-muted">{sub}</p>
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  )
  return <>
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-6 py-3.5">
      <div>
        <Head
          title={tx('语调偏向')}
          sub={tx('日常说话的语气偏向，松手即生效')}
          right={<>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg tabular-nums">
              <span className={cx('size-[7px] rounded-full', activeTone.id === 'natural' && 'border border-muted bg-transparent')}
                style={activeTone.id === 'natural' ? undefined : { backgroundColor: toneDotHex(activeTone.id, isDark) }} />
              {activeTone.id === 'natural' ? tx('自然') : tx('偏{0} · {1}%', activeTone.label, Math.round(activeTone.strength * 100))}
            </span>
            {activeTone.id !== 'natural' && (
              <button type="button" onClick={() => commitTone({ x: 0, y: 0 })}
                className="press inline-flex h-5 items-center gap-1 rounded-md border border-line bg-card px-1.5 text-[11px] text-muted hover:border-faint hover:text-fg">
                {tx('归中')}
              </button>
            )}
          </>}
        />
        <ToneDotPad value={{ x: savedTone.x, y: savedTone.y }} onLiveChange={setLivePos} onCommit={commitTone} className="h-[130px] w-full" />
      </div>
      <div>
        <Head title={tx('性格底色')} sub={tx('它是什么样的人。每句话都会照着来；心情只改语气，不改这个。')} />
        <textarea rows={2} value={draft.personality} onChange={e => set({ personality: e.target.value })} maxLength={1000} placeholder={tx('说话直接，先说结论，偶尔开个玩笑。')}
          className="min-h-[58px] w-full resize-y rounded-xl border border-line bg-card px-3.5 py-2 text-sm leading-[20px] outline-none focus:border-faint" />
      </div>
      <div>
        <Head title={tx('互动底线')} sub={tx('不管心情多好、你怎么说，它都守着的几条。')} />
        <div className="rounded-xl bg-sunken px-4 py-0.5">
          {draft.limits.map((l, i) => <div key={i} className="flex items-center gap-2.5 border-b border-line py-0.5 last:border-b-0">
            <input value={l} maxLength={80} onChange={e => set({ limits: draft.limits.map((x, j) => j === i ? e.target.value : x) })} aria-label={tx('底线 {0}', i + 1)}
              placeholder={tx('一句话，比如：被骂了不讨好地道歉')} className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
            <button type="button" onClick={() => set({ limits: draft.limits.filter((_, j) => j !== i) })} aria-label={tx('删掉')} className="press text-faint hover:text-fg"><X size={14} /></button>
          </div>)}
          {draft.limits.length < 8 && <button type="button" onClick={() => set({ limits: [...draft.limits, ''] })} className="press flex h-7 items-center gap-1 text-[13px] text-muted hover:text-fg"><Plus size={13} />{tx('加一条')}</button>}
        </div>
      </div>
      <div>
        <Head title={tx('敏感度')} sub={tx('同样一句话，对它影响多大。')} />
        <div className="grid grid-cols-2 gap-4 rounded-xl bg-sunken px-4 py-2.5 max-sm:grid-cols-1">
          <Slider label={tx('被夸')} note={tx('开心起来有多快')} value={draft.up} min={0.2} max={2.5} step={0.1} base={1} shown={v => `×${v.toFixed(1)}`} onCommit={up => set({ up })} />
          <Slider label={tx('被冷落')} note={tx('受伤有多深')} value={draft.down} min={0.2} max={2.5} step={0.1} base={1} shown={v => `×${v.toFixed(1)}`} onCommit={down => set({ down })} />
        </div>
      </div>
    </div>
    {(changed > 0 || save.error) && <div className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-2.5">
      <span className={cx('mr-auto text-xs', save.error ? 'text-danger' : 'text-muted')}>{save.error ? (save.error as Error).message : tx('改了 {0} 项', changed)}</span>
      <button type="button" onClick={() => setDraft(initial)} className="press h-8 rounded-lg border border-line px-3 text-xs hover:bg-sunken">{tx('还原')}</button>
      <button type="button" onClick={() => save.mutate(draft)} disabled={save.isPending} className="press h-8 rounded-lg bg-ink px-3.5 text-xs font-medium text-ink-fg disabled:opacity-50">{tx('保存')}</button>
    </div>}
  </>
}

function DiaryPage() {
  const { view, update, put } = useMood()
  const pin = useMutation({ mutationFn: (v: { id: string; pinned: boolean }) => api.post<{ mood: MoodView }>(`/mood/diary/${v.id}`, { pinned: v.pinned }), onSuccess: put })
  const remove = useMutation({ mutationFn: (id: string) => api.del<{ mood: MoodView }>(`/mood/diary/${id}`), onSuccess: put })
  if (!view) return <div className="flex-1" />
  const list = [...view.diary.filter(d => d.pinned), ...view.diary.filter(d => !d.pinned)]
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
    <div className="flex items-center gap-3">
      <p className="flex-1 text-xs text-muted text-pretty">{tx('它用自己的话记下的感受。只在聊到感受时翻出来用，干活时不看。')}</p>
      <span className="text-xs">{tx('记日记')}</span>
      <Switch on={view.config.diary} onChange={diary => update.mutate({ config: { diary } })} label={tx('记日记')} />
    </div>
    {list.length ? <>
      <ul className="mt-4">{list.map(d => <li key={d.id} className="flex gap-3 border-t border-line py-3.5">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs text-muted">{when(d.at)}{d.pinned && <span className="flex items-center gap-1 text-fg"><Pin size={12} />{tx('置顶，不会淡忘')}</span>}</p>
          <p className="mt-1 text-sm leading-[22px] text-pretty">{d.text}</p>
        </div>
        <button type="button" onClick={() => pin.mutate({ id: d.id, pinned: !d.pinned })} aria-label={d.pinned ? tx('取消置顶') : tx('置顶')} title={d.pinned ? tx('取消置顶') : tx('置顶')}
          className={cx('press flex size-7 items-center justify-center rounded-lg hover:bg-sunken', d.pinned ? 'text-fg' : 'text-faint hover:text-fg')}><Pin size={15} /></button>
        <button type="button" onClick={() => { if (confirm(tx('删掉这条日记？'))) remove.mutate(d.id) }} aria-label={tx('删掉')} title={tx('删掉')}
          className="press flex size-7 items-center justify-center rounded-lg text-faint hover:bg-sunken hover:text-fg"><Trash2 size={15} /></button>
      </li>)}</ul>
      <p className="mt-1 text-xs text-muted">{tx('没置顶的会慢慢淡忘；置顶的一直留着。')}</p>
    </> : <div className="flex flex-col items-center gap-2 pt-28 text-center">
      <BookOpen size={28} className="text-faint" />
      <p className="text-sm font-medium">{tx('还没写过日记')}</p>
      <p className="text-xs text-muted">{tx('聊得多了，它会在有感触的时候记一笔。')}</p>
    </div>}
  </div>
}
