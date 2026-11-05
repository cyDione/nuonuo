import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity as ActivityIcon, FolderOpen, MessageSquarePlus, MoreHorizontal, Pin, PinOff, Settings as SettingsIcon, Trash2, Pencil } from 'lucide-react'
import { useState } from 'react'
import { api, type Conversation } from './api'
import { go, type Route } from './route'
import { cx } from './ui'
import { useTickets } from './tasks'
import { useLive } from './live'
import { SourceIcon } from './icons'

export function Sidebar({ route }: { route: Route }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') })
  const conversations = data?.conversations ?? []
  const activeId = route.page === 'chat' ? route.id : undefined
  const tickets = useTickets().data?.tickets ?? []
  const connected = useLive(s => s.connected)
  const waiting = tickets.filter(t => t.stage.startsWith('person/')).length
  const statusOf = (cnv: string) => {
    const mine = tickets.filter(t => t.conversationId === cnv)
    if (mine.some(t => t.stage.startsWith('person/'))) return 'person'
    if (mine.some(t => t.stage === 'working' || t.stage === 'queued')) return 'working'
    return undefined
  }

  return <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel max-md:hidden">
    <div className="flex items-center gap-2 px-4 pt-4 pb-3">
      <div className="flex size-7 items-center justify-center rounded-full bg-accent"><div className="size-2.5 rounded-full bg-accent-fg" /></div>
      <span className="font-semibold tracking-tight">Super-agent</span>
      {!connected && <span className="ml-auto text-[11px] text-warn">重连中…</span>}
    </div>
    <div className="px-3 pb-2">
      <button onClick={() => go('/')} className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-sunken">
        <MessageSquarePlus size={16} className="text-accent" /> 新对话
      </button>
    </div>
    <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
      {conversations.length === 0 && <p className="px-3 py-6 text-center text-xs text-faint">还没有对话</p>}
      {conversations.map(c => <Item key={c.id} c={c} active={c.id === activeId} status={statusOf(c.id)} onChanged={() => qc.invalidateQueries({ queryKey: ['conversations'] })} />)}
    </nav>
    <div className="space-y-0.5 border-t border-line p-2">
      <NavButton active={route.page === 'activity'} onClick={() => go('/activity')} icon={<ActivityIcon size={16} />}>
        活动{waiting > 0 && <span className="ml-auto rounded-full bg-warn px-1.5 text-[10px] leading-4 font-medium text-white">{waiting}</span>}
      </NavButton>
      <NavButton active={route.page === 'library'} onClick={() => go('/library')} icon={<FolderOpen size={16} />}>成果</NavButton>
      <NavButton active={route.page === 'settings'} onClick={() => go('/settings/providers')} icon={<SettingsIcon size={16} />}>设置</NavButton>
    </div>
  </aside>
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
      <MenuItem icon={<Pencil size={14} />} onClick={() => { const t = prompt('重命名对话', c.title)?.trim(); if (t) patch.mutate({ title: t }); setMenu(false) }}>重命名</MenuItem>
      <MenuItem icon={c.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => { patch.mutate({ pinned: !c.pinned }); setMenu(false) }}>{c.pinned ? '取消置顶' : '置顶'}</MenuItem>
      <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { if (confirm(`删除「${c.title}」？此操作不可撤销。`)) remove.mutate(); setMenu(false) }}>删除</MenuItem>
    </div>}
  </div>
}

function NavButton({ active, onClick, icon, children }: { active: boolean; onClick(): void; icon: React.ReactNode; children: React.ReactNode }) {
  return <button onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sunken', active ? 'bg-sunken text-fg' : 'text-muted')}>{icon}{children}</button>
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return <button onClick={onClick} className={cx('flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sunken', danger && 'text-danger')}>{icon}{children}</button>
}
