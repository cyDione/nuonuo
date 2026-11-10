/** 定时任务 (Figma 21 · 02): what it does on a schedule. The list, then the one being edited right under it. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, Plus } from 'lucide-react'
import { useState } from 'react'
import { api, type Routine } from '../api'
import { go } from '../route'
import { Area, Block, Btn, Page, Row, Section, SelectInput, TextInput, Toggle } from './kit'

const PRESETS = [
  { label: '每天 9:00', value: '0 9 * * *' }, { label: '工作日 9:00', value: '0 9 * * 1-5' }, { label: '每天 18:00', value: '0 18 * * *' },
  { label: '每周一 10:00', value: '0 10 * * 1' }, { label: '每小时', value: '0 * * * *' },
]
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** "30 8 * * *" → 每天 08:30; anything unusual stays as the cron line. */
export function describeCron(cron: string): string {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/)
  if (!m || !h || dom !== '*' || mon !== '*' || !dow) return cron
  if (h === '*' && m === '0' && dow === '*') return '每小时'
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return cron
  const t = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  if (dow === '*') return `每天 ${t}`
  if (dow === '1-5') return `工作日 ${t}`
  if (/^[0-6]$/.test(dow)) return `每周${WEEK[Number(dow)]} ${t}`
  return cron
}

export function Routines() {
  const qc = useQueryClient()
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') })
  const [editing, setEditing] = useState<Routine | 'new' | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['routines'] })
  const run = useMutation({ mutationFn: (r: Routine) => api.post<{ routine: Routine }>(`/routines/${r.id}/run`),
    onSuccess: d => { refresh(); qc.invalidateQueries({ queryKey: ['conversations'] }); if (d.routine.conversationId) go(`/c/${d.routine.conversationId}`) } })
  const list = routines.data?.routines ?? []
  return <Page title="定时任务" action={<Btn tone="ink" className="h-[32px] rounded-[10px]" onClick={() => setEditing('new')}><Plus size={15} />新建</Btn>}>
    <Section foot="到点后它在主聊里处理，结果也发在那里。也可以直接跟糯糯说「每天早上 9 点……」。">
      {list.map(r => <Row key={r.id} icon={<AlarmClock size={18} />} label={r.name}
        sub={<span className="line-clamp-1">{r.enabled ? describeCron(r.schedule) : '已暂停'} · {r.prompt}</span>}>
        <Btn onClick={() => run.mutate(r)} disabled={run.isPending}>立即运行</Btn>
        <Btn onClick={() => setEditing(r)}>编辑</Btn>
      </Row>)}
      {routines.isSuccess && !list.length && <Row label="还没有定时任务" sub="点右上角「新建」，或者在聊天里说「每天早上 9 点给我一份昨天的简报」。" />}
    </Section>
    {editing && <Editor key={editing === 'new' ? 'new' : editing.id} routine={editing === 'new' ? undefined : editing} onDone={() => { setEditing(null); refresh() }} />}
  </Page>
}

function Editor({ routine, onDone }: { routine?: Routine; onDone(): void }) {
  const [name, setName] = useState(routine?.name ?? '')
  const [schedule, setSchedule] = useState(routine?.schedule ?? '0 9 * * *')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [enabled, setEnabled] = useState(routine?.enabled ?? true)
  const save = useMutation({
    mutationFn: () => routine ? api.patch(`/routines/${routine.id}`, { name, schedule, prompt, enabled }) : api.post('/routines', { name, schedule, prompt }),
    onSuccess: onDone,
  })
  const remove = useMutation({ mutationFn: () => api.del(`/routines/${routine!.id}`), onSuccess: onDone })
  const preset = PRESETS.find(p => p.value === schedule)?.value ?? ''
  return <Section title={routine ? `编辑 · ${routine.name}` : '新建定时任务'}>
    <Row label="名称"><TextInput value={name} onChange={e => setName(e.target.value)} placeholder="每日简报" autoFocus={!routine} /></Row>
    <Row label="时间">
      <SelectInput value={preset} onChange={e => e.target.value && setSchedule(e.target.value)} className="w-[220px]">
        {PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        <option value="">{preset ? '自定义' : describeCron(schedule)}</option>
      </SelectInput>
    </Row>
    <Row label="cron" sub="分 时 日 月 周，本地时间"><TextInput value={schedule} onChange={e => setSchedule(e.target.value)} className="font-mono" /></Row>
    {routine && <Row label="启用" sub="关掉就先不跑，设置都留着"><Toggle label="启用" checked={enabled} onChange={setEnabled} /></Row>}
    <Block>
      <div className="mb-2.5 text-sm">要做的事</div>
      <Area value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="汇总我关注的仓库昨天的新 issue 和 PR，挑出需要我处理的。" />
    </Block>
    <Block className="flex flex-wrap items-center justify-end gap-2">
      {(save.error || remove.error) && <span className="mr-auto text-xs text-danger">{((save.error ?? remove.error) as Error).message}</span>}
      {routine && <Btn tone="danger" className="mr-auto" onClick={() => { if (confirm(`删除「${routine.name}」？`)) remove.mutate() }}>删除</Btn>}
      <Btn onClick={onDone}>取消</Btn>
      <Btn tone="ink" disabled={!name.trim() || !prompt.trim() || !schedule.trim() || save.isPending} onClick={() => save.mutate()}>保存</Btn>
    </Block>
  </Section>
}
