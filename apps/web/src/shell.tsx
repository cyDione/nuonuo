/**
 * The window around the pages (Figma "v4 · 桌面端"): side panes that resize by dragging and fold away, the desktop app's
 * title bar area, scrollbars that show while scrolling, and the pointer-following tilt used by cards.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PanelLeft } from 'lucide-react'
import { cx, IconButton } from './ui'

interface DesktopBridge { isDesktop: true; platform: string; setBadge?(n: number): void; on?(event: string, fn: (value: unknown) => void): void; quick?(action: 'hide' | 'open', hash?: string): void }
export const desktop = (window as { superAssistantDesktop?: DesktopBridge }).superAssistantDesktop
export const isMacDesktop = desktop?.platform === 'darwin'

// ── Pane sizes, remembered per device ───────────────────────────────────────
export type PaneSide = 'left' | 'right'
const LIMITS = { left: { min: 200, max: 360, initial: 252 }, right: { min: 320, max: 460, initial: 360 } }
interface Panes { left: number; right: number; leftOpen: boolean; rightOpen: boolean }
const load = (): Panes => {
  // The right pane opens from 糯糯 in the sidebar; the chat has the window to itself until then.
  const base = { left: LIMITS.left.initial, right: LIMITS.right.initial, leftOpen: true, rightOpen: false }
  try {
    const saved = JSON.parse(localStorage.getItem('sa-panes') ?? '{}') as Partial<Panes>
    // The right pane used to be remembered on its own.
    if (localStorage.getItem('sa-today') === 'hidden' && saved.rightOpen === undefined) saved.rightOpen = false
    return { ...base, ...saved }
  } catch { return base }
}
let panes = load()
const paneListeners = new Set<() => void>()
function setPanes(patch: Partial<Panes>) {
  panes = { ...panes, ...patch }
  try { localStorage.setItem('sa-panes', JSON.stringify(panes)) } catch { /* private mode */ }
  for (const l of paneListeners) l()
}
export const usePanes = () => useSyncExternalStore(l => { paneListeners.add(l); return () => paneListeners.delete(l) }, () => panes)
export const togglePane = (side: PaneSide, open?: boolean) => setPanes(side === 'left' ? { leftOpen: open ?? !panes.leftOpen } : { rightOpen: open ?? !panes.rightOpen })

/** Keyboard shortcuts are used many times a day, so what they do happens at once, without the folding animation. */
function instantly(fn: () => void) {
  const root = document.documentElement
  root.dataset.instant = ''
  fn()
  requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.instant))
}

/** ⌘\ folds the left pane, ⌘. the right one (Ctrl on Windows and Linux). */
export function usePaneShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === '\\') { e.preventDefault(); instantly(() => togglePane('left')) }
      else if (e.key === '.') { e.preventDefault(); instantly(() => togglePane('right')) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
}

/** A side pane: animates its width when it opens or folds, and keeps its content at full width while it does. */
export function Pane({ side, className, children }: { side: PaneSide; className?: string; children: React.ReactNode }) {
  const p = usePanes()
  const open = side === 'left' ? p.leftOpen : p.rightOpen
  const width = side === 'left' ? p.left : p.right
  return <div className={cx('pane relative flex shrink-0', className)} data-open={open} data-pane={side}
    style={{ width: open ? width : 0, ['--pane-shift' as string]: side === 'left' ? '-12px' : '12px' }} aria-hidden={!open || undefined} {...(!open ? { inert: true } : {})}>
    <div className="pane-inner flex h-full shrink-0" style={{ width }}>{children}</div>
  </div>
}

/**
 * The gap between two panes: drag to resize (the width shows while dragging), drag below the minimum to fold the pane,
 * double-click to restore the default width.
 */
export function Resizer({ side }: { side: PaneSide }) {
  const ref = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  const p = usePanes()
  const open = side === 'left' ? p.leftOpen : p.rightOpen
  if (!open) return side === 'left' ? <div className="w-2 shrink-0" /> : null
  const limits = LIMITS[side]
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = ref.current!
    const pane = document.querySelector<HTMLElement>(`[data-pane="${side}"]`)
    const inner = pane?.firstElementChild as HTMLElement | null
    const startX = e.clientX, start = side === 'left' ? panes.left : panes.right
    let width = start, fold = false
    el.setPointerCapture(e.pointerId)
    el.dataset.dragging = ''
    pane?.setAttribute('data-dragging', '')
    document.body.classList.add('resizing')
    const move = (ev: PointerEvent) => {
      const dx = side === 'left' ? ev.clientX - startX : startX - ev.clientX
      const raw = start + dx
      fold = raw < limits.min - 56
      width = Math.round(Math.min(limits.max, Math.max(limits.min, raw)))
      if (pane) { pane.style.width = `${fold ? Math.max(0, raw) : width}px`; pane.style.opacity = fold ? '0.5' : '' }
      if (inner) inner.style.width = `${width}px`
      if (tip.current) { tip.current.textContent = fold ? '收起' : `${width}`; tip.current.style.opacity = '1' }
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      delete el.dataset.dragging
      pane?.removeAttribute('data-dragging')
      document.body.classList.remove('resizing')
      // Leave the inline sizes at what React is about to render, so nothing jumps.
      if (pane) { pane.style.width = `${fold ? 0 : width}px`; pane.style.opacity = '' }
      if (inner) inner.style.width = `${fold ? start : width}px`
      if (tip.current) tip.current.style.opacity = '0'
      if (fold) setPanes(side === 'left' ? { leftOpen: false } : { rightOpen: false })
      else setPanes(side === 'left' ? { left: width } : { right: width })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up, { once: true })
    el.addEventListener('pointercancel', up, { once: true })
  }
  return <div ref={ref} role="separator" aria-orientation="vertical" aria-label={side === 'left' ? '调整侧栏宽度' : '调整右栏宽度'} title="拖动调整宽度 · 双击恢复"
    className="resizer no-drag" onPointerDown={onDown} onDoubleClick={() => setPanes(side === 'left' ? { left: limits.initial } : { right: limits.initial })}>
    <span ref={tip} className={cx('pointer-events-none absolute top-1/2 -mt-3 rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-ink-fg tabular-nums opacity-0 transition-opacity', side === 'left' ? 'left-3' : 'right-3')} />
  </div>
}

/**
 * The top of the main sheet: part of the window's title bar on the desktop app (drag it to move the window). When the
 * sidebar is folded, it holds the button that brings it back, clear of the traffic lights.
 */
export function TopBar({ children, right, className }: { children?: React.ReactNode; right?: React.ReactNode; className?: string }) {
  const { leftOpen } = usePanes()
  return <div className={cx('drag flex h-12 shrink-0 items-center gap-2 px-3', className)}>
    {!leftOpen && <span className={cx('anim-fade flex items-center max-md:hidden', isMacDesktop && 'lights-room pl-[64px]')}>
      <IconButton label="展开侧栏 (⌘\)" onClick={() => togglePane('left', true)} className="size-8"><PanelLeft size={17} /></IconButton>
    </span>}
    <div className="flex min-w-0 flex-1 items-center gap-2.5">{children}</div>
    {right}
  </div>
}

// ── Scrollbars show while scrolling ─────────────────────────────────────────
export function useScrollingClass() {
  useEffect(() => {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
    const onScroll = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.scrollingElement
      if (!el) return
      el.classList.add('is-scrolling')
      clearTimeout(timers.get(el))
      timers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 1000))
    }
    addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => removeEventListener('scroll', onScroll, { capture: true })
  }, [])
}

/** Marks the page as running in the desktop app (title bar area, drag regions, dimmed when the window is in the background). */
export function useDesktopChrome() {
  useEffect(() => {
    if (!desktop) return
    const root = document.documentElement
    root.classList.add('desktop', `desktop-${desktop.platform}`)
    desktop.on?.('focus', v => root.classList.toggle('blurred', !v))
    desktop.on?.('fullscreen', v => root.classList.toggle('fullscreen', Boolean(v)))
  }, [])
}

// ── Pointer tilt ────────────────────────────────────────────────────────────
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(hover: none)').matches
/** Leans a card toward the pointer (at most `max` degrees) and moves a soft light under it. Pair with the `tilt` class. */
export function useTilt<T extends HTMLElement>(max = 3) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || still()) return
    let frame = 0
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
        el.dataset.hover = ''
        el.style.setProperty('--mx', `${x * 100}%`)
        el.style.setProperty('--my', `${y * 100}%`)
        el.style.setProperty('--ry', `${(x - 0.5) * 2 * max}deg`)
        el.style.setProperty('--rx', `${(0.5 - y) * 2 * max * 0.7}deg`)
        el.style.setProperty('--ty', '-2px')
      })
    }
    const leave = () => {
      cancelAnimationFrame(frame)
      delete el.dataset.hover
      for (const k of ['--rx', '--ry', '--ty']) el.style.removeProperty(k)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave); cancelAnimationFrame(frame) }
  }, [max])
  return ref
}

/**
 * Keeps something on screen while it animates out: returns the value to render (the last non-empty one while closing)
 * and whether it is on its way out, so drawers and sheets close with motion instead of vanishing.
 */
export function usePresence<T>(value: T | null | undefined | false, ms = 220): { shown: T | null; leaving: boolean } {
  const [state, setState] = useState<{ shown: T | null; leaving: boolean }>({ shown: value || null, leaving: false })
  useEffect(() => {
    if (value) { setState({ shown: value, leaving: false }); return }
    if (!state.shown) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setState({ shown: null, leaving: false }); return }
    setState(s => ({ ...s, leaving: true }))
    const t = setTimeout(() => setState({ shown: null, leaving: false }), ms)
    return () => clearTimeout(t)
  }, [value])
  return state
}
