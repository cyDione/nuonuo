/**
 * Sidebar (Figma v6, section 18): 糯糯 and its status line on top (click it to open the right pane), the pinned 主聊, then
 * 侧聊 (bounded side tasks) and threads mirrored from outside; the quick-settings button and 新侧聊 at the bottom.
 * On phones it slides in as a drawer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle, MessageCircle, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, SquarePen, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { api, type Conversation, type Ticket } from './api'
import { openActivity, useLive } from './live'
import { Avatar, statusLine, usePersona } from './persona'
import { go, type Route } from './route'
import { needsOwner, useTickets } from './tasks'
import { SourceIcon } from './icons'
import { cx, IconButton } from './ui'
import { isMacDesktop, Pane, Resizer, togglePane, usePanes, usePresence } from './shell'
import { QuickSettings } from './QuickSettings'

/** The window's title bar row above the sidebar: room for the traffic lights, and the button that folds the sidebar. */
function TitleRow() {
  return <div className="drag flex h-12 shrink-0 items-center justify-end px-3 pt-1">
    {isMacDesktop && <span className="lights-room mr-auto w-[68px]" aria-hidden />}
    <IconButton label="收起侧栏 (⌘\)" onClick={() => togglePane('left', false)} className="size-8 text-faint"><PanelLeft size={17} /></IconButton>
  </div>
}

export function Sidebar({ route, open, onClose }: { route: Route; open: boolean; onClose(): void }) {
  useEffect(() => { if (open) onClose() }, [JSON.stringify(route)])
  const drawer = usePresence(open, 200)
  return <>
    <div className="contents max-md:hidden">
      <Pane side="left"><aside className="flex h-full w-full flex-col"><TitleRow /><SidebarBody route={route} /></aside></Pane>
      <Resizer side="left" />
    </div>
    {drawer.shown && <div className={cx('anim-fade fixed inset-0 z-40 bg-[var(--scrim)] md:hidden', drawer.leaving && 'out-fade')} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <aside className={cx('anim-drawer-l flex h-full w-[min(18rem,86vw)] flex-col bg-bg pb-[env(safe-area-inset-bottom)] shadow-2xl', drawer.leaving && 'out-l')}>
        <div className="flex justify-end px-3 pt-3"><IconButton label="关闭菜单" onClick={onClose}><X size={18} /></IconButton></div>
        <SidebarBody route={route} />
      </aside>
    </div>}
  </>
}

const TOPIC_COLORS = ['#e2566e', '#13857a', '#8a7fc0', '#3d86e0', '#d98a3a', '#c23d6b', '#1f9e7a']
export const topicColor = (id: string) => TOPIC_COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TOPIC_COLORS.length]!

/** Opens what 糯糯 is up to: the right pane on wide windows, a drawer or sheet on narrow ones. */
export function openPane() {
  if (matchMedia('(min-width: 1280px)').matches) togglePane('right')
  else openActivity(true)
}

const day = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}.${d.getDate()}` }

function SidebarBody({ route }: { route: Route }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') })
  const conversations = data?.conversations ?? []
  const main = conversations.find(c => c.meta.main)
  const side = conversations.filter(c => !c.meta.main && c.source === 'webchat')
  const outside = conversations.filter(c => c.source !== 'webchat')
  const activeId = route.page === 'chat' ? (route.id ?? (route.main ? main?.id : undefined)) : undefined
  const tickets = useTickets().data?.tickets ?? []
  const connected = useLive(s => s.connected)
  const persona = usePersona()
  const paneOpen = usePanes().rightOpen
  const changed = () => qc.invalidateQueries({ queryKey: ['conversations'] })
  const ticketsOf = (cnv: string) => tickets.filter(t => t.conversationId === cnv)

  const status = statusLine(tickets.filter(t => t.stage !== 'ended'))
  const mood = !connected ? 'sleepy' : status.tone === 'working' ? 'thinking' : status.tone
  const mainWaits = main ? ticketsOf(main.id).some(needsOwner) || (activeId !== main.id && (main.unread ?? 0) > 0) : false
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="px-2.5 pt-1">
      <button onClick={openPane} aria-expanded={paneOpen} title="看看它在做什么"
        className={cx('squish press flex w-full min-w-0 items-center gap-3 rounded-2xl p-2.5 text-left transition-colors duration-150', paneOpen ? 'bg-sunken xl:bg-sunken' : 'hover:bg-sunken/70')}>
        <Avatar persona={persona} size={40} mood={mood} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-tight font-semibold">{persona.name}</span>
          <StatusText text={connected ? status.text : '重连中…'} />
        </span>
      </button>
    </div>

    <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-3 pb-2">
      {main && <a href="#/" aria-current={activeId === main.id ? 'page' : undefined}
        className={cx('press flex items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors duration-150', activeId === main.id ? 'bg-accent-soft' : 'hover:bg-sunken/70')}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg"><MessageCircle size={17} /></span>
        <span className="min-w-0 flex-1">
          <span className={cx('block text-sm font-semibold', activeId === main.id ? 'text-accent' : 'text-fg')}>主聊</span>
          <span className="mt-0.5 block truncate text-xs text-muted">{main.lastMessage?.replace(/\s+/g, ' ') || '一直在这儿的那段对话'}</span>
        </span>
        {mainWaits && <span className="size-2 shrink-0 self-start rounded-full bg-accent mt-1.5" aria-label="有新消息" />}
      </a>}

      <div className="flex items-baseline gap-2 px-2.5 pt-5 pb-1.5 text-xs"><span className="font-medium text-muted">侧聊</span><span className="text-faint">独立的小任务</span></div>
      {side.length === 0 && <button onClick={() => go('/new')} className="w-full rounded-xl px-2.5 py-2 text-left text-xs text-faint hover:text-muted">把一件事单独拎出来聊，就开一个侧聊</button>}
      {side.map(c => <Item key={c.id} c={c} active={c.id === activeId} tickets={ticketsOf(c.id)} onChanged={changed} />)}
      {outside.length > 0 && <div className="px-2.5 pt-5 pb-1.5 text-xs font-medium text-muted">来自外部</div>}
      {outside.map(c => <Item key={c.id} c={c} active={c.id === activeId} tickets={ticketsOf(c.id)} onChanged={changed} />)}
    </nav>

    <div className="flex items-center justify-between px-3 pt-2 pb-3">
      <QuickSettings />
      <button onClick={() => go('/new')} className="press flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-muted hover:bg-sunken hover:text-fg"><SquarePen size={15} />新侧聊</button>
    </div>
  </div>
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
function Item({ c, active, tickets, onChanged }: { c: Conversation; active: boolean; tickets: Ticket[]; onChanged(): void }) {
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
  const sub = waiting ? '等你点头' : working ? (latest?.latestReport?.summary || latest?.title || '在做') : done ? `${day(c.updatedAt)} 做完` : c.lastMessage?.replace(/\s+/g, ' ') || day(c.updatedAt)
  return <div ref={ref} className="group relative">
    <a href={`#/c/${c.id}`} aria-current={active ? 'page' : undefined} className={cx('press relative flex items-center gap-2.5 rounded-xl py-2 pr-9 pl-2.5',
      active ? 'bg-sunken' : 'hover:bg-sunken/60')}>
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
    <button onClick={() => setMenu(v => !v)} aria-label="更多" aria-expanded={menu}
      className={cx('absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-faint hover:bg-panel hover:text-fg max-md:opacity-100',
        menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>
      <MoreHorizontal size={15} />
    </button>
    {menu && <div role="menu" className="anim-menu absolute top-11 right-1 z-20 w-40 rounded-2xl border border-line bg-card p-1 text-sm shadow-xl">
      <MenuItem icon={<Pencil size={14} />} onClick={() => { const t = prompt('重命名', c.title)?.trim(); if (t) patch.mutate({ title: t }); setMenu(false) }}>重命名</MenuItem>
      <MenuItem icon={c.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => { patch.mutate({ pinned: !c.pinned }); setMenu(false) }}>{c.pinned ? '取消置顶' : '置顶'}</MenuItem>
      <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { if (confirm(`删除「${c.title}」？此操作不可撤销。`)) remove.mutate(); setMenu(false) }}>删除</MenuItem>
    </div>}
  </div>
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return <button role="menuitem" onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-xl px-3 py-2 hover:bg-sunken', danger && 'text-danger')}>{icon}{children}</button>
}
