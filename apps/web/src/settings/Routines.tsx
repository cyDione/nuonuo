/** 定时任务 (Figma 21 · 02): what it does on a schedule. The list, then the one being edited right under it. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, Check, ChevronDown, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { api, type Routine, type RoutineRun } from '../api'
import { cx } from '../ui'
import { go } from '../route'
import { Area, Block, Btn, Page, Row, Section, SelectInput, TextInput, Toggle } from './kit'
import { locale, tx } from '../i18n'

const PRESETS = [
  { label: tx('每天 9:00'), value: '0 9 * * *' }, { label: tx('工作日 9:00'), value: '0 9 * * 1-5' }, { label: tx('每天 18:00'), value: '0 18 * * *' },
  { label: tx('每周一 10:00'), value: '0 10 * * 1' }, { label: tx('每小时'), value: '0 * * * *' },
]
const WEEK = [tx('日'), tx('一'), tx('二'), tx('三'), tx('四'), tx('五'), tx('六')]

/** "30 8 * * *" → 每天 08:30; anything unusual stays as the cron line. */
export function describeCron(cron: string): string {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/)
  if (!m || !h || dom !== '*' || mon !== '*' || !dow) return cron
  if (h === '*' && m === '0' && dow === '*') return tx('每小时')
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return cron
  const t = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  if (dow === '*') return tx('每天 {0}', t)
  if (dow === '1-5') return tx('工作日 {0}', t)
  if (/^[0-6]$/.test(dow)) return tx('每周{0} {1}', WEEK[Number(dow)], t)
  return cron
}

export function Routines() {
  const qc = useQueryClient()
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') })
  const [editing, setEditing] = useState<Routine | 'new' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['routines'] })
  const run = useMutation({ mutationFn: (r: Routine) => api.post<{ routine: Routine }>(`/routines/${r.id}/run`),
    onSuccess: d => { refresh(); qc.invalidateQueries({ queryKey: ['conversations'] }); if (d.routine.conversationId) go(`/c/${d.routine.conversationId}`) } })
  const list = routines.data?.routines ?? []
  return <Page title={tx('定时任务')} action={<Btn tone="ink" className="h-[32px] rounded-[10px]" onClick={() => setEditing('new')}><Plus size={15} />{tx('新建')}</Btn>}>
    <Section foot={tx('到点后它在主聊里处理，结果也发在那里。也可以直接跟糯糯说「每天早上 9 点……」。')}>
      {list.map(r => <div key={r.id}>
        <Row icon={<AlarmClock size={18} />} label={r.name}
          sub={<span className="line-clamp-1">{r.enabled ? describeCron(r.schedule) : tx('已暂停')} · {r.prompt}</span>}>
          {r.lastFiredAt && <span className="text-xs text-faint tabular-nums max-sm:hidden">{when(r.lastFiredAt)}</span>}
          <button onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} aria-label={tx('{0} 的运行记录', r.name)}
            className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"><ChevronDown size={16} className={cx(open === r.id && 'rotate-180')} /></button>
        </Row>
        {open === r.id && <Runs routine={r} onRun={() => run.mutate(r)} running={run.isPending} onEdit={() => setEditing(r)}
          onPause={() => api.patch(`/routines/${r.id}`, { enabled: !r.enabled }).then(refresh)} />}
      </div>)}
      {routines.isSuccess && !list.length && <Row label={tx('还没有定时任务')} sub={tx('点右上角「新建」，或者在聊天里说「每天早上 9 点给我一份昨天的简报」。')} />}
    </Section>
    {editing && <Editor key={editing === 'new' ? 'new' : editing.id} routine={editing === 'new' ? undefined : editing} onDone={() => { setEditing(null); refresh() }} />}
  </Page>
}

const when = (at: number) => {
  const d = new Date(at), today = new Date()
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  const t = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return `${days === 0 ? tx('今天') : days === 1 ? tx('昨天') : tx('{0} 月 {1} 日', d.getMonth() + 1, d.getDate())} ${t}`
}

/** 最近运行 (Figma section 25, H): each time it fired, and what came of it; a run that failed says why. */
function Runs({ routine, onRun, running, onEdit, onPause }: { routine: Routine; onRun(): void; running: boolean; onEdit(): void; onPause(): void }) {
  const runs = useQuery({ queryKey: ['routine-runs', routine.id], queryFn: () => api.get<{ runs: RoutineRun[] }>(`/routines/${routine.id}/runs`) }).data?.runs
  const [all, setAll] = useState(false)
  const shown = all ? runs ?? [] : (runs ?? []).slice(0, 4)
  return <Block>
    <div className="mb-2 text-xs text-faint">{tx('最近运行')}</div>
    {runs && !runs.length && <p className="text-sm text-faint">{tx('还没跑过。')}</p>}
    <div className="space-y-1.5">{shown.map(r => <div key={r.id} className="flex items-start gap-3 text-[13px]">
      {r.ok ? <Check size={15} className="mt-0.5 shrink-0 text-ok" /> : <X size={15} className="mt-0.5 shrink-0 text-danger" />}
      <span className="w-[110px] shrink-0 tabular-nums">{when(r.at)}</span>
      <a href={r.reply ? `#/c/${r.reply.conversationId}` : '#/'} className={cx('min-w-0 flex-1 line-clamp-2 hover:underline', !r.ok && 'text-danger')}>
        {r.reply?.text ?? (r.ticket ? `${r.ticket.title} · ${r.outcome.text}` : r.outcome.text)}</a>
    </div>)}</div>
    {runs && runs.length > 4 && !all && <button onClick={() => setAll(true)} className="mt-2 text-[13px] text-accent">{tx('看更早的')} {runs.length - 4} {tx('次')}</button>}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Btn tone="ink" onClick={onRun} disabled={running}>{tx('立即运行')}</Btn>
      <Btn onClick={onPause}>{routine.enabled ? tx('暂停') : tx('恢复')}</Btn>
      <Btn onClick={onEdit}>{tx('编辑')}</Btn>
    </div>
  </Block>
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
  return <Section title={routine ? tx('编辑 · {0}', routine.name) : tx('新建定时任务')}>
    <Row label={tx('名称')}><TextInput value={name} onChange={e => setName(e.target.value)} placeholder={tx('每日简报')} autoFocus={!routine} /></Row>
    <Row label={tx('时间')}>
      <SelectInput value={preset} onChange={e => e.target.value && setSchedule(e.target.value)} className="w-[220px]">
        {PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        <option value="">{preset ? tx('自定义') : describeCron(schedule)}</option>
      </SelectInput>
    </Row>
    <Row label="cron" sub={tx('分 时 日 月 周，本地时间')}><TextInput value={schedule} onChange={e => setSchedule(e.target.value)} className="font-mono" /></Row>
    {routine && <Row label={tx('启用')} sub={tx('关掉就先不跑，设置都留着')}><Toggle label={tx('启用')} checked={enabled} onChange={setEnabled} /></Row>}
    <Block>
      <div className="mb-2.5 text-sm">{tx('要做的事')}</div>
      <Area value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={tx('汇总我关注的仓库昨天的新 issue 和 PR，挑出需要我处理的。')} />
    </Block>
    <Block className="flex flex-wrap items-center justify-end gap-2">
      {(save.error || remove.error) && <span className="mr-auto text-xs text-danger">{((save.error ?? remove.error) as Error).message}</span>}
      {routine && <Btn tone="danger" className="mr-auto" onClick={() => { if (confirm(tx('删除「{0}」？', routine.name))) remove.mutate() }}>{tx('删除')}</Btn>}
      <Btn onClick={onDone}>{tx('取消')}</Btn>
      <Btn tone="ink" disabled={!name.trim() || !prompt.trim() || !schedule.trim() || save.isPending} onClick={() => save.mutate()}>{tx('保存')}</Btn>
    </Block>
  </Section>
}
