/** Memory: what the assistant keeps about you, entry by entry — with where it came from, and a queue of what waits for your OK. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { Badge, Button, Card, cx, Empty, Input, Select } from '../ui'

type Kind = 'profile' | 'project' | 'episodic' | 'lesson'
interface Entry { id: string; kind: Kind; scope: string | null; text: string; status: 'active' | 'pending'; trust: 'user' | 'system' | 'external'; confidence: number
  sourceRefs: string[]; createdBy: string; expiresAt: number | null; createdAt: number; updatedAt: number }
interface MemoriesResponse { memories: Entry[]; scopes: Record<string, string>; kinds: { id: Kind; label: string }[] }

const BY = (e: Entry) => e.createdBy === 'owner' ? '你添加的' : e.createdBy === 'distiller' ? '从对话里整理' : e.createdBy === 'import' ? '旧版导入' : e.createdBy === 'router' ? '对话中记下' : '做事时记下'
export function MemoryPage() {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['memories'], queryFn: () => api.get<MemoriesResponse>('/memories') }).data
  const [kind, setKind] = useState<Kind>('profile')
  const refresh = () => qc.invalidateQueries({ queryKey: ['memories'] })
  const consolidate = useMutation({ mutationFn: () => api.post<{ expired: number; merged: number }>('/memories/consolidate'), onSuccess: refresh })
  if (!data) return null
  const pending = data.memories.filter(m => m.status === 'pending')
  const active = data.memories.filter(m => m.status === 'active')
  const shown = active.filter(m => m.kind === kind)
  const scopes = [...new Set(shown.map(m => m.scope ?? ''))]
  return <div className="space-y-4">
    {pending.length > 0 && <Card className="p-4">
      <div className="text-sm font-medium">等你确认 · {pending.length}</div>
      <div className="mt-3 divide-y divide-line">{pending.map(m => <PendingRow key={m.id} m={m} scopes={data.scopes} onDone={refresh} />)}</div>
    </Card>}
    <div className="flex flex-wrap items-center gap-1">
      {data.kinds.map(k => <button key={k.id} onClick={() => setKind(k.id)} className={cx('rounded-lg px-3 py-1.5 text-sm', kind === k.id ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-sunken')}>
        {k.label}<span className="ml-1 text-xs text-faint">{active.filter(m => m.kind === k.id).length}</span></button>)}
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => consolidate.mutate()} disabled={consolidate.isPending}>整理（去重、清理过期）</Button>
    </div>
    <AddRow kind={kind} onDone={refresh} />
    {!shown.length ? <Empty title="还没有" /> : scopes.map(scope => <Card key={scope} className="p-1">
      {kind === 'project' && <div className="px-3 pt-2.5 pb-1 text-xs font-medium text-muted">{data.scopes[scope] ?? scope}</div>}
      <div className="divide-y divide-line">{shown.filter(m => (m.scope ?? '') === scope).map(m => <EntryRow key={m.id} m={m} onDone={refresh} />)}</div>
    </Card>)}
  </div>
}

function Meta({ m }: { m: Entry }) {
  return <span className="text-[11px] text-faint">{BY(m)}{m.confidence < 1 ? ` · 把握 ${Math.round(m.confidence * 100)}%` : ''}{m.expiresAt ? ` · 到 ${new Date(m.expiresAt).toLocaleDateString()}` : ''} · {new Date(m.updatedAt).toLocaleDateString()}</span>
}

function PendingRow({ m, scopes, onDone }: { m: Entry; scopes: Record<string, string>; onDone(): void }) {
  const [text, setText] = useState(m.text)
  const act = useMutation({ mutationFn: (action: 'confirm' | 'reject') => api.patch(`/memories/${m.id}`, { action, ...(action === 'confirm' && text !== m.text ? { text } : {}) }), onSuccess: onDone })
  return <div className="flex items-start gap-2 py-2.5">
    <div className="min-w-0 flex-1 space-y-1">
      <Input value={text} onChange={e => setText(e.target.value)} className="h-8" />
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={m.trust === 'external' ? 'warn' : 'neutral'}>{m.trust === 'external' ? '来自外部' : '不太确定'}</Badge>
        <Badge>{({ profile: '关于你', project: `项目 ${scopes[m.scope ?? ''] ?? m.scope ?? ''}`, episodic: '近期', lesson: '经验' } as Record<Kind, string>)[m.kind]}</Badge>
        <Meta m={m} />
      </div>
    </div>
    <Button size="sm" variant="primary" onClick={() => act.mutate('confirm')} disabled={act.isPending}><Check size={13} />记住</Button>
    <Button size="sm" variant="ghost" onClick={() => act.mutate('reject')} disabled={act.isPending}><X size={13} />不要</Button>
  </div>
}

function EntryRow({ m, onDone }: { m: Entry; onDone(): void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(m.text)
  const save = useMutation({ mutationFn: () => api.patch(`/memories/${m.id}`, { action: 'edit', text }), onSuccess: () => { setEditing(false); onDone() } })
  const remove = useMutation({ mutationFn: () => api.del(`/memories/${m.id}`), onSuccess: onDone })
  return <div className="group flex items-start gap-2 px-3 py-2">
    <div className="min-w-0 flex-1">
      {editing ? <Input value={text} onChange={e => setText(e.target.value)} className="h-8" autoFocus onKeyDown={e => { if (e.key === 'Enter') save.mutate(); if (e.key === 'Escape') setEditing(false) }} />
        : <div className="text-sm">{m.text}</div>}
      <Meta m={m} />
    </div>
    {editing ? <Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>保存</Button> : <>
      <button onClick={() => setEditing(true)} className="mt-0.5 rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-fg" aria-label="修改"><Pencil size={13} /></button>
      <button onClick={() => remove.mutate()} className="mt-0.5 rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-danger" aria-label="删除"><Trash2 size={13} /></button>
    </>}
  </div>
}

function AddRow({ kind, onDone }: { kind: Kind; onDone(): void }) {
  const [text, setText] = useState('')
  const [scope, setScope] = useState('')
  const [days, setDays] = useState('30')
  const add = useMutation({ mutationFn: () => api.post('/memories', { kind, text, ...(kind === 'project' ? { scope } : {}), ...(kind === 'episodic' ? { ttlDays: Number(days) || 30 } : {}) }),
    onSuccess: () => { setText(''); onDone() } })
  return <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (text.trim().length >= 2) add.mutate() }}>
    <Input value={text} onChange={e => setText(e.target.value)} placeholder="添加一条…" />
    {kind === 'project' && <div className="w-48 shrink-0"><Input value={scope} onChange={e => setScope(e.target.value)} placeholder="项目（如 owner/repo）" /></div>}
    {kind === 'episodic' && <div className="w-28 shrink-0"><Select value={days} onChange={e => setDays(e.target.value)}>{['7', '14', '30', '90'].map(d => <option key={d} value={d}>{d} 天</option>)}</Select></div>}
    <Button type="submit" disabled={add.isPending || text.trim().length < 2 || (kind === 'project' && !scope.trim())}><Plus size={14} />添加</Button>
    {add.error && <span className="self-center text-xs text-danger">{(add.error as Error).message}</span>}
  </form>
}
