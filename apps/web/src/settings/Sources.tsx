import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type FieldSpec, type SourceAction, type SourceInfo } from '../api'
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
  // Authorization buttons live on their own card; the rest stay in the footer.
  const other = s.authorized === undefined ? s.actions : []
  return <div className="space-y-4">
    <DetailHeader back="#/settings/sources" backLabel="来源" icon={<SourceIcon source={s.id} size={20} />} title={s.title} badge={<Badge tone={health.tone}>{health.label}</Badge>}>{s.description}</DetailHeader>
    {s.authorized !== undefined && <Authorization s={s} onDone={() => { void qc.invalidateQueries({ queryKey: ['sources'] }); if (s.enabled) poll.mutate() }} />}
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
      {(dirty || save.error || poll.error || other.length > 0 || (s.enabled && s.fields.length > 0)) && <div className="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3">
        {(save.error || poll.error) && <span className="mr-auto text-xs text-danger">{((save.error ?? poll.error) as Error).message}</span>}
        {!dirty && other.map(a => <Button key={a.id} size="sm" onClick={async () => {
          const data = await runAction(s.id, a)
          if (data?.url) location.href = data.url
          else void qc.invalidateQueries({ queryKey: ['sources'] })
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

/** Calls an action endpoint; alerts and returns undefined on an error. */
async function runAction(id: string, a: SourceAction): Promise<Record<string, any> | undefined> {
  if (a.confirm && !confirm(a.confirm)) return undefined
  const res = await fetch(`/api/sources/${id}/http/${a.path}`, { method: 'POST', credentials: 'same-origin' })
  const data = await res.json().catch(async () => ({ error: await res.text() }))
  if (!res.ok || data.error) { alert(data.error?.message ?? data.error ?? `${res.status}`); return undefined }
  return data
}

type Device = { userCode: string; verificationUri: string; expiresIn: number; poll: string }

/** The account authorization: its state, the sign-in / disconnect buttons, and the device-flow code while one is pending. */
function Authorization({ s, onDone }: { s: SourceInfo; onDone(): void }) {
  const [device, setDevice] = useState<Device>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!device) return
    const timer = setInterval(async () => {
      const data = await fetch(`/api/sources/${s.id}/http/${device.poll}`, { credentials: 'same-origin' }).then(r => r.json()).catch(() => undefined) as { status: string; error?: string } | undefined
      if (data?.status === 'done') { setDevice(undefined); onDone() }
      else if (data?.status === 'error') { setDevice(undefined); setError(data.error ?? '授权失败') }
    }, 2_000)
    const expire = setTimeout(() => { setDevice(undefined); setError('验证码已过期，请重新授权') }, device.expiresIn * 1000)
    return () => { clearInterval(timer); clearTimeout(expire) }
  }, [device])
  const account = s.facts['账号']
  return <Card className="p-4">
    <div className="flex flex-wrap items-center gap-3">
      <div className="mr-auto text-sm">
        <div className="font-medium">账号授权</div>
        <div className="mt-0.5 text-xs text-muted">{s.authorized
          ? <>已授权{account && account !== '未授权' ? <>：<span className="font-mono">{account}</span></> : ''}</>
          : `还没有授权。点「${s.actions.find(a => a.show === 'unauthorized')?.label ?? '授权'}」用你的 ${s.title} 账号登录并同意访问。`}</div>
      </div>
      {s.actions.map(a => <Button key={a.id} size="sm" variant={a.primary ? 'primary' : a.show === 'authorized' && a.confirm ? 'ghost' : 'secondary'} disabled={Boolean(device)} onClick={async () => {
        setError(undefined)
        const data = await runAction(s.id, a)
        if (!data) return
        if (data.url) location.href = data.url
        else if (data.device) { setDevice(data.device); setCopied(false); window.open(data.device.verificationUri, '_blank', 'noopener') }
        else onDone()
      }}>{a.label}</Button>)}
    </div>
    {device && <div className="mt-4 rounded-lg border border-line bg-panel p-4 text-sm">
      <div>在打开的页面（<a href={device.verificationUri} target="_blank" rel="noopener" className="inline-flex items-center gap-0.5 text-accent">{device.verificationUri.replace(/^https?:\/\//, '')}<ExternalLink size={12} /></a>）输入这个验证码并同意授权：</div>
      <div className="mt-3 flex items-center gap-3">
        <span className="select-all font-mono text-2xl tracking-widest">{device.userCode}</span>
        <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(device.userCode); setCopied(true) }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</Button>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted"><RefreshCw size={12} className="animate-spin" />等待你在 {s.title} 上确认…
        <button className="ml-auto text-muted hover:text-fg" onClick={() => setDevice(undefined)}>取消</button></div>
    </div>}
    {error && <div className="mt-3 text-xs text-danger">{error}</div>}
  </Card>
}

function FieldInput({ f: spec, value, onChange }: { f: FieldSpec; value: any; onChange(v: unknown): void }) {
  // Links ride along in the hint, so every field type shows them.
  const f = spec.links?.length ? { ...spec, hint: <>{spec.hint}{spec.hint && ' '}{spec.links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener"
    className="mr-2 inline-flex items-center gap-0.5 text-accent hover:underline" onClick={e => e.stopPropagation()}>{l.label}<ExternalLink size={11} /></a>)}</> } : spec
  switch (f.type) {
    case 'list': return <Field label={f.label} {...(f.hint ? { hint: f.hint } : {})}>
      <textarea className="min-h-20 w-full rounded-xl border border-line bg-panel px-3 py-2 font-mono text-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15 focus-visible:outline-none" placeholder={f.placeholder}
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
