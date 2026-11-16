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
import { Switch } from './skills'
import { cx, Seg } from './ui'

interface MoodPoint { at: number; mood: number; undertone?: number; energy: number; patience?: number; trust: number; attitude?: string; note?: string }
interface DiaryEntry { id: string; at: number; text: string; mood: number; pinned: boolean }
interface Baseline { mood: number; energy: number; patience: number; trust: number }
export interface MoodView {
  enabled: boolean; mood: number; undertone?: number; energy: number; patience: number; trust: number; summary: string; history: MoodPoint[]
  stance: { id: string; name: string; why: string }; config: { up: number; down: number; diary: boolean }; baseline: Baseline; diary: DiaryEntry[]
}
type Values = Pick<MoodView, 'mood' | 'energy' | 'patience' | 'trust'>

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
    mutationFn: (body: { enabled?: boolean; values?: Partial<Values>; config?: Partial<MoodView['config']> }) => api.put<{ mood: MoodView }>('/mood', body),
    onMutate: body => qc.setQueryData<{ mood: MoodView }>(['mood'], old => old && { mood: { ...old.mood, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.values ?? {}), config: { ...old.mood.config, ...(body.config ?? {}) } } }),
    onSuccess: put, onError: () => qc.invalidateQueries({ queryKey: ['mood'] }),
  })
  return { view, put, update }
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

export function MoodSection({ Head }: { Head: React.ComponentType<{ title: string; count?: number | string | undefined; action?: React.ReactNode }> }) {
  const { view } = useMood()
  const persona = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona') }).data?.persona
  const [openTab, setOpenTab] = useState<Tab | null>(null)
  if (!view) return null
  const base = persona?.personality.trim()
  return <section className="border-t border-line pt-5">
    <Head title={tx('个性与心境')} action={
      <button type="button" onClick={() => setOpenTab('now')} className="press -my-1 -mr-1.5 inline-flex h-7 items-center gap-0.5 rounded-lg px-1.5 text-xs font-medium text-fg hover:bg-sunken">
        {tx('打开')}<ChevronRight size={13} className="text-muted" />
      </button>
    } />
    {view.enabled ? <button type="button" onClick={() => setOpenTab('now')}
      className="block w-full rounded-2xl bg-sunken p-3 text-left transition-[transform,background-color] duration-150 ease-[var(--ease-out-strong)] hover:bg-hero-2/65 active:scale-[0.985] motion-reduce:transition-none motion-reduce:active:scale-100">
      <div className="flex items-center gap-2 pb-2.5">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-card py-1 pr-2.5 pl-2 text-xs font-medium text-fg">
          <span className={cx('size-[7px] shrink-0 rounded-full', stanceDot(view.stance.id))} />
          {STANCE[view.stance.id] ?? view.stance.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted">{moodLine(view)}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <BipolarTile label={tx('心情')} sub={moodShort(view.mood)} value={view.mood} shown={sign(view.mood)} />
        <PipTile label={tx('精力')} sub={energyShort(view.energy)} value={view.energy} shown={`${Math.round(view.energy * 100)}%`} />
        <PipTile label={tx('耐心')} sub={patienceShort(view.patience)} value={view.patience / 100} shown={String(Math.round(view.patience))} warn={view.patience < 35} />
        <PipTile label={tx('信任')} sub={trustShort(view.trust)} value={view.trust / 100} shown={String(Math.round(view.trust))} />
      </div>
      {view.history.length > 1 && <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-line pt-2.5">
        <span className="shrink-0 text-[11px] text-faint tabular-nums">{tx('最近 {0} 轮', view.history.length)}</span>
        <Trend points={view.history} base={view.undertone ?? view.baseline.mood} positive={view.mood >= 0} />
      </div>}
    </button> : <div className="flex items-center justify-between gap-3 rounded-2xl bg-sunken px-3.5 py-3">
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
  const persona = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona') }).data?.persona
  const [draft, setDraft] = useState<{ personality: string; limits: string[]; up: number; down: number }>()
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
  const Head = ({ title, sub }: { title: string; sub: string }) => <div><h3 className="text-[13px] font-medium">{title}</h3><p className="mt-0.5 text-xs text-muted">{sub}</p></div>
  return <>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
      <Head title={tx('性格底色')} sub={tx('它是什么样的人。每句话都会照着来；心情只改语气，不改这个。')} />
      <textarea value={draft.personality} onChange={e => set({ personality: e.target.value })} maxLength={1000} placeholder={tx('说话直接，先说结论，偶尔开个玩笑。')}
        className="min-h-[88px] w-full resize-y rounded-xl border border-line bg-card px-3.5 py-3 text-sm leading-[22px] outline-none focus:border-faint" />
      <Head title={tx('互动底线')} sub={tx('不管心情多好、你怎么说，它都守着的几条。')} />
      <div className="rounded-xl bg-sunken px-4 py-1">
        {draft.limits.map((l, i) => <div key={i} className="flex items-center gap-2.5 border-b border-line py-1.5 last:border-b-0">
          <input value={l} maxLength={80} onChange={e => set({ limits: draft.limits.map((x, j) => j === i ? e.target.value : x) })} aria-label={tx('底线 {0}', i + 1)}
            placeholder={tx('一句话，比如：被骂了不讨好地道歉')} className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
          <button type="button" onClick={() => set({ limits: draft.limits.filter((_, j) => j !== i) })} aria-label={tx('删掉')} className="press text-faint hover:text-fg"><X size={14} /></button>
        </div>)}
        {draft.limits.length < 8 && <button type="button" onClick={() => set({ limits: [...draft.limits, ''] })} className="press flex h-9 items-center gap-1 text-[13px] text-muted hover:text-fg"><Plus size={13} />{tx('加一条')}</button>}
      </div>
      <Head title={tx('敏感度')} sub={tx('同样一句话，对它影响多大。')} />
      <div className="space-y-4 rounded-xl bg-sunken px-4 py-3.5">
        <Slider label={tx('被夸')} note={tx('开心起来有多快')} value={draft.up} min={0.2} max={2.5} step={0.1} base={1} shown={v => `×${v.toFixed(1)}`} onCommit={up => set({ up })} />
        <Slider label={tx('被冷落')} note={tx('受伤有多深')} value={draft.down} min={0.2} max={2.5} step={0.1} base={1} shown={v => `×${v.toFixed(1)}`} onCommit={down => set({ down })} />
      </div>
    </div>
    {(changed > 0 || save.error) && <div className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-3">
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
