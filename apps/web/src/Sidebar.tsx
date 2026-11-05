/**
 * Sidebar (Muse): the assistant itself on top — its face, what it is doing, and what waits for you (tap to see the
 * activity); then the main conversation, side chats for separate topics, and threads mirrored from outside
 * (GitHub, Telegram…). On phones it slides in as a drawer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, MessageCircle, MoreHorizontal, Pencil, Pin, PinOff, Plus, Settings as SettingsIcon, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type Conversation, type UpdateStatus } from './api'
import { openActivity, useLive } from './live'
import { Avatar, statusLine, usePersona } from './persona'
import { go, type Route } from './route'
import { useTickets } from './tasks'
import { SourceIcon } from './icons'
import { cx, IconButton } from './ui'

export function Sidebar({ route, open, onClose }: { route: Route; open: boolean; onClose(): void }) {
  // Phones: a drawer over the page. Desktop: a fixed column on the paper ground.
  useEffect(() => { if (open) onClose() }, [JSON.stringify(route)])
  return <>
    <aside className="flex w-[17.5rem] shrink-0 flex-col max-md:hidden"><SidebarBody route={route} /></aside>
    {open && <div className="anim-fade fixed inset-0 z-40 bg-[var(--scrim)] md:hidden " onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="anim-drawer-l flex h-full w-[min(19rem,86vw)] flex-col bg-bg pb-[env(safe-area-inset-bottom)] shadow-2xl">
        <div className="flex justify-end px-3 pt-3"><IconButton label="关闭菜单" onClick={onClose}><X size={18} /></IconButton></div>
        <SidebarBody route={route} />
      </aside>
    </div>}
  </>
}

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
  const live = tickets.filter(t => t.stage !== 'ended')
  const connected = useLive(s => s.connected)
  const persona = usePersona()
  const status = statusLine(live)
  const statusOf = (cnv: string) => {
    const mine = tickets.filter(t => t.conversationId === cnv)
    if (mine.some(t => t.stage.startsWith('person/'))) return 'person'
    if (mine.some(t => t.stage === 'working' || t.stage === 'queued')) return 'working'
    return undefined
  }
  const changed = () => qc.invalidateQueries({ queryKey: ['conversations'] })

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="px-3 pt-3 md:pt-4">
      <button onClick={() => openActivity(true)} className="press flex w-full items-center gap-3 rounded-2xl p-2 text-left hover:bg-panel/70" title="看看我在做什么">
        <Avatar persona={persona} size={40} mood={connected ? status.tone : 'sleepy'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-base leading-tight font-semibold">{persona.name}</span>
          <span className={cx('mt-0.5 block truncate text-xs', status.tone === 'waiting' ? 'text-warn' : 'text-muted')}>{connected ? status.text : '重连中…'}</span>
        </span>
      </button>
    </div>

    <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pt-4 pb-2">
      {main && <NavLink href="#/" active={activeId === main.id} icon={<MessageCircle size={16} />}>
        <span className={cx('flex-1', activeId !== main.id && (main.unread ?? 0) > 0 && 'font-semibold text-fg')}>主对话</span>
        {activeId !== main.id && (main.unread ?? 0) > 0 && <Count n={main.unread!} />}
      </NavLink>}
      <div className="flex items-center gap-1 px-3 pt-5 pb-1.5">
        <span className="flex-1 text-xs text-faint">侧聊</span>
        <button onClick={() => go('/new')} className="press flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-muted hover:bg-panel hover:text-fg" title="新侧聊：单独聊一个话题或项目" aria-label="新侧聊"><Plus size={13} />新建</button>
      </div>
      {side.map(c => <Item key={c.id} c={c} active={c.id === activeId} status={statusOf(c.id)} onChanged={changed} />)}
      {outside.length > 0 && <div className="px-3 pt-5 pb-1.5 text-xs text-faint">外部</div>}
      {outside.map(c => <Item key={c.id} c={c} active={c.id === activeId} status={statusOf(c.id)} onChanged={changed} />)}
    </nav>

    <div className="space-y-0.5 px-3 pt-2 pb-3">
      <NavLink href="#/library" active={route.page === 'library'} icon={<FolderOpen size={16} />}>成果</NavLink>
      <NavLink href={update.data?.available ? '#/settings/system' : '#/settings/persona'} active={route.page === 'settings'} icon={<SettingsIcon size={16} />}>
        <span className="flex-1">设置</span>
        {update.data?.available && <span className="rounded-full bg-lime px-2 text-[10px] leading-[18px] font-semibold text-white" title={`新版本 ${update.data.latest?.tag}`}>有更新</span>}
      </NavLink>
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

const Count = ({ n }: { n: number }) => <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] leading-[18px] font-semibold text-accent-fg tabular-nums">{n}</span>

function NavLink({ href, active, icon, children }: { href: string; active: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return <a href={href} aria-current={active ? 'page' : undefined} className={cx('press flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm',
    active ? 'bg-panel font-medium text-fg shadow-[var(--shadow-sheet)]' : 'text-muted hover:bg-panel/70 hover:text-fg')}>
    <span className={cx('shrink-0', active && 'text-accent')}>{icon}</span>{children}
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
    <a href={`#/c/${c.id}`} aria-current={active ? 'page' : undefined} className={cx('press flex items-center gap-2 rounded-xl py-2 pr-9 pl-3 text-sm',
      active ? 'bg-panel text-fg shadow-[var(--shadow-sheet)]' : 'text-muted hover:bg-panel/70 hover:text-fg')}>
      {c.source !== 'webchat' ? <SourceIcon source={c.source} size={14} className="shrink-0 text-faint" />
        : <span className={cx('size-1.5 shrink-0 rounded-full', active ? 'bg-accent' : 'bg-line')} />}
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
    {menu && <div role="menu" className="anim-menu absolute top-9 right-1 z-20 w-40 rounded-2xl border border-line bg-panel p-1 text-sm shadow-xl">
      <MenuItem icon={<Pencil size={14} />} onClick={() => { const t = prompt('重命名', c.title)?.trim(); if (t) patch.mutate({ title: t }); setMenu(false) }}>重命名</MenuItem>
      <MenuItem icon={c.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => { patch.mutate({ pinned: !c.pinned }); setMenu(false) }}>{c.pinned ? '取消置顶' : '置顶'}</MenuItem>
      <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { if (confirm(`删除「${c.title}」？此操作不可撤销。`)) remove.mutate(); setMenu(false) }}>删除</MenuItem>
    </div>}
  </div>
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return <button role="menuitem" onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-xl px-3 py-2 hover:bg-sunken', danger && 'text-danger')}>{icon}{children}</button>
}
