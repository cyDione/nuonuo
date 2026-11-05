import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api, type Routine } from '../api'
import { go } from '../route'
import { Badge, Button, Card, Empty, Field, Input, Modal, Select } from '../ui'

const PRESETS = [
  { label: '每天 9:00', value: '0 9 * * *' }, { label: '工作日 9:00', value: '0 9 * * 1-5' }, { label: '每天 18:00', value: '0 18 * * *' },
  { label: '每周一 10:00', value: '0 10 * * 1' }, { label: '每小时', value: '0 * * * *' }, { label: '自定义', value: '' },
]

export function Routines() {
  const qc = useQueryClient()
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') })
  const [editing, setEditing] = useState<Routine | 'new' | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['routines'] })
  const toggle = useMutation({ mutationFn: (r: Routine) => api.patch(`/routines/${r.id}`, { enabled: !r.enabled }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: (r: Routine) => api.del(`/routines/${r.id}`), onSuccess: refresh })
  const run = useMutation({ mutationFn: (r: Routine) => api.post<{ routine: Routine }>(`/routines/${r.id}/run`), onSuccess: d => { refresh(); qc.invalidateQueries({ queryKey: ['conversations'] }); setTimeout(() => d.routine.conversationId && go(`/c/${d.routine.conversationId}`), 300) } })
  const list = routines.data?.routines ?? []
  return <>
    <div className="flex justify-end"><Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />新建定时任务</Button></div>
    {routines.isSuccess && !list.length && <Card><Empty icon={<AlarmClock size={28} />} title="还没有定时任务">也可以直接在对话里说：「每天早上 9 点给我一份昨天的 GitHub 动态简报」。</Empty></Card>}
    <div className="space-y-3">{list.map(r => <Card key={r.id} className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <AlarmClock size={18} className="mt-0.5 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="font-medium">{r.name}</span><Badge tone={r.enabled ? 'accent' : 'neutral'}>{r.enabled ? '启用' : '已暂停'}</Badge></div>
          <div className="mt-0.5 font-mono text-xs text-muted">{r.schedule}{r.next ? <span className="font-sans text-faint"> · 下次 {new Date(r.next).toLocaleString()}</span> : null}</div>
          <p className="mt-1.5 line-clamp-2 text-sm text-muted">{r.prompt}</p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => run.mutate(r)} disabled={run.isPending}><Play size={13} />立即运行</Button>
          {r.conversationId && <Button size="sm" variant="ghost" onClick={() => go(`/c/${r.conversationId}`)}>查看对话</Button>}
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>{r.enabled ? <Pause size={13} /> : <Play size={13} />}</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => { if (confirm(`删除「${r.name}」？`)) remove.mutate(r) }}><Trash2 size={13} /></Button>
        </div>
      </div>
    </Card>)}</div>
    {editing && <RoutineModal routine={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
  </>
}

function RoutineModal({ routine, onClose, onSaved }: { routine?: Routine; onClose(): void; onSaved(): void }) {
  const [name, setName] = useState(routine?.name ?? '')
  const [schedule, setSchedule] = useState(routine?.schedule ?? '0 9 * * *')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const preset = PRESETS.find(p => p.value === schedule)?.value ?? ''
  const save = useMutation({
    mutationFn: () => routine ? api.patch(`/routines/${routine.id}`, { name, schedule, prompt }) : api.post('/routines', { name, schedule, prompt }),
    onSuccess: () => { onSaved(); onClose() },
  })
  return <Modal title={routine ? '编辑定时任务' : '新建定时任务'} onClose={onClose} footer={<Button variant="primary" disabled={!name.trim() || !prompt.trim() || save.isPending} onClick={() => save.mutate()}>保存</Button>}>
    <Field label="名称"><Input value={name} onChange={e => setName(e.target.value)} placeholder="每日简报" autoFocus /></Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="时间"><Select value={preset} onChange={e => e.target.value && setSchedule(e.target.value)}>{PRESETS.map(p => <option key={p.label} value={p.value}>{p.label}</option>)}</Select></Field>
      <Field label="cron（分 时 日 月 周，本地时间）"><Input className="font-mono" value={schedule} onChange={e => setSchedule(e.target.value)} /></Field>
    </div>
    <Field label="要做的事" hint="到点时，这段话会以你的名义发给主 Agent。">
      <textarea className="min-h-28 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15 focus-visible:outline-none" value={prompt}
        onChange={e => setPrompt(e.target.value)} placeholder="汇总我关注的仓库昨天的新 Issue 和 PR，挑出需要我处理的" />
    </Field>
    {save.error && <p className="text-sm text-danger">{(save.error as Error).message}</p>}
  </Modal>
}
