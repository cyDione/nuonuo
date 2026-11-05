/**
 * Sidebar: the assistant's name and a new-topic button on top; the conversation, the activity and the files; then topics
 * (side chats, each with its own colour) and threads mirrored from outside (GitHub, Telegram…); settings at the bottom.
 * A white block slides to whichever item is open. On phones it slides in as a drawer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, Inbox, MessageCircle, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, Settings as SettingsIcon, SquarePen, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, type Conversation, type UpdateStatus } from './api'
import { useLive } from './live'
import { Avatar, statusLine, usePersona } from './persona'
import { go, type Route } from './route'
import { needsOwner, useTickets } from './tasks'
import { SourceIcon } from './icons'
import { cx, IconButton } from './ui'
import { isMacDesktop, Pane, Resizer, togglePane, usePresence } from './shell'

/** The window's title bar row above the sidebar: room for the traffic lights, and the button that folds the sidebar. */
function TitleRow() {
  return <div className="drag flex h-12 shrink-0 items-center justify-end px-3 pt-1">
    {isMacDesktop && <span className="lights-room mr-auto w-[68px]" aria-hidden />}
    <IconButton label="收起侧栏 (⌘\)" onClick={() => togglePane('left', false)} className="size-8 text-faint hover:bg-card/70"><PanelLeft size={17} /></IconButton>
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

const TOPIC_COLORS = ['#ef6aa8', '#1fb37a', '#f2b632', '#7b4fe0', '#2f7cf6', '#14b8c4', '#ff6a3d']
export const topicColor = (id: string) => TOPIC_COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TOPIC_COLORS.length]!

function SidebarBody({ route }: { route: Route }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') })
  const conversations = data?.conversations ?? []
  const main = conversations.find(c => c.meta.main)
  const update = useQuery({ queryKey: ['update'], queryFn: () => api.get<UpdateStatus>('/update'), refetchInterval: 30 * 60_000, retry: false })
  const side = conversations.filter(c => !c.meta.main && c.source === 'webchat')
  const outside = conversations.filter(c => c.source !== 'webchat')
  const activeId = route.page === 'chat' ? (route.id ?? (route.main ? main?.id : undefined)) : undefined
  const tickets = useTickets().data?.tickets ?? []
  const waiting = tickets.filter(needsOwner).length
  const connected = useLive(s => s.connected)
  const persona = usePersona()
  const statusOf = (cnv: string) => {
    const mine = tickets.filter(t => t.conversationId === cnv)
    if (mine.some(t => t.stage.startsWith('person/'))) return 'person'
    if (mine.some(t => t.stage === 'working' || t.stage === 'queued')) return 'working'
    return undefined
  }
  const changed = () => qc.invalidateQueries({ queryKey: ['conversations'] })

  // The white block that slides to the open item.
  const navRef = useRef<HTMLElement>(null)
  const [mark, setMark] = useState<{ y: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const nav = navRef.current, el = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    setMark(nav && el ? { y: el.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop, h: el.offsetHeight } : null)
  }, [activeId, route.page, conversations.length, outside.length])

  const live = tickets.filter(t => t.stage !== 'ended')
  const status = statusLine(live)
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center gap-2 px-3 pt-1">
      <a href="#/me" aria-current={route.page === 'me' ? 'page' : undefined} className={cx('squish press flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl p-2 transition-[background-color,box-shadow] duration-200',
        route.page === 'me' ? 'bg-card shadow-[var(--shadow-sheet)] ring-1 ring-accent/25' : 'bg-card/55 hover:bg-card/90')}>
        <Avatar persona={persona} size={38} mood={connected ? status.tone : 'sleepy'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-[15px] leading-tight font-semibold">{persona.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted"><StatusDot tone={connected ? status.tone : 'offline'} /><span className="truncate">{connected ? status.text : '重连中…'}</span></span>
        </span>
      </a>
      <button onClick={() => go('/new')} aria-label="新话题" title="新话题" className="press flex size-9 shrink-0 items-center justify-center rounded-xl bg-card text-fg shadow-[var(--shadow-sheet)] hover:text-accent"><SquarePen size={16} /></button>
    </div>

    <nav ref={navRef} className="relative min-h-0 flex-1 overflow-y-auto px-2.5 pt-3 pb-2">
      {mark && <span className="nav-indicator pointer-events-none absolute right-2.5 left-2.5 top-0 rounded-xl bg-card shadow-[var(--shadow-sheet)]" style={{ transform: `translateY(${mark.y}px)`, height: mark.h }} aria-hidden />}
      {main && <NavLink href="#/" active={activeId === main.id} icon={<MessageCircle size={17} />}>
        <span className="flex-1">对话</span>
        {activeId !== main.id && (main.unread ?? 0) > 0 && <Count n={main.unread!} />}
      </NavLink>}
      <NavLink href="#/activity" active={route.page === 'activity'} icon={<Inbox size={17} />}>
        <span className="flex-1">动态</span>
        {waiting > 0 && <span key={waiting} className="bump rounded-full bg-sun px-1.5 text-[11px] leading-[18px] font-semibold text-[#121212] tabular-nums">{waiting}</span>}
      </NavLink>
      <NavLink href="#/library" active={route.page === 'library'} icon={<FolderOpen size={17} />}>成果</NavLink>

      {side.length > 0 && <div className="px-3 pt-5 pb-1 text-xs font-medium text-faint">话题</div>}
      {side.map(c => <Item key={c.id} c={c} active={c.id === activeId} status={statusOf(c.id)} onChanged={changed} />)}
      {outside.length > 0 && <div className="px-3 pt-5 pb-1 text-xs font-medium text-faint">来自外部</div>}
      {outside.map(c => <Item key={c.id} c={c} active={c.id === activeId} status={statusOf(c.id)} onChanged={changed} />)}
    </nav>

    <div className="px-2.5 pt-2 pb-3">
      <a href={update.data?.available ? '#/settings/system' : '#/settings/providers'} aria-current={route.page === 'settings' ? 'page' : undefined}
        className={cx('press flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm', route.page === 'settings' ? 'bg-card font-medium text-fg shadow-[var(--shadow-sheet)]' : 'text-muted hover:text-fg')}>
        <SettingsIcon size={17} className={cx('shrink-0', route.page === 'settings' && 'text-accent')} />
        <span className="flex-1">设置</span>
        {update.data?.available && <span className="rounded-full bg-lime px-2 text-[11px] leading-[18px] font-medium text-white" title={`新版本 ${update.data.latest?.tag}`}>有更新</span>}
      </a>
    </div>
  </div>
}

export function StatusDot({ tone }: { tone: 'idle' | 'working' | 'waiting' | 'offline' }) {
  const color = tone === 'waiting' ? 'bg-warn' : tone === 'working' ? 'bg-accent' : tone === 'offline' ? 'bg-faint' : 'bg-ok'
  return <span className="relative flex size-2 shrink-0">
    {(tone === 'working' || tone === 'waiting') && <span className={cx('ping-soft absolute inset-0 rounded-full', color)} />}
    <span className={cx('relative size-2 rounded-full', color)} />
  </span>
}

const Count = ({ n }: { n: number }) => <span key={n} className="bump shrink-0 rounded-full bg-accent px-1.5 text-[10px] leading-[18px] font-semibold text-accent-fg tabular-nums">{n}</span>

function NavLink({ href, active, icon, children }: { href: string; active: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return <a href={href} aria-current={active ? 'page' : undefined} className={cx('press relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm',
    active ? 'font-medium text-fg' : 'text-muted hover:bg-card/50 hover:text-fg')}>
    <span className={cx('shrink-0 transition-colors duration-200', active && 'text-accent')}>{icon}</span>{children}
  </a>
}

function Item({ c, active, status, onChanged }: { c: Conversation; active: boolean; status?: 'person' | 'working'; onChanged(): void }) {
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
  const unread = !active && !status && (c.unread ?? 0) > 0
  return <div ref={ref} className="group relative">
    <a href={`#/c/${c.id}`} aria-current={active ? 'page' : undefined} className={cx('press relative flex items-center gap-2.5 rounded-xl py-2 pr-9 pl-3 text-sm',
      active ? 'text-fg' : 'text-muted hover:bg-card/50 hover:text-fg')}>
      {c.source !== 'webchat' ? <SourceIcon source={c.source} size={14} className="shrink-0 text-faint" />
        : <span className="size-2 shrink-0 rounded-full transition-transform duration-200 group-hover:scale-125" style={{ background: topicColor(c.id) }} />}
      <span className={cx('min-w-0 flex-1 truncate', !active && (c.unread ?? 0) > 0 && 'font-semibold text-fg')}>{c.title}</span>
      {c.pinned && <Pin size={12} className="shrink-0 text-faint" />}
      {unread && <Count n={c.unread!} />}
      {status === 'person' && <span className="size-2 shrink-0 rounded-full bg-warn" title="有事等你" />}
      {status === 'working' && <StatusDot tone="working" />}
    </a>
    <button onClick={() => setMenu(v => !v)} aria-label="更多" aria-expanded={menu}
      className={cx('absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-faint hover:bg-sunken hover:text-fg max-md:opacity-100',
        menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>
      <MoreHorizontal size={15} />
    </button>
    {menu && <div role="menu" className="anim-menu absolute top-9 right-1 z-20 w-40 rounded-2xl border border-line bg-card p-1 text-sm shadow-xl">
      <MenuItem icon={<Pencil size={14} />} onClick={() => { const t = prompt('重命名', c.title)?.trim(); if (t) patch.mutate({ title: t }); setMenu(false) }}>重命名</MenuItem>
      <MenuItem icon={c.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => { patch.mutate({ pinned: !c.pinned }); setMenu(false) }}>{c.pinned ? '取消置顶' : '置顶'}</MenuItem>
      <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { if (confirm(`删除「${c.title}」？此操作不可撤销。`)) remove.mutate(); setMenu(false) }}>删除</MenuItem>
    </div>}
  </div>
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return <button role="menuitem" onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-xl px-3 py-2 hover:bg-sunken', danger && 'text-danger')}>{icon}{children}</button>
}
