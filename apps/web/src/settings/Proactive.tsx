import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type ProactiveSettings, type SourceInfo } from '../api'
import { Button, Card, cx, Field, Input } from '../ui'

const MODES: { id: ProactiveSettings['mode']; label: string; hint: string }[] = [
  { id: 'off', label: '关闭', hint: '只处理找我的事（@ 我、私信、你在网页上说的话）。' },
  { id: 'observe', label: '观察', hint: '按策略判断，但只记下「本来会做」的事，在「活动」里由你决定要不要做。适合先试一段时间。' },
  { id: 'auto', label: '自动', hint: '值得做的事在后台悄悄做（只在本地调查、复现、准备方案，不对外发任何东西），有价值才告诉你。' },
]

export function ProactivePage() {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['proactive'], queryFn: () => api.get<{ settings: ProactiveSettings; defaults: ProactiveSettings }>('/settings/proactive') }).data
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[] }>('/sources') }).data?.sources.filter(s => s.id !== 'cron') ?? []
  const [form, setForm] = useState<ProactiveSettings | null>(null)
  useEffect(() => { if (data) setForm(data.settings) }, [data])
  const save = useMutation({ mutationFn: (s: ProactiveSettings) => api.put('/settings/proactive', s), onSuccess: () => { qc.invalidateQueries({ queryKey: ['proactive'] }); qc.invalidateQueries({ queryKey: ['activity'] }) } })
  if (!data || !form) return null
  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings)
  return <div className="space-y-3">
    <Card className="p-4">
      <div className="text-sm font-medium">模式</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {MODES.map(m => <button key={m.id} onClick={() => setForm({ ...form, mode: m.id })}
          className={cx('rounded-xl border px-3 py-2.5 text-left', form.mode === m.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-sunken')}>
          <div className="text-sm font-medium">{m.label}</div><div className="mt-0.5 text-xs text-muted">{m.hint}</div>
        </button>)}
      </div>
    </Card>
    <Card className="space-y-3 p-4">
      <Field label="策略（用你自己的话写：什么值得做、什么别管）" hint="过滤层模型照着它判断每一个没人找我的事件。对智能体说「以后 CI 挂了你先看看」也会更新这里。">
        <textarea className="min-h-36 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm leading-6 outline-none focus:border-accent"
          value={form.strategy} onChange={e => setForm({ ...form, strategy: e.target.value })} />
      </Field>
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted">关注的来源</span>
        <div className="flex flex-wrap gap-1.5">
          {sources.map(s => { const on = !form.sources.length || form.sources.includes(s.id)
            return <button key={s.id} onClick={() => {
              const all = sources.map(x => x.id)
              const cur = form.sources.length ? form.sources : all
              const next = on ? cur.filter(x => x !== s.id) : [...cur, s.id]
              setForm({ ...form, sources: next.length === all.length ? [] : next })
            }} className={cx('rounded-lg border px-2.5 py-1 text-xs', on ? 'border-accent bg-accent-soft' : 'border-line text-muted')}>{s.title}</button> })}
          {!sources.length && <span className="text-xs text-faint">还没有启用来源。</span>}
        </div>
      </div>
      <Field label="不理会的账号（逗号分隔）">
        <Input value={form.ignoreActors.join(', ')} onChange={e => setForm({ ...form, ignoreActors: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
      </Field>
    </Card>
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, strategy: data.defaults.strategy })}>用示例策略</Button>
      {dirty && <Button size="sm" variant="ghost" onClick={() => setForm(data.settings)}>还原</Button>}
      <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(form)}>保存</Button>
    </div>
  </div>
}
