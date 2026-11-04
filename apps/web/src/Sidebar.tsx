import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquarePlus, MoreHorizontal, Pin, PinOff, Settings as SettingsIcon, Trash2, Pencil } from 'lucide-react'
import { useState } from 'react'
import { api, type Conversation } from './api'
import { go, type Route } from './route'
import { cx } from './ui'

export function Sidebar({ route }: { route: Route }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') })
  const conversations = data?.conversations ?? []
  const activeId = route.page === 'chat' ? route.id : undefined

  return <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel max-md:hidden">
    <div className="flex items-center gap-2 px-4 pt-4 pb-3">
      <div className="flex size-7 items-center justify-center rounded-full bg-accent"><div className="size-2.5 rounded-full bg-accent-fg" /></div>
      <span className="font-semibold tracking-tight">Super-agent</span>
    </div>
    <div className="px-3 pb-2">
      <button onClick={() => go('/')} className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-sunken">
        <MessageSquarePlus size={16} className="text-accent" /> 新对话
      </button>
    </div>
    <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
      {conversations.length === 0 && <p className="px-3 py-6 text-center text-xs text-faint">还没有对话</p>}
      {conversations.map(c => <Item key={c.id} c={c} active={c.id === activeId} onChanged={() => qc.invalidateQueries({ queryKey: ['conversations'] })} />)}
    </nav>
    <div className="border-t border-line p-2">
      <button onClick={() => go('/settings/providers')} className={cx('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sunken',
        route.page === 'settings' ? 'bg-sunken text-fg' : 'text-muted')}>
        <SettingsIcon size={16} /> 设置
      </button>
    </div>
  </aside>
}

function Item({ c, active, onChanged }: { c: Conversation; active: boolean; onChanged(): void }) {
  const [menu, setMenu] = useState(false)
  const patch = useMutation({ mutationFn: (body: Partial<Conversation>) => api.patch(`/conversations/${c.id}`, body), onSuccess: onChanged })
  const remove = useMutation({ mutationFn: () => api.del(`/conversations/${c.id}`), onSuccess: () => { onChanged(); if (active) go('/') } })
  return <div className="group relative">
    <a href={`#/c/${c.id}`} className={cx('flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm', active ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-sunken hover:text-fg')}>
      {c.pinned && <Pin size={12} className="shrink-0 text-faint" />}
      <span className="truncate">{c.title}</span>
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

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return <button onClick={onClick} className={cx('flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sunken', danger && 'text-danger')}>{icon}{children}</button>
}
