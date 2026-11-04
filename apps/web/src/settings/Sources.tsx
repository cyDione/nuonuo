import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type FieldSpec, type SourceInfo } from '../api'
import { SourceIcon } from '../icons'
import { Badge, Button, Card, Field, Input, Select, cx } from '../ui'

export function Sources() {
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[] }>('/sources'), refetchInterval: 10_000 })
  return <div className="space-y-3">{sources.data?.sources.map(s => <SourceCard key={s.id} s={s} />)}</div>
}

const HEALTH: Record<SourceInfo['health']['status'], { tone: 'neutral' | 'ok' | 'warn' | 'danger'; label: string }> = {
  off: { tone: 'neutral', label: '未启用' }, starting: { tone: 'warn', label: '启动中' }, ok: { tone: 'ok', label: '运行中' }, error: { tone: 'danger', label: '出错' },
}

/** A settings card generated from the source's field specs. */
function SourceCard({ s }: { s: SourceInfo }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState({ enabled: s.enabled, config: s.config })
  const [advanced, setAdvanced] = useState(false)
  useEffect(() => setDraft({ enabled: s.enabled, config: s.config }), [JSON.stringify([s.enabled, s.config])])
  const dirty = JSON.stringify(draft) !== JSON.stringify({ enabled: s.enabled, config: s.config })
  const save = useMutation({ mutationFn: () => api.put(`/sources/${s.id}`, draft), onSuccess: () => qc.invalidateQueries({ queryKey: ['sources'] }) })
  const poll = useMutation({ mutationFn: () => api.post(`/sources/${s.id}/poll`), onSuccess: () => qc.invalidateQueries({ queryKey: ['sources'] }) })
  const set = (key: string, value: unknown) => setDraft(d => ({ ...d, config: { ...d.config, [key]: value } }))
  const health = HEALTH[s.health.status]
  const fields = s.fields.filter(f => !f.advanced)
  const more = s.fields.filter(f => f.advanced)
  return <Card className="p-4">
    <div className="flex flex-wrap items-start gap-3">
      <SourceIcon source={s.id} size={20} className="mt-0.5 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="font-medium">{s.title}</span><Badge tone={health.tone}>{health.label}</Badge></div>
        <p className="mt-0.5 text-xs text-muted">{s.description}</p>
        {(s.health.detail || Object.keys(s.facts).length > 0) && <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-faint">
          {Object.entries(s.facts).map(([k, v]) => <span key={k}>{k}：<span className="font-mono">{v}</span></span>)}
          {s.health.detail && <span className={s.health.status === 'error' ? 'text-danger' : ''}>{s.health.detail}</span>}
        </div>}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.enabled} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} className="size-4 accent-[var(--accent)]" />启用
      </label>
    </div>
    {fields.length > 0 && <div className="mt-4 grid gap-3 sm:grid-cols-2">{fields.map(f => <FieldInput key={f.key} f={f} value={draft.config[f.key]} onChange={v => set(f.key, v)} />)}</div>}
    {more.length > 0 && <>
      <button onClick={() => setAdvanced(v => !v)} className="mt-3 flex items-center gap-1 text-xs text-muted hover:text-fg">高级 <ChevronDown size={13} className={cx(advanced && 'rotate-180')} /></button>
      {advanced && <div className="mt-2 grid gap-3 sm:grid-cols-2">{more.map(f => <FieldInput key={f.key} f={f} value={draft.config[f.key]} onChange={v => set(f.key, v)} />)}</div>}
    </>}
    <div className="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3">
      {(save.error || poll.error) && <span className="mr-auto text-xs text-danger">{((save.error ?? poll.error) as Error).message}</span>}
      {s.enabled && s.fields.length > 0 && !dirty && <Button size="sm" variant="ghost" onClick={() => poll.mutate()} disabled={poll.isPending}>
        <RefreshCw size={13} className={poll.isPending ? 'animate-spin' : ''} />立即同步</Button>}
      {dirty && <>
        <Button size="sm" variant="ghost" onClick={() => setDraft({ enabled: s.enabled, config: s.config })}>还原</Button>
        <Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>保存</Button>
      </>}
    </div>
  </Card>
}

function FieldInput({ f, value, onChange }: { f: FieldSpec; value: any; onChange(v: unknown): void }) {
  switch (f.type) {
    case 'list': return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}>
      <textarea className="min-h-20 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-accent" placeholder={f.placeholder}
        value={(value ?? []).join('\n')} onChange={e => onChange(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))} />
    </Field>
    case 'number': return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}><Input type="number" min={f.min} max={f.max} value={value ?? ''} onChange={e => onChange(Number(e.target.value))} /></Field>
    case 'switch': return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(value)} onChange={e => onChange(e.target.checked)} />{f.label}</label>
    case 'select': return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}><Select value={value ?? ''} onChange={e => onChange(e.target.value)}>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
    default: return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}><Input value={value ?? ''} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} /></Field>
  }
}
