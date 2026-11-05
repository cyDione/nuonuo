/**
 * Sidebar (Muse): the assistant itself on top — tap it to see what it is doing; then the main conversation, side chats
 * for separate topics, and threads mirrored from outside (GitHub, Telegram…).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, MessageCircle, MoreHorizontal, Pencil, Pin, PinOff, Plus, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api, type Conversation } from './api'
import { openActivity, useLive } from './live'
import { Avatar, statusLine, usePersona } from './persona'
import { go, type Route } from './route'
import { useTickets } from './tasks'
import { SourceIcon } from './icons'
import { cx } from './ui'

export function Sidebar({ route }: { route: Route }) {
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
  const status = statusLine(tickets.filter(t => t.stage !== 'ended'))
  const statusOf = (cnv: string) => {
    const mine = tickets.filter(t => t.conversationId === cnv)
    if (mine.some(t => t.stage.startsWith('person/'))) return 'person'
    if (mine.some(t => t.stage === 'working' || t.stage === 'queued')) return 'working'
    return undefined
  }
  const changed = () => qc.invalidateQueries({ queryKey: ['conversations'] })

  return <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel max-md:hidden">
    <button onClick={() => openActivity(true)} className="flex items-center gap-2.5 px-4 pt-4 pb-3 text-left" title="看看我在做什么">
      <span className="relative">
        <Avatar persona={persona} size={34} />
        {status.tone !== 'idle' && <span className={cx('absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-panel', status.tone === 'waiting' ? 'bg-warn' : 'animate-pulse bg-accent')} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold tracking-tight">{persona.name}</span>
        <span className={cx('block truncate text-xs', status.tone === 'waiting' ? 'text-warn' : 'text-faint')}>{connected ? status.text : '重连中…'}</span>
      </span>
    </button>
    <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
      {main && <a href="#/" className={cx('flex items-center gap-2 rounded-lg px-3 py-2 text-sm', activeId === main.id ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-sunken hover:text-fg')}>
        <MessageCircle size={15} className="shrink-0" />
        <span className={cx('flex-1', activeId !== main.id && (main.unread ?? 0) > 0 && 'font-semibold text-fg')}>主对话</span>
        {activeId !== main.id && (main.unread ?? 0) > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 font-medium text-accent-fg">{main.unread}</span>}
      </a>}
      <div className="flex items-center px-3 pt-3 pb-1 text-[11px] font-medium text-faint">
        <span className="flex-1">侧聊</span>
        <button onClick={() => go('/new')} className="rounded p-0.5 hover:bg-sunken hover:text-fg" title="新侧聊：单独聊一个话题或项目" aria-label="新侧聊"><Plus size={14} /></button>
      </div>
      {!side.length && <p className="px-3 py-1 text-xs text-faint">一个话题或项目单独聊，它会记住这个项目的约定。</p>}
      {side.map(c => <Item key={c.id} c={c} active={c.id === activeId} status={statusOf(c.id)} onChanged={changed} />)}
      {outside.length > 0 && <div className="px-3 pt-3 pb-1 text-[11px] font-medium text-faint">外部</div>}
      {outside.map(c => <Item key={c.id} c={c} active={c.id === activeId} status={statusOf(c.id)} onChanged={changed} />)}
    </nav>
    <div className="space-y-0.5 border-t border-line p-2">
      <NavButton active={route.page === 'library'} onClick={() => go('/library')} icon={<FolderOpen size={16} />}>成果</NavButton>
      <NavButton active={route.page === 'settings'} onClick={() => go('/settings/persona')} icon={<SettingsIcon size={16} />}>设置</NavButton>
    </div>
  </aside>
}

function NavButton({ active, onClick, icon, children }: { active: boolean; onClick(): void; icon: React.ReactNode; children: React.ReactNode }) {
  return <button onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sunken', active ? 'bg-sunken text-fg' : 'text-muted')}>{icon}{children}</button>
}

function Item({ c, active, status, onChanged }: { c: Conversation; active: boolean; status?: 'person' | 'working'; onChanged(): void }) {
  const [menu, setMenu] = useState(false)
  const patch = useMutation({ mutationFn: (body: Partial<Conversation>) => api.patch(`/conversations/${c.id}`, body), onSuccess: onChanged })
  const remove = useMutation({ mutationFn: () => api.del(`/conversations/${c.id}`), onSuccess: () => { onChanged(); if (active) go('/') } })
  return <div className="group relative">
    <a href={`#/c/${c.id}`} className={cx('flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm', active ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-sunken hover:text-fg')}>
      {c.pinned && <Pin size={12} className="shrink-0 text-faint" />}
      {c.source !== 'webchat' && <SourceIcon source={c.source} size={13} className="shrink-0 text-faint" />}
      <span className={cx('min-w-0 flex-1 truncate', !active && (c.unread ?? 0) > 0 && 'font-semibold text-fg')}>{c.title}</span>
      {!active && !status && (c.unread ?? 0) > 0 && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] leading-4 font-medium text-accent-fg">{c.unread}</span>}
      {status === 'person' && <span className="size-2 shrink-0 rounded-full bg-warn" title="有事等你" />}
      {status === 'working' && <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" title="正在处理" />}
    </a>
    <button onClick={() => setMenu(v => !v)} aria-label="更多" className="absolute top-1.5 right-1.5 rounded p-1 text-faint opacity-0 hover:bg-line group-hover:opacity-100">
      <MoreHorizontal size={14} />
    </button>
    {menu && <div className="absolute top-8 right-1 z-20 w-36 rounded-lg border border-line bg-panel py-1 text-sm shadow-lg" onMouseLeave={() => setMenu(false)}>
      <MenuItem icon={<Pencil size={14} />} onClick={() => { const t = prompt('重命名', c.title)?.trim(); if (t) patch.mutate({ title: t }); setMenu(false) }}>重命名</MenuItem>
      <MenuItem icon={c.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => { patch.mutate({ pinned: !c.pinned }); setMenu(false) }}>{c.pinned ? '取消置顶' : '置顶'}</MenuItem>
      <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { if (confirm(`删除「${c.title}」？此操作不可撤销。`)) remove.mutate(); setMenu(false) }}>删除</MenuItem>
    </div>}
  </div>
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return <button onClick={onClick} className={cx('flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sunken', danger && 'text-danger')}>{icon}{children}</button>
}
