import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type FieldSpec, type SourceInfo } from '../api'
import { SourceIcon } from '../icons'
import { Badge, Button, Card, DetailHeader, Field, Input, ListRow, Select, cx } from '../ui'

export function Sources({ item }: { item?: string }) {
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[] }>('/sources'), refetchInterval: 10_000 })
  if (!sources.data) return null
  if (item) {
    const s = sources.data.sources.find(x => x.id === item)
    return s ? <SourceDetail key={s.id} s={s} /> : <Card className="p-5 text-sm text-muted">找不到来源「{item}」。<a href="#/settings/sources" className="text-accent">返回来源列表</a></Card>
  }
  return <Card className="divide-y divide-line overflow-hidden">{sources.data.sources.map(s => {
    const health = HEALTH[s.health.status]
    return <ListRow key={s.id} href={`#/settings/sources/${encodeURIComponent(s.id)}`} icon={<SourceIcon source={s.id} size={18} />} title={s.title}
      badge={<Badge tone={health.tone}>{health.label}</Badge>}
      detail={s.health.status === 'error' && s.health.detail ? <span className="text-danger">{s.health.detail}</span> : s.description} />
  })}</Card>
}

const HEALTH: Record<SourceInfo['health']['status'], { tone: 'neutral' | 'ok' | 'warn' | 'danger'; label: string }> = {
  off: { tone: 'neutral', label: '未启用' }, starting: { tone: 'warn', label: '启动中' }, ok: { tone: 'ok', label: '运行中' }, error: { tone: 'danger', label: '出错' },
}

/** One source's own settings page, generated from its field specs. */
function SourceDetail({ s }: { s: SourceInfo }) {
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
  return <div className="space-y-4">
    <DetailHeader back="#/settings/sources" backLabel="来源" icon={<SourceIcon source={s.id} size={20} />} title={s.title} badge={<Badge tone={health.tone}>{health.label}</Badge>}>{s.description}</DetailHeader>
    {(s.health.detail || Object.keys(s.facts).length > 0) && <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
      {Object.entries(s.facts).map(([k, v]) => <span key={k}>{k}：<span className="font-mono">{v}</span></span>)}
      {s.health.detail && <span className={s.health.status === 'error' ? 'text-danger' : ''}>{s.health.detail}</span>}
    </div>}
    <Card className="p-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.enabled} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} className="size-4 accent-[var(--accent)]" />启用这个来源
      </label>
      {fields.length > 0 && <div className="mt-4 grid gap-3 sm:grid-cols-2">{fields.map(f => <FieldInput key={f.key} f={f} value={draft.config[f.key]} onChange={v => set(f.key, v)} />)}</div>}
      {more.length > 0 && <>
        <button onClick={() => setAdvanced(v => !v)} className="mt-4 flex items-center gap-1 text-xs text-muted hover:text-fg">高级 <ChevronDown size={13} className={cx(advanced && 'rotate-180')} /></button>
        {advanced && <div className="mt-2 grid gap-3 sm:grid-cols-2">{more.map(f => <FieldInput key={f.key} f={f} value={draft.config[f.key]} onChange={v => set(f.key, v)} />)}</div>}
      </>}
      {(dirty || save.error || poll.error || s.actions.length > 0 || (s.enabled && s.fields.length > 0)) && <div className="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3">
        {(save.error || poll.error) && <span className="mr-auto text-xs text-danger">{((save.error ?? poll.error) as Error).message}</span>}
        {!dirty && s.actions.map(a => <Button key={a.id} size="sm" onClick={async () => {
          const res = await fetch(`/api/sources/${s.id}/http/${a.path}`, { credentials: 'same-origin' })
          const data = await res.json().catch(async () => ({ error: await res.text() }))
          if (data.url) location.href = data.url
          else alert(data.error?.message ?? data.error ?? `${res.status}`)
        }}>{a.label}</Button>)}
        {s.enabled && s.fields.length > 0 && !dirty && <Button size="sm" variant="ghost" onClick={() => poll.mutate()} disabled={poll.isPending}>
          <RefreshCw size={13} className={poll.isPending ? 'animate-spin' : ''} />立即同步</Button>}
        {dirty && <>
          <Button size="sm" variant="ghost" onClick={() => setDraft({ enabled: s.enabled, config: s.config })}>还原</Button>
          <Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>保存</Button>
        </>}
      </div>}
    </Card>
  </div>
}

function FieldInput({ f, value, onChange }: { f: FieldSpec; value: any; onChange(v: unknown): void }) {
  switch (f.type) {
    case 'list': return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}>
      <textarea className="min-h-20 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-accent" placeholder={f.placeholder}
        value={(value ?? []).join('\n')} onChange={e => onChange(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))} />
    </Field>
    case 'secret': return <Field label={f.label} hint={value === '••••••' ? '已保存在钥匙串里；留空保存会清除' : f.hint ?? '保存在系统钥匙串里，不写入数据库'}>
      <Input type="password" autoComplete="off" value={value ?? ''} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} onFocus={e => { if (value === '••••••') e.target.select() }} />
    </Field>
    case 'number': return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}><Input type="number" min={f.min} max={f.max} value={value ?? ''} onChange={e => onChange(Number(e.target.value))} /></Field>
    case 'switch': return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(value)} onChange={e => onChange(e.target.checked)} />{f.label}</label>
    case 'select': return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}><Select value={value ?? ''} onChange={e => onChange(e.target.value)}>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
    default: return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}><Input value={value ?? ''} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} /></Field>
  }
}
