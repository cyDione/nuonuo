/**
 * 动态 (Figma v6, 19a): what changed in the things 糯糯 watches for you. Only changes show up here, grouped by day; the
 * one that matters most gets the colour card (its number slides from what it was to what it is), everything else is a
 * grey row. The page ends with 「就这些」. What is running and waiting lives in the right pane's 活动, and every raw event
 * in 设置 · 数据和隐私 · 原始记录 (v7), not here.
 */
import { SlidingNumber } from '@animate-ui/react/primitives/texts/sliding-number'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Bookmark, Calendar, ChartLine, CloudSun, Heart, House, LineChart, Mail, Newspaper, Package, Plane, Tag, ThumbsDown, ThumbsUp, TrendingDown, TrendingUp, Wifi, X, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ActivityEvent, type FeedIcon, type FeedItem } from './api'
import { openTask } from './live'
import { Avatar, usePersona } from './persona'
import { SourceIcon, SOURCE_LABEL } from './icons'
import { cx } from './ui'
import { go } from './route'

const ICONS: Record<FeedIcon, LucideIcon> = { bell: Bell, tag: Tag, weather: CloudSun, mail: Mail, wifi: Wifi, plane: Plane, calendar: Calendar, package: Package, chart: ChartLine, news: Newspaper, home: House, heart: Heart }
const hm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
function dayLabel(at: number) {
  const d = new Date(at), today = new Date()
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  return days === 0 ? '今天' : days === 1 ? '昨天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

export const useFeed = () => useQuery({ queryKey: ['feed'], queryFn: () => api.get<{ items: FeedItem[]; unseen: number }>('/feed') })

/** One row of the page: a change it posted, or something it noticed on its own and is asking about. */
type Entry = { at: number; key: string; item?: FeedItem; noticed?: ActivityEvent }

export function Activity() {
  const persona = usePersona()
  const qc = useQueryClient()
  const feed = useFeed().data
  const activity = useQuery({ queryKey: ['activity'], queryFn: () => api.get<{ proactive: string; events: ActivityEvent[] }>('/activity') }).data
  // Opening the page is seeing it: the dot on the 动态 tab goes away.
  useEffect(() => { if (feed?.unseen) void api.post('/feed/seen').then(() => qc.invalidateQueries({ queryKey: ['feed'] })) }, [feed?.unseen])

  const [onlySaved, setOnlySaved] = useState(false)
  const [undo, setUndo] = useState<FeedItem | null>(null)
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 5_000); return () => clearTimeout(t) }, [undo])
  const savedCount = (feed?.items ?? []).filter(i => i.saved).length
  const items = (feed?.items ?? []).filter(i => !onlySaved || i.saved)
  const hero = onlySaved ? undefined : items.find(i => i.card)
  const noticed = (activity?.events ?? []).filter(e => e.proactive?.act && !e.feedback && !e.ticketId).slice(0, 10)
  const entries: Entry[] = [
    ...items.filter(i => i !== hero).map(i => ({ at: i.at, key: i.id, item: i })),
    ...(onlySaved ? [] : noticed).map(e => ({ at: e.at, key: e.id, noticed: e })),
  ].sort((a, b) => b.at - a.at)
  const groups: { day: string; entries: Entry[]; hero?: FeedItem }[] = []
  const heroDay = hero ? dayLabel(hero.at) : null
  for (const e of entries) {
    const day = dayLabel(e.at)
    const g = groups.at(-1)
    if (g?.day === day) g.entries.push(e); else groups.push({ day, entries: [e] })
  }
  if (hero) {
    const g = groups.find(g => g.day === heroDay)
    if (g) g.hero = hero; else groups.unshift({ day: heroDay!, entries: [], hero })
  }
  const loaded = !!feed && !!activity
  const empty = loaded && !groups.length

  return <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-[37.5rem] px-4 pt-8 pb-16 md:px-0">
      <header className="anim-rise flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-3xl font-semibold">动态</h1>
          <p className="mt-1.5 text-sm text-muted">{onlySaved ? '你收藏的，不会过期' : '它替你盯着的事，有变化才出现在这里'}</p>
        </div>
        {(savedCount > 0 || onlySaved) && <button onClick={() => setOnlySaved(v => !v)} aria-pressed={onlySaved}
          className={cx('press mt-1.5 flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px]', onlySaved ? 'border-ink bg-ink text-ink-fg' : 'border-line text-muted hover:border-faint hover:text-fg')}>
          <Bookmark size={13} fill={onlySaved ? 'currentColor' : 'none'} />收藏 {savedCount}</button>}
      </header>

      {groups.map((g, gi) => <section key={g.day} className="mt-8">
        <h2 className="mb-2.5 text-xs text-muted">{g.day}</h2>
        <div className="space-y-3">
          {g.hero && !onlySaved && <Hero item={g.hero} />}
          {g.entries.map((e, i) => <div key={e.key} className="feed-in" style={{ animationDelay: `${Math.min(gi * 3 + i + (g.hero ? 1 : 0), 8) * 60}ms` }}>
            {e.item ? <Row item={e.item} onDown={setUndo} /> : <Noticed e={e.noticed!} />}
          </div>)}
        </div>
      </section>)}

      {loaded && <div className="mt-8 flex items-center gap-3 text-sm text-muted">
        <Avatar persona={persona} size={28} mood="happy" />
        {empty && onlySaved ? '还没收藏过。把鼠标放到一条上，点书签就能留下它。' : empty ? `还没有变化。想让${persona.name}帮你盯着什么，在聊天里说一声，比如「XM6 降到 2000 以下告诉我」。` : '就这些。有新的我再叫你，不会一直推。'}
      </div>}

    </div>
    {undo && <Toast key={undo.id} text={`好，「${undo.title.length > 12 ? undo.title.slice(0, 12) + '…' : undo.title}」这类以后少告诉你一些`}
      onUndo={() => { void api.post(`/feed/${undo.id}/react`, { reaction: null }).then(() => qc.invalidateQueries({ queryKey: ['feed'] })); setUndo(null) }} />}
  </div>
}

function Toast({ text, onUndo }: { text: string; onUndo(): void }) {
  return <div role="status" className="anim-rise fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
    <div className="flex max-w-full items-center gap-6 rounded-full bg-ink py-2.5 pr-3 pl-5 text-[13px] text-ink-fg shadow-xl">
      <span className="min-w-0 truncate">{text}</span>
      <button onClick={onUndo} className="press shrink-0 rounded-full px-3 py-1 font-medium text-accent hover:bg-white/10">撤销</button>
    </div>
  </div>
}

/** The one change that matters most: its number slides from what it was to what it is now. */
function Hero({ item }: { item: FeedItem }) {
  const qc = useQueryClient()
  const card = item.card!
  const money = card.unit === '¥' || card.unit === '元'
  const [shown, setShown] = useState(card.was ?? card.value)
  useEffect(() => { const t = setTimeout(() => setShown(card.value), 450); return () => clearTimeout(t) }, [card.value])
  const dismiss = useMutation({ mutationFn: () => api.post(`/feed/${item.id}/dismiss`), onSuccess: () => qc.invalidateQueries({ queryKey: ['feed'] }) })
  const down = card.was !== undefined && card.value < card.was
  const Trend = down ? TrendingDown : TrendingUp
  const decimals = String(card.value).split('.')[1]?.length ?? 0
  return <div data-tone="sky" className="flow feed-in relative rounded-[22px] px-6 pt-5 pb-5">
    <div className="relative flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs opacity-85">{[card.label ?? item.title, hm(item.at)].join(' · ')}</div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
          <span className="flex items-baseline text-[52px] leading-none font-semibold tracking-tight tabular-nums">
            {money && <span>¥</span>}
            <SlidingNumber number={shown} decimalPlaces={decimals} thousandSeparator="," transition={{ stiffness: 160, damping: 26, mass: 0.6 }} />
            {!money && card.unit && <span className="ml-1.5 text-base font-normal opacity-85">{card.unit}</span>}
          </span>
          {card.was !== undefined && <span className="text-lg line-through opacity-60 tabular-nums">{money ? '¥' : ''}{card.was.toLocaleString('zh-CN')}</span>}
        </div>
        {(card.note || item.text) && <p className="mt-3 flex items-center gap-1.5 text-sm opacity-95">{card.was !== undefined && <Trend size={15} className="shrink-0" />}{card.note || item.text}</p>}
      </div>
      {card.series && card.series.length > 1 && <Spark values={card.series} className="mt-8 hidden w-44 shrink-0 sm:block" />}
      <button onClick={() => dismiss.mutate()} aria-label="收起" className="press -mt-1 -mr-2 flex size-7 shrink-0 items-center justify-center rounded-full opacity-80 hover:bg-white/15 hover:opacity-100"><X size={16} /></button>
    </div>
    {item.action && <div className="relative mt-4 flex items-center gap-2">
      <ActionButton item={item} variant="white" />
      <button onClick={() => dismiss.mutate()} className="press rounded-full px-3 py-1.5 text-[13px] opacity-90 hover:bg-white/15">先不要</button>
    </div>}
  </div>
}

/** Recent values as a thin white line ending in a dot. */
function Spark({ values, className }: { values: number[]; className?: string }) {
  const w = 176, h = 64, pad = 6
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1
  const pts = values.map((v, i) => [pad + (i * (w - pad * 2)) / (values.length - 1), pad + (1 - (v - min) / span) * (h - pad * 2)] as const)
  const last = pts.at(-1)!
  return <svg viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden>
    <polyline points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke="white" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="spark-line" pathLength={1} />
    <circle cx={last[0]} cy={last[1]} r="4.5" fill="white" />
  </svg>
}

function Row({ item, onDown }: { item: FeedItem; onDown(item: FeedItem): void }) {
  const qc = useQueryClient()
  const Icon = item.card ? LineChart : ICONS[item.icon] ?? Bell
  const open = item.ticketId ? () => openTask(item.ticketId!) : undefined
  const set = (patch: Partial<FeedItem>) => qc.setQueryData<{ items: FeedItem[]; unseen: number }>(['feed'], old => old && { ...old, items: old.items.map(i => i.id === item.id ? { ...i, ...patch } : i).filter(i => !(i.id === item.id && patch.reaction === 'down')) })
  const done = () => qc.invalidateQueries({ queryKey: ['feed'] })
  const react = useMutation({ mutationFn: (reaction: 'up' | 'down' | null) => api.post(`/feed/${item.id}/react`, { reaction }), onMutate: reaction => { set({ reaction }); if (reaction === 'down') onDown(item) }, onSettled: done })
  const save = useMutation({ mutationFn: (saved: boolean) => api.post(`/feed/${item.id}/save`, { saved }), onMutate: saved => set({ saved }), onSettled: done })
  const tool = 'press flex size-7 items-center justify-center rounded-full hover:bg-sunken'
  return <div className="group flex items-center gap-3.5 rounded-2xl bg-sunken px-4 py-3.5">
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-panel"><Icon size={17} /></span>
    <button onClick={open} disabled={!open} className="min-w-0 flex-1 text-left">
      <span className="block truncate text-[15px] font-medium">{item.title}</span>
      {item.text && <span className="mt-0.5 block truncate text-[13px] text-muted">{item.text}</span>}
    </button>
    {item.saved && <Bookmark size={14} fill="currentColor" className="shrink-0 text-accent group-hover:hidden group-focus-within:hidden" aria-label="收藏了" />}
    <div className="anim-fade hidden shrink-0 items-center gap-0.5 rounded-full border border-line bg-panel p-0.5 group-hover:flex group-focus-within:flex max-md:flex">
      <button onClick={() => react.mutate(item.reaction === 'up' ? null : 'up')} aria-pressed={item.reaction === 'up'} aria-label="有用" title="有用" className={cx(tool, item.reaction === 'up' ? 'text-accent' : 'text-muted hover:text-fg')}><ThumbsUp size={14} fill={item.reaction === 'up' ? 'currentColor' : 'none'} /></button>
      <button onClick={() => react.mutate('down')} aria-label="这类少告诉我" title="这类少告诉我" className={cx(tool, 'text-muted hover:text-fg')}><ThumbsDown size={14} /></button>
      <button onClick={() => save.mutate(!item.saved)} aria-pressed={item.saved} aria-label={item.saved ? '取消收藏' : '收藏'} title={item.saved ? '取消收藏' : '收藏'} className={cx(tool, item.saved ? 'text-accent' : 'text-muted hover:text-fg')}><Bookmark size={14} fill={item.saved ? 'currentColor' : 'none'} /></button>
    </div>
    {item.action ? <ActionButton item={item} /> : <span className="flex shrink-0 items-center gap-2 text-xs text-faint tabular-nums group-hover:hidden group-focus-within:hidden max-md:hidden">
      {!item.seen && <span className="size-1.5 rounded-full bg-accent" aria-label="新的" />}{hm(item.at)}
    </span>}
  </div>
}

/** Says the action to 糯糯 in the main chat, as you, and puts the change away. */
function ActionButton({ item, variant }: { item: FeedItem; variant?: 'white' }) {
  const qc = useQueryClient()
  const act = useMutation({
    mutationFn: async () => {
      const { id } = await api.get<{ id: string }>('/conversations/main')
      await api.post(`/conversations/${id}/messages`, { content: item.action!.say })
      await api.post(`/feed/${item.id}/dismiss`)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['feed'] }); go('/') },
  })
  return <button onClick={() => act.mutate()} disabled={act.isPending}
    className={cx('press shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium disabled:opacity-60', variant === 'white' ? 'bg-white text-[#1a1a1a]' : 'bg-panel text-fg shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--faint)]')}>
    {item.action!.label}
  </button>
}

/** Something it noticed on its own and did not act on yet: you can tell it to go, or to leave this kind alone. */
function Noticed({ e }: { e: ActivityEvent }) {
  const qc = useQueryClient()
  const refresh = () => { qc.invalidateQueries({ queryKey: ['activity'] }); qc.invalidateQueries({ queryKey: ['tickets'] }) }
  const act = useMutation({ mutationFn: () => api.post(`/triggers/${e.id}/act`), onSuccess: refresh })
  const ignore = useMutation({ mutationFn: () => api.post(`/triggers/${e.id}/feedback`, { useful: false }), onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['proactive'] }) } })
  return <div className="group flex items-center gap-3.5 rounded-2xl bg-sunken px-4 py-3.5">
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-panel"><SourceIcon source={e.source} size={16} /></span>
    <div className="min-w-0 flex-1">
      <div className="truncate text-[15px] font-medium">{e.proactive?.title ?? e.text.slice(0, 60)}</div>
      <div className="mt-0.5 truncate text-[13px] text-muted">{e.proactive?.reason || `${SOURCE_LABEL[e.source] ?? e.source} · ${e.actor}`}</div>
    </div>
    <button onClick={() => ignore.mutate()} disabled={ignore.isPending} title="以后不管这类" aria-label="以后不管这类"
      className="press flex size-7 shrink-0 items-center justify-center rounded-full text-faint opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-fg focus-visible:opacity-100 max-md:opacity-100"><X size={14} /></button>
    <button onClick={() => act.mutate()} disabled={act.isPending} className="press shrink-0 rounded-full bg-panel px-3.5 py-1.5 text-[13px] font-medium shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--faint)]">帮我处理</button>
  </div>
}
