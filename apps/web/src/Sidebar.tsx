/**
 * Spatial Architecture C (Figma v15 · 天光雾玻璃 · 方案 C):
 * - Desktop (`md+`): left floating frosted-glass pill rail (Nuonuo avatar / 对话·动态·点子·目标·成果 / 搜索·设置)
 *   plus a slide-over floating frosted thread & external-channel drawer (`leftOpen`, toggled via 主聊 ⌄ or ⌘\).
 * - Phones (`< md`): full slide-in navigation drawer with Nuonuo status, threads, pages, and settings.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  ChevronRight,
  Lightbulb,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  Newspaper,
  Package,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Target,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { api, type Conversation, type Ticket, type UpdateStatus } from './api'
import { useFeed } from './Activity'
import { useIdeas } from './ideas'
import { SourceIcon } from './icons'
import { tx } from './i18n'
import { openActivity, useLive } from './live'
import { More } from './More'
import { Avatar, statusLine, usePersona } from './persona'
import { getPrefs, keyLabel, MOD } from './prefs'
import { go, type Route } from './route'
import { openSearch } from './search'
import { togglePane, usePanes, usePresence } from './shell'
import { needsOwner, useTickets } from './tasks'
import { cx, IconButton } from './ui'

export function Sidebar({ route, open, onClose }: { route: Route; open: boolean; onClose(): void }) {
  useEffect(() => { if (open) onClose() }, [JSON.stringify(route)])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) onClose()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [open, onClose])
  const drawer = usePresence(open, 200)
  return <>
    <FloatingRail route={route} />
    <FloatingThreadDrawer route={route} />
    {drawer.shown && <div className={cx('anim-fade fixed inset-0 z-40 bg-[var(--scrim)] md:hidden', drawer.leaving && 'out-fade')} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <aside className={cx('anim-drawer-l glass-strong flex h-full w-[min(19rem,86vw)] flex-col pb-[env(safe-area-inset-bottom)] shadow-2xl', drawer.leaving && 'out-l')}>
        <div className="flex justify-end px-3 pt-3"><IconButton label={tx('关闭菜单')} onClick={onClose}><X size={18} /></IconButton></div>
        <MobileSidebarBody route={route} />
      </aside>
    </div>}
  </>
}

const TOPIC_COLORS = ['#e11d48', '#0f766e', '#7c3aed', '#2563eb', '#d97706', '#be123c', '#0d9488']
export const topicColor = (id: string) => TOPIC_COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TOPIC_COLORS.length]!

/** Opens what 糯糯 is up to: the right pane on wide windows, a drawer or sheet on narrow ones. */
export function openPane(open?: boolean) {
  if (matchMedia('(min-width: 1280px)').matches) togglePane('right', open)
  else openActivity(open ?? true)
}

const day = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}.${d.getDate()}` }

// ── Desktop Left Floating Frosted Pill Rail (v15) ───────────────────────────

function FloatingRail({ route }: { route: Route }) {
  const persona = usePersona()
  const connected = useLive(s => s.connected)
  const { rightOpen, leftOpen } = usePanes()
  const tickets = (useTickets().data?.tickets ?? []).filter(t => t.stage !== 'ended')
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') }).data?.conversations ?? []
  const feedUnseen = useFeed().data?.unseen ?? 0
  const batch = useIdeas().data?.batch
  const freshIdeas = !!batch && !batch.seen && batch.cards.some(c => !c.dismissed && !c.done)
  const update = useQuery({ queryKey: ['update'], queryFn: () => api.get<UpdateStatus>('/update'), refetchInterval: 30 * 60_000, retry: false }).data

  const status = statusLine(tickets)
  const mood = !connected ? 'sleepy' : status.tone === 'working' ? 'working' : status.tone
  const dotTone = !connected ? 'offline' : status.tone
  const chatAlert = tickets.some(needsOwner) || conversations.some(c => (c.unread ?? 0) > 0)

  const searchShortcut = keyLabel(getPrefs().keys.search).join(MOD === 'Ctrl' ? '+' : '')
  const settingsShortcut = keyLabel(getPrefs().keys.settings).join(MOD === 'Ctrl' ? '+' : '')

  const pages: { id: Route['page']; label: string; icon: LucideIcon; dot?: boolean; onClick(): void }[] = [
    {
      id: 'chat',
      label: route.page === 'chat' ? tx('切换对话 ({0}\\)', MOD) : tx('对话'),
      icon: MessageCircle,
      dot: route.page !== 'chat' && chatAlert,
      onClick: () => {
        if (route.page === 'chat') togglePane('left')
        else { togglePane('left', false); go('/') }
      },
    },
    {
      id: 'activity',
      label: tx('动态'),
      icon: Newspaper,
      dot: route.page !== 'activity' && feedUnseen > 0,
      onClick: () => { togglePane('left', false); go('/activity') },
    },
    {
      id: 'ideas',
      label: tx('点子'),
      icon: Lightbulb,
      dot: route.page !== 'ideas' && freshIdeas,
      onClick: () => { togglePane('left', false); go('/ideas') },
    },
    {
      id: 'goals',
      label: tx('目标'),
      icon: Target,
      onClick: () => { togglePane('left', false); go('/goals') },
    },
    {
      id: 'library',
      label: tx('成果'),
      icon: Package,
      onClick: () => { togglePane('left', false); go('/library') },
    },
  ]

  return <nav aria-label={tx('主导航')} className="pointer-events-none fixed inset-y-0 left-5 z-30 flex items-center max-md:hidden">
    <div className="no-drag pointer-events-auto glass-surface flex w-[62px] flex-col items-center gap-1.5 rounded-full py-2.5 shadow-[var(--shadow-pill)]">
      <button
        type="button"
        onClick={() => openPane()}
        aria-expanded={rightOpen}
        aria-label={tx('看看它在做什么')}
        title={`${persona.name} · ${connected ? status.text : tx('重连中…')}`}
        className={cx(
          'squish press relative flex size-[44px] items-center justify-center rounded-full border transition-colors duration-150',
          rightOpen
            ? 'border-[#f2b8c6] bg-[#fff6f8] dark:border-accent/45 dark:bg-accent-soft'
            : 'border-line bg-sunken/85 hover:border-faint',
        )}
      >
        <Avatar persona={persona} size={28} mood={mood} />
        <span className="absolute right-0 bottom-0 flex size-[11px] items-center justify-center rounded-full bg-card">
          <StatusDot tone={dotTone} />
        </span>
      </button>

      <div className="my-0.5 h-px w-6 bg-line" aria-hidden />

      {pages.map(p => {
        const active = route.page === p.id
        const Icon = p.icon
        return <button
          key={p.id}
          type="button"
          onClick={p.onClick}
          aria-label={p.label}
          aria-current={active ? 'page' : undefined}
          aria-expanded={p.id === 'chat' && active ? leftOpen : undefined}
          title={p.label}
          className={cx(
            'press relative flex size-10 items-center justify-center rounded-full transition-colors duration-150',
            active
              ? 'bg-ink text-ink-fg shadow-xs'
              : 'text-muted hover:bg-sunken/85 hover:text-fg',
          )}
        >
          <Icon size={18} strokeWidth={active ? 2 : 1.8} />
          {p.dot && <span className="absolute top-2 right-2 size-[6px] rounded-full bg-accent ring-[1.5px] ring-card" />}
        </button>
      })}

      <div className="my-0.5 h-px w-6 bg-line" aria-hidden />

      <button
        type="button"
        onClick={() => openSearch(true)}
        aria-label={tx('搜索 ({0})', searchShortcut)}
        title={tx('搜索 ({0})', searchShortcut)}
        className="press flex size-10 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-sunken/85 hover:text-fg"
      >
        <Search size={17} strokeWidth={1.8} />
      </button>

      <button
        type="button"
        onClick={() => { togglePane('left', false); go(update?.available ? '/settings/system' : '/settings/persona') }}
        aria-label={tx('设置')}
        title={settingsShortcut ? `${tx('设置')} (${settingsShortcut})` : tx('设置')}
        className="press relative flex size-10 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-sunken/85 hover:text-fg"
      >
        <Settings size={17} strokeWidth={1.8} />
        {update?.available && <span className="absolute top-2 right-2 size-[6px] rounded-full bg-accent ring-[1.5px] ring-card" />}
      </button>
    </div>
  </nav>
}

// ── Desktop Thread & External Channel Panel (in-flow on xl+, overlay drawer on md..xl) ──

export function ThreadPanel({ route, onClose, closeOnNavigate = false }: { route: Route; onClose(): void; closeOnNavigate?: boolean }) {
  return <aside
    aria-label={tx('对话列表')}
    className="glass-strong flex h-full w-full flex-col overflow-hidden rounded-[26px] shadow-[var(--shadow-ceramic)]"
  >
    <div className="flex h-13 shrink-0 items-center gap-2 border-b border-line/70 px-4">
      <span className="min-w-0 flex-1 text-[14px] font-semibold text-fg">{tx('对话列表')}</span>
      <button
        type="button"
        onClick={() => { if (closeOnNavigate) onClose(); go('/new') }}
        aria-label={tx('新侧聊')}
        title={tx('新侧聊')}
        className="press flex size-7 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"
      >
        <SquarePen size={15} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={tx('收起对话列表')}
        title={tx('收起对话列表')}
        className="press flex size-7 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"
      >
        <ChevronLeft size={16} />
      </button>
    </div>
    <ThreadList route={route} {...(closeOnNavigate ? { onNavigate: onClose } : {})} />
  </aside>
}

function FloatingThreadDrawer({ route }: { route: Route }) {
  const { leftOpen } = usePanes()
  const { shown, leaving } = usePresence(leftOpen, 180)
  const close = () => togglePane('left', false)

  useEffect(() => {
    if (!leftOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) close()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [leftOpen])

  if (!shown) return null

  return <div className="fixed inset-0 z-25 max-md:hidden xl:hidden">
    <div
      className={cx('anim-fade absolute inset-0 bg-[var(--scrim)]', leaving && 'out-fade pointer-events-none')}
      onMouseDown={close}
      aria-hidden
    />
    <div
      className={cx(
        'anim-pop absolute top-3 bottom-3 left-[96px] w-[280px]',
        leaving && 'out-pop pointer-events-none',
      )}
    >
      <ThreadPanel route={route} onClose={close} closeOnNavigate />
    </div>
  </div>
}

// ── Shared Thread List (Desktop Floating Drawer + Mobile Drawer) ────────────

function ThreadList({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') })
  const conversations = data?.conversations ?? []
  const main = conversations.find(c => c.meta.main)
  const side = conversations.filter(c => !c.meta.main && c.source === 'webchat')
  const outside = conversations.filter(c => c.source !== 'webchat')
  const activeId = route.page === 'chat' ? (route.id ?? (route.main ? main?.id : undefined)) : undefined
  const tickets = useTickets().data?.tickets ?? []
  const changed = () => qc.invalidateQueries({ queryKey: ['conversations'] })
  const ticketsOf = (cnv: string) => tickets.filter(t => t.conversationId === cnv)
  const mainWaits = main ? ticketsOf(main.id).some(needsOwner) || (activeId !== main.id && (main.unread ?? 0) > 0) : false

  return <nav className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-3">
    {main && <a href="#/" onClick={onNavigate} aria-current={activeId === main.id ? 'page' : undefined}
      className={cx(
        'press flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition-colors duration-150',
        activeId === main.id
          ? 'border-[var(--ceramic-border)] bg-card shadow-xs'
          : 'border-transparent hover:bg-sunken/70',
      )}>
      <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-xl', activeId === main.id ? 'bg-ink text-ink-fg' : 'bg-sunken text-muted')}><MessageCircle size={17} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-fg">{tx('主聊')}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">{main.lastMessage?.replace(/\s+/g, ' ') || tx('一直在这儿的那段对话')}</span>
      </span>
      {mainWaits && <span className="mt-1.5 size-2 shrink-0 self-start rounded-full bg-accent" aria-label={tx('有新消息')} />}
    </a>}

    <div className="flex items-baseline gap-2 px-2.5 pt-5 pb-1.5 text-xs"><span className="font-medium text-muted">{tx('侧聊')}</span><span className="text-faint">{tx('独立的小任务')}</span></div>
    {side.length === 0 && <button onClick={() => { onNavigate?.(); go('/new') }} className="w-full rounded-xl px-2.5 py-2 text-left text-xs text-faint hover:text-muted">{tx('独立的小任务会出现在这里，比如一次旅行、一份报告。')}</button>}
    {side.map(c => <Item key={c.id} c={c} active={c.id === activeId} tickets={ticketsOf(c.id)} onChanged={changed} {...(onNavigate ? { onNavigate } : {})} />)}
    <Archived activeId={activeId} onChanged={changed} {...(onNavigate ? { onNavigate } : {})} />
    {outside.length > 0 && <div className="px-2.5 pt-5 pb-1.5 text-xs font-medium text-muted">{tx('来自外部')}</div>}
    {outside.map(c => <Item key={c.id} c={c} active={c.id === activeId} tickets={ticketsOf(c.id)} onChanged={changed} {...(onNavigate ? { onNavigate } : {})} />)}
  </nav>
}

// ── Mobile Drawer Body ──────────────────────────────────────────────────────

function MobileSidebarBody({ route }: { route: Route }) {
  const tickets = useTickets().data?.tickets ?? []
  const connected = useLive(s => s.connected)
  const persona = usePersona()
  const paneOpen = usePanes().rightOpen
  const status = statusLine(tickets.filter(t => t.stage !== 'ended'))
  const mood = !connected ? 'sleepy' : status.tone === 'working' ? 'working' : status.tone

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="px-3 pt-1">
      <button onClick={() => openPane()} aria-expanded={paneOpen} title={tx('看看它在做什么')}
        className="squish press flex w-full min-w-0 items-center gap-3 rounded-2xl border border-[var(--ceramic-border)] bg-card/85 p-2.5 text-left transition-colors duration-150 hover:bg-card">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-sunken/80">
          <Avatar persona={persona} size={26} mood={mood} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-tight font-semibold">{persona.name}</span>
          <StatusText text={connected ? status.text : tx('重连中…')} />
        </span>
      </button>
    </div>

    <ThreadList route={route} />

    <div className="flex items-center justify-between border-t border-line/70 px-3 pt-2.5 pb-3">
      <More route={route} />
      <button onClick={() => go('/new')} className="press flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-[13px] text-fg shadow-2xs hover:border-faint"><SquarePen size={14} />{tx('新侧聊')}</button>
    </div>
  </div>
}

/** 已归档 N ›: side chats put away; they open in place and can go back with 放回侧聊. */
function Archived({ activeId, onChanged, onNavigate }: { activeId: string | undefined; onChanged(): void; onNavigate?: () => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const list = useQuery({ queryKey: ['conversations', 'archived'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations?archived=1') }).data?.conversations ?? []
  const changed = () => { onChanged(); qc.invalidateQueries({ queryKey: ['conversations', 'archived'] }) }
  if (!list.length) return null
  return <>
    <button onClick={() => setOpen(v => !v)} aria-expanded={open} className="flex items-center gap-1 px-2.5 pt-3 pb-1 text-xs text-faint hover:text-muted"> {tx('已归档 {0}', list.length)}<ChevronRight size={13} className={cx('transition-transform duration-150', open && 'rotate-90')} />
    </button>
    {open && list.map(c => <Item key={c.id} c={c} active={c.id === activeId} tickets={[]} onChanged={changed} {...(onNavigate ? { onNavigate } : {})} />)}
  </>
}

/** The status line under 糯糯's name: a new line rolls up over the old one. */
function StatusText({ text }: { text: string }) {
  return <span className="relative mt-0.5 block h-[18px] overflow-hidden text-xs leading-[18px] text-muted">
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span key={text} className="block truncate" initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }}
        transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}>{text}</motion.span>
    </AnimatePresence>
  </span>
}

export function StatusDot({ tone }: { tone: 'idle' | 'working' | 'waiting' | 'offline' }) {
  const color = tone === 'waiting' ? 'bg-warn' : tone === 'working' ? 'bg-accent' : tone === 'offline' ? 'bg-faint' : 'bg-ok'
  return <span className="relative flex size-2 shrink-0">
    {(tone === 'working' || tone === 'waiting') && <span className={cx('ping-soft absolute inset-0 rounded-full', color)} />}
    <span className={cx('relative size-2 rounded-full', color)} />
  </span>
}

/** A side chat: its title, one line on where it stands, and whether it is running, waiting for you or done. */
function Item({ c, active, tickets, onChanged, onNavigate }: { c: Conversation; active: boolean; tickets: Ticket[]; onChanged(): void; onNavigate?: () => void }) {
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const patch = useMutation({ mutationFn: (body: Partial<Conversation>) => api.patch(`/conversations/${c.id}`, body), onSuccess: onChanged })
  const remove = useMutation({ mutationFn: () => api.del(`/conversations/${c.id}`), onSuccess: () => { onChanged(); if (active) go('/') } })
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    addEventListener('mousedown', close); addEventListener('keydown', esc)
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc) }
  }, [menu])
  const live = tickets.filter(t => t.stage !== 'ended')
  const waiting = live.some(needsOwner)
  const working = live.some(t => t.stage === 'working' || t.stage === 'queued')
  const done = !live.length && tickets.length > 0 && tickets.every(t => t.ended?.outcome === 'completed')
  const unread = !active && (c.unread ?? 0) > 0
  const latest = [...tickets].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const sub = waiting ? tx('等你点头') : working ? (latest?.latestReport?.summary || latest?.title || tx('在做')) : done ? tx('{0} 做完', day(c.updatedAt)) : c.lastMessage?.replace(/\s+/g, ' ') || day(c.updatedAt)
  return <div ref={ref} className="group relative">
    <a href={`#/c/${c.id}`} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cx('press relative flex items-center gap-2.5 rounded-xl py-2 pr-9 pl-2.5 transition-colors',
      active ? 'bg-card shadow-2xs ring-1 ring-[var(--ceramic-border)]' : 'hover:bg-sunken/70')}>
      {c.source !== 'webchat' && <SourceIcon source={c.source} size={14} className="shrink-0 text-faint" />}
      <span className="min-w-0 flex-1">
        <span className={cx('flex items-center gap-1 text-sm', unread ? 'font-semibold text-fg' : 'text-fg')}><span className="truncate">{c.title}</span>{c.pinned && <Pin size={11} className="shrink-0 text-faint" />}</span>
        <span className={cx('mt-0.5 block truncate text-xs', waiting ? 'text-accent' : 'text-faint')}>{sub}</span>
      </span>
      <span className="absolute top-1/2 right-2.5 flex size-5 -translate-y-1/2 items-center justify-center transition-opacity duration-150 group-hover:opacity-0">
        {waiting || unread ? <span className="size-2 rounded-full bg-accent" />
          : working ? <LoaderCircle size={15} className="animate-spin text-faint [animation-duration:1.4s]" />
          : done ? <Check size={15} className="text-faint" /> : null}
      </span>
    </a>
    <button onClick={() => setMenu(v => !v)} aria-label={tx('更多')} aria-expanded={menu}
      className={cx('absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-faint hover:bg-panel hover:text-fg max-md:opacity-100',
        menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>
      <MoreHorizontal size={15} />
    </button>
    {menu && <div role="menu" className="anim-menu absolute top-11 right-1 z-20 w-40 rounded-2xl border border-line bg-card p-1 text-sm shadow-xl">
      <MenuItem icon={<Pencil size={14} />} onClick={() => { const t = prompt(tx('重命名'), c.title)?.trim(); if (t) patch.mutate({ title: t }); setMenu(false) }}>{tx('重命名')}</MenuItem>
      {!c.archived && <MenuItem icon={c.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => { patch.mutate({ pinned: !c.pinned }); setMenu(false) }}>{c.pinned ? tx('取消置顶') : tx('置顶')}</MenuItem>}
      <MenuItem icon={c.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} onClick={() => { patch.mutate({ archived: !c.archived }); setMenu(false); if (active && !c.archived) go('/') }}>{c.archived ? tx('放回侧聊') : tx('归档')}</MenuItem>
      <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { if (confirm(tx('删除「{0}」？此操作不可撤销。', c.title))) remove.mutate(); setMenu(false) }}>{tx('删除')}</MenuItem>
    </div>}
  </div>
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return <button role="menuitem" onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-xl px-3 py-2 hover:bg-sunken', danger && 'text-danger')}>{icon}{children}</button>
}
