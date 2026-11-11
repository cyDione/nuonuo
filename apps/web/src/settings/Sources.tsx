/**
 * 来源 (Figma 21 · 03): where it hears from and answers in. The list with each one's state; the open one's own settings
 * below it: on/off, 主动留意这里 (its events go through the proactive strategy), the account, its fields, and syncing.
 * Figma section 25, H2: 已经连上的 say only how syncing goes; 还能连 offer 连接. What each account may do (只能看 / 能操作)
 * lives only in the right pane's 权限.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type FieldSpec, type ProactiveSettings, type SourceAction, type SourceInfo } from '../api'
import { SourceIcon } from '../icons'
import { Area, Block, Btn, Foot, NumberInput, Page, Pill, Row, SaveBar, Section, SelectInput, TextInput, Toggle } from './kit'
import { locale, tx } from '../i18n'

/** 「刚刚同步」, 「2 分钟前同步」, 「出错」…: how syncing goes, said in a few words. */
function syncing(s: SourceInfo) {
  if (s.health.status === 'error') return <span className="text-danger">{tx('出错了')}</span>
  if (s.health.status === 'starting') return tx('在连…')
  if (s.id === 'cron' || !s.health.at) return s.health.status === 'ok' ? tx('在线') : HEALTH[s.health.status].label
  const min = Math.floor((Date.now() - s.health.at) / 60_000)
  return min < 1 ? tx('刚刚同步') : min < 60 ? tx('{0} 分钟前同步', min) : min < 1440 ? tx('{0} 小时前同步', Math.floor(min / 60)) : tx('{0} 天前同步', Math.floor(min / 1440))
}

const HEALTH: Record<SourceInfo['health']['status'], { tone: 'neutral' | 'ok' | 'warn' | 'danger'; label: string }> = {
  off: { tone: 'neutral', label: tx('没打开') }, starting: { tone: 'warn', label: tx('启动中') }, ok: { tone: 'ok', label: tx('运行中') }, error: { tone: 'danger', label: tx('出错') },
}

export function Sources({ item }: { item?: string }) {
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[] }>('/sources'), refetchInterval: 10_000 })
  const list = sources.data?.sources ?? []
  const open = item ? list.find(x => x.id === item) : undefined
  const on = list.filter(s => s.enabled), off = list.filter(s => !s.enabled)
  const href = (s: SourceInfo) => `#/settings/sources/${encodeURIComponent(s.id)}`
  return <Page title={tx('来源')}>
    {on.length > 0 && <Section title={tx('已经连上的')} foot={off.length ? undefined : tx('连上以后，每个账号能做到哪一步（只能看 / 能操作）在右侧栏「权限」里改。')}>
      {on.map(s => <Row key={s.id} href={href(s)} icon={<SourceIcon source={s.id} size={18} />} label={s.title}
        sub={<span className="line-clamp-1">{s.health.status === 'error' && s.health.detail ? <span className="text-danger">{s.health.detail}</span> : s.description}</span>}>
        <span className="text-[13px] text-muted tabular-nums">{syncing(s)}</span>
      </Row>)}
    </Section>}
    {off.length > 0 && <Section title={on.length ? tx('还能连') : undefined} foot={tx('连上以后，每个账号能做到哪一步（只能看 / 能操作）在右侧栏「权限」里改。')}>
      {off.map(s => <Row key={s.id} icon={<SourceIcon source={s.id} size={18} />} label={s.title} sub={<span className="line-clamp-1">{s.description}</span>}>
        <a href={href(s)} className="inline-flex h-[28px] shrink-0 items-center rounded-full border border-line bg-card px-4 text-[13px] font-medium hover:border-faint">{tx('连接')}</a>
      </Row>)}
    </Section>}
    {item && sources.isSuccess && !open && <Foot>{tx('找不到来源「{0}」。', item)}</Foot>}
    {open && <SourceDetail key={open.id} s={open} />}
  </Page>
}

/** One source's own settings, generated from its field specs. */
function SourceDetail({ s }: { s: SourceInfo }) {
  const qc = useQueryClient()
  const [config, setConfig] = useState(s.config)
  const [advanced, setAdvanced] = useState(false)
  useEffect(() => setConfig(s.config), [JSON.stringify(s.config)])
  const dirty = JSON.stringify(config) !== JSON.stringify(s.config)
  const refresh = () => qc.invalidateQueries({ queryKey: ['sources'] })
  const save = useMutation({ mutationFn: (body: { enabled: boolean; config: Record<string, unknown> }) => api.put(`/sources/${s.id}`, body), onSuccess: refresh })
  const poll = useMutation({ mutationFn: () => api.post(`/sources/${s.id}/poll`), onSuccess: refresh })
  const proactive = useQuery({ queryKey: ['proactive'], queryFn: () => api.get<{ settings: ProactiveSettings }>('/settings/proactive') }).data?.settings
  const all = (useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[] }>('/sources') }).data?.sources ?? []).filter(x => x.id !== 'cron').map(x => x.id)
  const watch = useMutation({
    mutationFn: (on: boolean) => {
      const cur = proactive!.sources.length ? proactive!.sources : all
      const next = on ? [...new Set([...cur, s.id])] : cur.filter(x => x !== s.id)
      return api.put('/settings/proactive', { ...proactive!, sources: next.length === all.length ? [] : next })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['proactive'] }),
  })
  const watching = Boolean(proactive && (!proactive.sources.length || proactive.sources.includes(s.id)))
  const set = (key: string, value: unknown) => setConfig(c => ({ ...c, [key]: value }))
  const fields = s.fields.filter(f => !f.advanced)
  const more = s.fields.filter(f => f.advanced)
  const other = s.authorized === undefined ? s.actions : []
  const facts = Object.entries(s.facts).filter(([k]) => k !== '账号').map(([k, v]) => `${k}：${v}`)
  return <>
    <Section title={s.title} foot={s.description}>
      <Row label={tx('启用')}><Toggle label={tx('启用')} checked={s.enabled} disabled={save.isPending} onChange={enabled => save.mutate({ enabled, config: s.config })} /></Row>
      {s.id !== 'cron' && proactive && <Row label={tx('主动留意这里')} sub={tx('没人找它的事件，也按你的主动策略判断要不要做')}>
        <Toggle label={tx('主动留意这里')} checked={watching} disabled={watch.isPending} onChange={on => watch.mutate(on)} />
      </Row>}
      {s.authorized !== undefined && <Authorization s={s} onDone={() => { void refresh(); if (s.enabled) poll.mutate() }} />}
      {fields.map(f => <FieldRow key={f.key} f={f} value={config[f.key]} onChange={v => set(f.key, v)} />)}
      {more.length > 0 && <Row label={tx('高级')} onClick={() => setAdvanced(v => !v)}><span className="text-[13px] text-muted">{advanced ? tx('收起') : tx('{0} 项', more.length)}</span></Row>}
      {advanced && more.map(f => <FieldRow key={f.key} f={f} value={config[f.key]} onChange={v => set(f.key, v)} />)}
      {other.length > 0 && <Row label={tx('操作')}>{other.map(a => <Btn key={a.id} disabled={dirty} onClick={async () => {
        const data = await runAction(s.id, a)
        if (data?.url) location.href = data.url
        else void refresh()
      }}>{a.label}</Btn>)}</Row>}
      {s.enabled && s.fields.length > 0 && <Row label={tx('上次同步')} sub={<>{s.health.at ? new Date(s.health.at).toLocaleString(locale) : tx('还没有')}{facts.length ? ` · ${facts.join(' · ')}` : ''}
        {s.health.detail && <span className={s.health.status === 'error' ? 'block text-danger' : 'block'}>{s.health.detail}</span>}</>}>
        <Btn onClick={() => poll.mutate()} disabled={poll.isPending || dirty}><RefreshCw size={13} className={poll.isPending ? 'animate-spin' : ''} />{tx('立即同步')}</Btn>
      </Row>}
    </Section>
    <SaveBar dirty={dirty} pending={save.isPending} error={save.error ?? poll.error} onReset={() => setConfig(s.config)} onSave={() => save.mutate({ enabled: s.enabled, config })} />
  </>
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

/** 账号授权: its state and the sign-in / disconnect buttons, then the device-flow code while one is pending. */
function Authorization({ s, onDone }: { s: SourceInfo; onDone(): void }) {
  const [device, setDevice] = useState<Device>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!device) return
    const timer = setInterval(async () => {
      const data = await fetch(`/api/sources/${s.id}/http/${device.poll}`, { credentials: 'same-origin' }).then(r => r.json()).catch(() => undefined) as { status: string; error?: string } | undefined
      if (data?.status === 'done') { setDevice(undefined); onDone() }
      else if (data?.status === 'error') { setDevice(undefined); setError(data.error ?? tx('授权失败')) }
    }, 2_000)
    const expire = setTimeout(() => { setDevice(undefined); setError(tx('验证码已过期，请重新授权')) }, device.expiresIn * 1000)
    return () => { clearInterval(timer); clearTimeout(expire) }
  }, [device])
  const account = s.facts['账号']
  return <>
    <Row label={tx('账号授权')} sub={<>{s.authorized ? tx('已授权{0}', account && account !== '未授权' ? ` · ${account}` : '') : tx('还没有授权，点「{0}」用你的 {1} 账号登录', s.actions.find(a => a.show === 'unauthorized')?.label ?? tx('授权'), s.title)}
      {error && <span className="block text-danger">{error}</span>}</>}>
      {s.actions.map(a => <Btn key={a.id} tone={a.primary ? 'ink' : 'plain'} disabled={Boolean(device)} onClick={async () => {
        setError(undefined)
        const data = await runAction(s.id, a)
        if (!data) return
        if (data.url) location.href = data.url
        else if (data.device) { setDevice(data.device); setCopied(false); window.open(data.device.verificationUri, '_blank', 'noopener') }
        else onDone()
      }}>{a.label}</Btn>)}
    </Row>
    {device && <Block className="text-[13px]">
      <div>{tx('在打开的页面（')}<a href={device.verificationUri} target="_blank" rel="noopener" className="inline-flex items-center gap-0.5 text-accent">{device.verificationUri.replace(/^https?:\/\//, '')}<ExternalLink size={12} /></a>{tx('）输入这个验证码并同意授权：')}</div>
      <div className="mt-2.5 flex items-center gap-3">
        <span className="font-mono text-2xl tracking-widest select-all">{device.userCode}</span>
        <Btn onClick={() => { void navigator.clipboard?.writeText(device.userCode); setCopied(true) }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? tx('已复制') : tx('复制')}</Btn>
        <span className="ml-auto text-xs text-muted">{tx('等你在 {0} 上确认…', s.title)}</span>
        <Btn onClick={() => setDevice(undefined)}>{tx('取消')}</Btn>
      </div>
    </Block>}
  </>
}

function FieldRow({ f, value, onChange }: { f: FieldSpec; value: any; onChange(v: unknown): void }) {
  const sub = <>{f.type === 'secret' && value === '••••••' ? tx('已存在钥匙串里；清空后保存会删除') : f.hint}
    {f.links?.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener" className="ml-1.5 inline-flex items-center gap-0.5 text-accent">{l.label}<ExternalLink size={11} /></a>)}</>
  switch (f.type) {
    case 'switch': return <Row label={f.label} sub={sub}><Toggle label={f.label} checked={Boolean(value)} onChange={onChange} /></Row>
    case 'list': return <Block>
      <div className="mb-1 text-sm">{f.label}</div>
      {(f.hint || f.links) && <div className="mb-2 text-xs text-muted">{sub}</div>}
      <Area className="font-mono" placeholder={f.placeholder} value={(value ?? []).join('\n')} onChange={e => onChange(e.target.value.split('\n').map(x => x.trim()).filter(Boolean))} />
    </Block>
    case 'number': return <Row label={f.label} sub={sub}><NumberInput min={f.min} max={f.max} value={value ?? ''} onChange={e => onChange(Number(e.target.value))} aria-label={f.label} /></Row>
    case 'select': return <Row label={f.label} sub={sub}><SelectInput value={value ?? ''} onChange={e => onChange(e.target.value)}>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</SelectInput></Row>
    case 'secret': return <Row label={f.label} sub={sub}><TextInput type="password" autoComplete="off" value={value ?? ''} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} onFocus={e => { if (value === '••••••') e.target.select() }} /></Row>
    default: return <Row label={f.label} sub={sub}><TextInput value={value ?? ''} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} /></Row>
  }
}
