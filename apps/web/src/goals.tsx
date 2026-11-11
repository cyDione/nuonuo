/**
 * 目标 (Figma v6, 19b and the right pane's 目标): long-running aims the owner sets by telling 糯糯 「我想……」. One colour
 * card for the goal pinned to the top (its big number counts up, its days light up one by one), the rest on grey; what
 * 糯糯 did toward them this week. Nothing here is typed into a form: new goals start in the conversation.
 */
import { CountingNumber } from '@animate-ui/react/primitives/texts/counting-number'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, ChevronRight, Code, Dumbbell, Footprints, Globe, Heart, Leaf, Moon, MoreHorizontal, Music, PenLine, Pin, Plus, Target, Wallet, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type Goal, type GoalIcon, type GoalLogEntry } from './api'
import { prefillComposer } from './Chat'
import { Avatar, usePersona } from './persona'
import { go } from './route'
import { cx } from './ui'

const ICONS: Record<GoalIcon, LucideIcon> = { target: Target, moon: Moon, wallet: Wallet, book: BookOpen, run: Footprints, dumbbell: Dumbbell, heart: Heart, music: Music, code: Code, leaf: Leaf, globe: Globe, pen: PenLine }
const money = (unit: string) => unit === '元' || unit === '¥' || unit === '￥'
const num = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
/** "¥6,400 / 12,000", "1 / 2 本", "第 9 / 21 天". */
export function amount(g: Goal) {
  if (g.style === 'days') return `${num(g.current)} / ${num(g.target)} 天`
  return money(g.unit) ? `¥${num(g.current)} / ${num(g.target)}` : `${num(g.current)} / ${num(g.target)}${g.unit ? ` ${g.unit}` : ''}`
}
const share = (g: Goal) => Math.max(0, Math.min(1, g.target ? g.current / g.target : 0))

export const useGoals = () => useQuery({ queryKey: ['goals'], queryFn: () => api.get<{ goals: Goal[]; week: GoalLogEntry[] }>('/goals') })

/** Starts a new goal the way the page says: in the main conversation, with 「我想」 already typed. */
export function newGoal() { go('/'); prefillComposer('我想') }

/** A bar that fills from empty to the goal's progress when it appears. */
export function Bar({ value, className, tone = 'ink' }: { value: number; className?: string; tone?: 'ink' | 'white' | 'accent' }) {
  const [shown, setShown] = useState(0)
  useEffect(() => { const f = requestAnimationFrame(() => setShown(value)); return () => cancelAnimationFrame(f) }, [value])
  return <span className={cx('block h-1.5 overflow-hidden rounded-full', tone === 'white' ? 'bg-white/25' : 'bg-hero-2', className)}>
    <span className={cx('grow-bar block h-full origin-left rounded-full', tone === 'white' ? 'bg-white' : tone === 'accent' ? 'bg-accent' : 'bg-fg')} style={{ transform: `scaleX(${shown})` }} />
  </span>
}

export function GoalsPage() {
  const data = useGoals().data
  const persona = usePersona()
  const active = data?.goals.filter(g => g.status === 'active') ?? []
  const done = data?.goals.filter(g => g.status === 'done') ?? []
  const featured = active.find(g => g.pinned) ?? active[0]
  const rest = active.filter(g => g !== featured)
  return <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-[640px] px-4 pt-6 pb-12 md:px-8">
      <h1 className="text-[28px] font-semibold">目标</h1>
      <p className="mt-1 text-sm text-muted">长期的事，{persona.name}帮你记着进度</p>
      <div className="mt-6 space-y-3">
        {featured && <Featured g={featured} />}
        {rest.map(g => <GoalCard key={g.id} g={g} />)}
        <button onClick={newGoal} className="press flex w-full items-center gap-3 rounded-2xl border border-dashed border-line px-5 py-4 text-left text-sm text-muted hover:border-faint hover:text-fg">
          <Plus size={17} />新目标：跟{persona.name}说一句就行，比如「我想每周跑三次」
        </button>
      </div>
      {data && data.week.length > 0 && <section className="mt-10">
        <h2 className="mb-3 text-xs text-muted">这周它帮你做的</h2>
        <ul className="space-y-2 text-sm">{data.week.slice(0, 8).map(e => <li key={e.id} className="flex gap-3">
          <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" /><span className="min-w-0 flex-1">{e.text}<span className="ml-2 text-xs text-faint">{e.goal}</span></span>
        </li>)}</ul>
      </section>}
      {done.length > 0 && <section className="mt-10">
        <h2 className="mb-3 text-xs text-muted">完成了</h2>
        <div className="space-y-1">{done.map(g => <div key={g.id} className="flex items-center gap-3 py-1.5 text-sm">
          <Check size={15} className="text-ok" /><span className="flex-1">{g.title}</span><span className="text-xs text-faint tabular-nums">{amount(g)}</span>
        </div>)}</div>
      </section>}
      <div className="mt-10 flex items-center gap-3 text-sm text-muted">
        <Avatar persona={persona} size={28} mood="happy" />想让它每周跟你对一次进度？在聊天里说一声就行。
      </div>
    </div>
  </div>
}

/** The pinned goal: the page's one colour card. */
function Featured({ g }: { g: Goal }) {
  const Icon = ICONS[g.icon] ?? Target
  const head = g.headline
  const big = head ? Number(head.value) : g.style === 'days' ? g.current : g.current
  const numeric = Number.isFinite(big)
  const dots = g.style === 'days' && g.target <= 40 ? Math.round(g.target) : 0
  return <div data-tone="teal" className="flow anim-rise relative rounded-[22px] px-6 pt-5 pb-5">
    <div className="relative flex items-start">
      <div className="min-w-0 flex-1">
        <div className="text-xs opacity-80">{g.title}{g.style === 'days' ? ` · 第 ${num(g.current)} / ${num(g.target)} 天` : ''}</div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-[52px] leading-none font-semibold tabular-nums">
            {head && !numeric ? head.value : <CountingNumber number={numeric ? big : 0} decimalPlaces={String(head?.value ?? big).includes('.') ? 1 : 0} thousandSeparator="," transition={{ stiffness: 90, damping: 30 }} />}
          </span>
          <span className="text-sm opacity-85">{head ? head.unit : g.style === 'days' ? '天' : money(g.unit) ? `元 / ${num(g.target)}` : `${g.unit} / ${num(g.target)}`}</span>
        </div>
        <p className="mt-3 text-sm opacity-90">{head?.note ?? g.note ?? ''}</p>
      </div>
      <Icon size={64} strokeWidth={1.4} className="mt-6 mr-2 shrink-0 opacity-35" aria-hidden />
      <span className="absolute -top-1 -right-2"><Menu g={g} light /></span>
    </div>
    <div className="relative mt-4">
      {dots ? <div className="flex flex-wrap gap-2" aria-label={`第 ${g.current} / ${g.target} 天`}>
        {Array.from({ length: dots }, (_, i) => <span key={i} className={cx('dot-in size-2.5 rounded-full', i < g.current ? 'bg-white' : 'bg-white/30')} style={{ animationDelay: `${i * 30}ms` }} />)}
      </div> : <Bar value={share(g)} tone="white" />}
    </div>
    <button onClick={() => { go('/'); prefillComposer(`聊聊「${g.title}」的进度`) }} className="press relative mt-4 h-8 rounded-full bg-white px-3.5 text-[13px] font-medium text-[#0b3d3a]">跟它聊聊</button>
  </div>
}

function GoalCard({ g }: { g: Goal }) {
  const Icon = ICONS[g.icon] ?? Target
  return <div className="anim-rise group rounded-2xl bg-sunken px-5 pt-4 pb-5">
    <div className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-panel"><Icon size={17} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{g.title}</span>
        {g.note && <span className="mt-0.5 block truncate text-xs text-muted">{g.note}</span>}
      </span>
      <span className="shrink-0 text-sm font-semibold tabular-nums">{amount(g)}</span>
      <Menu g={g} />
    </div>
    <Bar value={share(g)} className="mt-4" />
  </div>
}

/** Pin to the top, finish, or drop a goal. */
function Menu({ g, light }: { g: Goal; light?: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const patch = useMutation({ mutationFn: (body: Partial<Goal>) => api.patch(`/goals/${g.id}`, body), onSettled: () => qc.invalidateQueries({ queryKey: ['goals'] }) })
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [open])
  const item = (icon: React.ReactNode, label: string, body: Partial<Goal>) => <button role="menuitem" onClick={() => { setOpen(false); patch.mutate(body) }}
    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-fg hover:bg-sunken">{icon}{label}</button>
  return <div ref={ref} className="relative -mt-1 -mr-2">
    <button onClick={() => setOpen(v => !v)} aria-label="更多" aria-expanded={open}
      className={cx('press flex size-8 items-center justify-center rounded-full', light ? 'text-white/80 hover:bg-white/15' : 'text-faint opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-fg focus-visible:opacity-100', open && 'opacity-100')}>
      <MoreHorizontal size={16} /></button>
    {open && <div role="menu" className="anim-menu absolute top-9 right-0 z-20 w-36 rounded-2xl border border-line bg-panel p-1 shadow-xl">
      {!g.pinned && item(<Pin size={14} />, '放到最上面', { pinned: true })}
      {item(<Check size={14} />, '完成了', { status: 'done' })}
      {item(<X size={14} />, '不做了', { status: 'dropped' })}
    </div>}
  </div>
}

