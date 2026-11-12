/**
 * Pieces of a conversation added with the Muse features (Figma section 25, boards A–C and K2): files the owner attaches,
 * the cards under 糯糯's messages (a day's schedule, a reminder, a place, a macOS permission), the 带你去 chip, the
 * 「前面已整理」 divider and find-in-chat (⌘F).
 */
import { ArrowUpRight, Bell, CalendarDays, ChevronDown, ChevronUp, FileSpreadsheet, FileText, Layers, MapPin, Search, Settings2, Shield, X, File as FileIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LocalApp, Message, Upload } from './api'
import { setPaneTab, type PaneTab } from './RightPane'
import { go } from './route'
import { openPane } from './Sidebar'
import { cx } from './ui'
import { locale, tx } from './i18n'

export const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const isImage = (mime: string) => /^image\/(png|jpeg|gif|webp)$/.test(mime)
const KIND: [RegExp, string][] = [[/pdf/, 'PDF'], [/sheet|excel|csv/, tx('表格')], [/word|document/, tx('文档')], [/presentation|powerpoint/, tx('幻灯片')], [/^text\//, tx('文本')], [/zip|compressed/, tx('压缩包')], [/^audio\//, tx('音频')], [/^video\//, tx('视频')]]
const kindOf = (mime: string, name: string) => KIND.find(([re]) => re.test(mime) || re.test(name.toLowerCase()))?.[1] ?? (name.split('.').pop()?.toUpperCase() ?? tx('文件'))
const iconOf = (mime: string, name: string) => /sheet|excel|csv/.test(mime) || /\.(xlsx?|csv)$/i.test(name) ? FileSpreadsheet : /pdf|text|word|document/.test(mime) ? FileText : FileIcon

/** A file waiting in the input bar: a thumbnail for pictures, a card for the rest, × to take it out. */
export type Pending = { key: string; name: string; mime: string; size: number; preview?: string; upload?: Upload; error?: string }

export function PendingFiles({ files, onRemove }: { files: Pending[]; onRemove(key: string): void }) {
  if (!files.length) return null
  return <div className="flex flex-wrap gap-2 px-2 pt-1.5 pb-1">
    {files.map(f => <div key={f.key} className="anim-pop relative">
      {f.preview ? <img src={f.preview} alt={f.name} className={cx('size-14 rounded-xl object-cover', !f.upload && !f.error && 'opacity-60')} />
        : <FileChip name={f.name} mime={f.mime} size={f.size} dim={!f.upload && !f.error} />}
      {f.error && <span className="absolute inset-x-0 -bottom-4 truncate text-[10px] text-danger" title={f.error}>{f.error}</span>}
      <button onClick={() => onRemove(f.key)} aria-label={tx('去掉 {0}', f.name)} className="press absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-ink-fg"><X size={11} strokeWidth={3} /></button>
    </div>)}
  </div>
}

function FileChip({ name, mime, size, dim, href }: { name: string; mime: string; size: number; dim?: boolean; href?: string }) {
  const Icon = iconOf(mime, name)
  const body = <>
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><Icon size={17} /></span>
    <span className="min-w-0">
      <span className="block truncate text-[13px] font-medium">{name}</span>
      <span className="block text-[11px] text-faint tabular-nums">{kindOf(mime, name)} · {fmtSize(size)}</span>
    </span>
  </>
  const cls = cx('flex h-14 w-[190px] items-center gap-2.5 rounded-xl border border-line bg-card px-2.5 text-left', dim && 'opacity-60')
  return href ? <a href={href} target="_blank" rel="noreferrer" className={cx(cls, 'press hover:border-faint')}>{body}</a> : <div className={cls}>{body}</div>
}

/** Files on a sent message, above its bubble: pictures as thumbnails, other files as cards that open or download. */
export function SentFiles({ files }: { files: Upload[] }) {
  return <div className="mb-1.5 flex flex-col items-end gap-1.5">
    {files.map(f => isImage(f.mime)
      ? <a key={f.id} href={`/api/uploads/${f.id}`} target="_blank" rel="noreferrer" className="press block overflow-hidden rounded-2xl"><img src={`/api/uploads/${f.id}`} alt={f.name} loading="lazy" className="max-h-56 max-w-[260px] object-cover" /></a>
      : <FileChip key={f.id} name={f.name} mime={f.mime} size={f.size} href={`/api/uploads/${f.id}`} />)}
  </div>
}

/** The message being answered, inside the owner's bubble. */
export function QuoteInBubble({ quote, name }: { quote: { messageId: string; text: string }; name: string }) {
  return <div className="mb-1.5 border-l-2 border-accent-fg/70 pl-2 text-[12px] leading-5 opacity-85">
    <div className="font-medium">{name}</div>
    <div className="line-clamp-2">{quote.text}</div>
  </div>
}

/** Over the input bar while answering one message: 回复 糯糯：… with × to drop it. */
export function QuoteBar({ m, name, onClear }: { m: Message; name: string; onClear(): void }) {
  return <div className="mx-1 mt-0.5 mb-1 flex items-center gap-2 rounded-xl bg-sunken py-1.5 pr-1.5 pl-2.5 text-[12px] text-muted">
    <span className="h-4 w-0.5 shrink-0 rounded-full bg-accent" />
    <span className="min-w-0 flex-1 truncate">{tx('回复')} {m.role === 'user' ? tx('自己') : name}：{m.content}</span>
    <button onClick={onClear} aria-label={tx('不回复这条了')} className="press flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-hero-2 hover:text-fg"><X size={13} /></button>
  </div>
}

// ── 带你去 and cards ──────────────────────────────────────────────────────────

const PANE: Record<string, PaneTab> = { 'pane/activity': 'activity', 'pane/who': 'who', 'pane/permissions': 'permissions' }
const OPEN_ICON = (route: string) => route === 'pane/permissions' ? Shield : route.startsWith('settings') ? Settings2 : ArrowUpRight

/** A place in the app 糯糯 points to: the right pane's tabs open in place, the rest are pages. */
export function openRoute(route: string) {
  const tab = PANE[route]
  if (tab) { setPaneTab(tab); openPane(true); return }
  go(`/${route}`)
}

export function OpenChip({ open }: { open: { route: string; label: string } }) {
  const Icon = OPEN_ICON(open.route)
  return <button onClick={() => openRoute(open.route)} className="press mt-1.5 flex items-center gap-1.5 rounded-full border border-line bg-panel py-1.5 pr-2.5 pl-3 text-[13px] hover:border-faint">
    <Icon size={14} />{open.label}<span className="text-faint">›</span>
  </button>
}

type Card =
  | { type: 'schedule'; date: string; events: { start: string; end?: string; title: string; location?: string }[] }
  | { type: 'reminder'; title: string; at: string; note?: string }
  | { type: 'place'; name: string; address?: string; note?: string; url?: string }
  | { type: 'mac_permission'; app: LocalApp }

const WEEK = [tx('周日'), tx('周一'), tx('周二'), tx('周三'), tx('周四'), tx('周五'), tx('周六')]
function dayLabel(date: string) {
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  const days = Math.round((d.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000)
  const rel = days === 0 ? tx('今天') : days === 1 ? tx('明天') : days === 2 ? tx('后天') : days === -1 ? tx('昨天') : ''
  return tx('{0}{1} 月 {2} 日 {3}', rel ? `${rel} · ` : '', d.getMonth() + 1, d.getDate(), WEEK[d.getDay()])
}
const hm = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) }

const APP_LABEL: Record<string, string> = { calendar: tx('日历'), reminders: tx('提醒事项'), notes: tx('备忘录'), contacts: tx('通讯录'), photos: tx('照片') }
const PRIVACY: Record<string, string> = { calendar: 'Privacy_Calendars', reminders: 'Privacy_Reminders', notes: 'Privacy_Automation', contacts: 'Privacy_Contacts', photos: 'Privacy_Photos' }

export function ChatCard({ card }: { card: Card }) {
  const [gone, setGone] = useState(false)
  const shell = 'mt-1.5 w-full max-w-[440px] overflow-hidden rounded-2xl border border-line bg-card'
  const head = (icon: React.ReactNode, title: React.ReactNode, aside?: React.ReactNode) => <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13px] font-semibold">
    {icon}<span className="min-w-0 flex-1 truncate">{title}</span>{aside && <span className="shrink-0 text-xs font-normal text-faint">{aside}</span>}
  </div>
  if (card.type === 'schedule') return <div className={shell}>
    {head(<CalendarDays size={15} />, dayLabel(card.date), card.events.length ? tx('{0} 件', card.events.length) : undefined)}
    {card.events.length ? <div className="divide-y divide-line">{card.events.map((e, i) => <div key={i} className="flex gap-3 px-4 py-2.5">
      <span className={cx('w-0.5 shrink-0 rounded-full', i === 0 ? 'bg-accent' : 'bg-faint/50')} />
      <span className="w-[86px] shrink-0 pt-px text-xs text-muted tabular-nums">{e.start}{e.end ? ` – ${e.end}` : ''}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{e.title}</span>
        {e.location && <span className="block truncate text-xs text-faint">{e.location}</span>}
      </span>
    </div>)}</div> : <p className="px-4 py-3 text-sm text-faint">{tx('这天没有安排。')}</p>}
  </div>
  if (card.type === 'reminder') return <div className={cx(shell, 'flex items-center gap-3 px-4 py-3')}>
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><Bell size={16} /></span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{card.title}</span>
      <span className="block truncate text-xs text-muted tabular-nums">{hm(card.at)}{card.note ? ` · ${card.note}` : ''}</span>
    </span>
  </div>
  if (card.type === 'place') {
    const href = card.url ?? `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${card.name} ${card.address ?? ''}`.trim())}`
    return <div className={cx(shell, 'max-w-[300px]')}>
      <div className="relative h-16 bg-sunken" aria-hidden>
        <span className="absolute inset-x-0 top-6 h-1.5 bg-hero-2" /><span className="absolute inset-y-0 left-[40%] w-1.5 bg-hero-2" /><span className="absolute inset-y-0 left-[70%] w-1.5 bg-hero-2" />
        <span className="absolute top-3 left-[50%] flex size-7 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-accent-fg shadow"><MapPin size={14} /></span>
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{card.name}</span>
          {(card.address || card.note) && <span className="block truncate text-xs text-muted">{[card.address, card.note].filter(Boolean).join(' · ')}</span>}
        </span>
        <a href={href} target="_blank" rel="noreferrer" aria-label={tx('在地图上打开')} className="press flex size-9 shrink-0 items-center justify-center rounded-full border border-line hover:border-faint"><ArrowUpRight size={15} /></a>
      </div>
    </div>
  }
  if (gone) return null
  const app = APP_LABEL[card.app] ?? card.app
  return <div className={shell}>
    {head(<CalendarDays size={15} />, tx('要看你的{0}，macOS 得先同意', app))}
    <p className="px-4 pt-3 text-sm leading-6 text-pretty">{tx('点下面的按钮会打开「系统设置 › 隐私与安全性 › {0}」，把 nuonuo 打开就行，回到这里不用重启。', app)}</p>
    <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-4">
      <a href={`x-apple.systempreferences:com.apple.preference.security?${PRIVACY[card.app]}`} className="press h-9 rounded-full bg-ink px-4 text-[13px] leading-9 font-medium text-ink-fg">{tx('去系统设置打开')}</a>
      <button onClick={() => setGone(true)} className="press h-9 rounded-full border border-line px-4 text-[13px] hover:border-faint">{tx('先不用')}</button>
      <span className="ml-auto text-[11px] text-faint">{tx('在 权限 里可以改它能做到哪一步')}</span>
    </div>
  </div>
}

/** 「前面 128 条整理好了 · 看摘要」: where the assistant compacted what came before. */
export function Compacted({ m }: { m: Message }) {
  const [open, setOpen] = useState(false)
  const summary = String(m.meta.summary ?? '')
  return <div className="py-2">
    <div className="flex items-center gap-3 text-xs text-faint">
      <span className="h-px flex-1 bg-line" />
      <button onClick={() => summary && setOpen(v => !v)} className="press flex items-center gap-1.5 rounded-full border border-line px-3 py-1 hover:text-fg">
        <Layers size={12} />{tx('前面')} {m.meta.count ?? ''} {tx('条整理好了')}{summary && <> · {open ? tx('收起') : tx('看摘要')}</>}
      </button>
      <span className="h-px flex-1 bg-line" />
    </div>
    {open && <div className="anim-rise mx-auto mt-2 max-w-[520px] rounded-2xl bg-sunken px-4 py-3 text-[13px] leading-6 whitespace-pre-wrap text-muted">{summary}</div>}
  </div>
}

// ── ⌘F ────────────────────────────────────────────────────────────────────────

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void }
const highlights = () => (CSS as unknown as { highlights?: HighlightRegistry }).highlights
const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight

/** Find in this conversation: matches light up (CSS highlights, the text is untouched); ↑↓ or Enter step through them. */
export function FindBar({ root, deps, onClose }: { root: React.RefObject<HTMLElement | null>; deps: unknown; onClose(): void }) {
  const [q, setQ] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useLayoutEffect(() => {
    const el = root.current
    const needle = q.trim().toLowerCase()
    if (!el || !needle) { setRanges([]); return }
    const found: Range[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').toLowerCase()
      for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length); found.push(r)
      }
    }
    setRanges(found)
    setAt(found.length ? found.length - 1 : 0)
  }, [q, deps])
  useEffect(() => {
    const reg = highlights()
    if (!reg || !Highlight) return
    reg.set('find', new Highlight(...ranges))
    const current = ranges[at]
    if (current) {
      reg.set('find-current', new Highlight(current))
      const rect = current.getBoundingClientRect(), box = root.current?.getBoundingClientRect()
      if (box && (rect.top < box.top + 40 || rect.bottom > box.bottom - 40)) root.current!.scrollBy({ top: rect.top - box.top - box.height / 2 })
    } else reg.delete('find-current')
    return () => { reg.delete('find'); reg.delete('find-current') }
  }, [ranges, at])
  const step = (d: number) => { if (ranges.length) setAt(i => (i + d + ranges.length) % ranges.length) }
  return <div role="search" className="absolute top-2 right-3 z-20 flex h-10 w-[min(320px,calc(100%-24px))] items-center gap-1 rounded-full border border-line bg-panel pr-1.5 pl-3 shadow-lg">
    <Search size={15} className="shrink-0 text-faint" />
    <input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder={tx('在这段聊天里找')} aria-label={tx('在这段聊天里找')}
      onKeyDown={e => { if (e.key === 'Escape') onClose(); else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? 1 : -1) } }}
      className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
    {q && <span className="shrink-0 px-1 text-xs text-faint tabular-nums">{ranges.length ? `${at + 1} / ${ranges.length}` : tx('没有')}</span>}
    <button onClick={() => step(-1)} aria-label={tx('上一个')} className="press flex size-7 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"><ChevronUp size={15} /></button>
    <button onClick={() => step(1)} aria-label={tx('下一个')} className="press flex size-7 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"><ChevronDown size={15} /></button>
    <span className="mx-0.5 h-4 w-px bg-line" />
    <button onClick={onClose} aria-label={tx('关闭查找')} className="press flex size-7 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"><X size={15} /></button>
  </div>
}
