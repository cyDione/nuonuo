/**
 * 系统和更新 (Figma 21 · 16): the version and updates (check by itself, channel, install by itself), the background
 * service, who may open the web version, and health (the watchdog and the environment check).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check as CheckIcon, Copy, Download, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type AccessStatus, type Check, type Health, type UpdatePrefs, type UpdateStatus } from '../api'
import { BRAND, Mascot } from '../persona'
import { Btn, Choice, Foot, NumberInput, Page, Row, Section, TextInput, Toggle } from './kit'
import { tx } from '../i18n'

const REPO = 'https://github.com/cyDione/super-assistant'
const uptime = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? tx('{0} 分钟', m) : m < 1440 ? tx('{0} 小时', Math.floor(m / 60)) : tx('{0} 天', Math.floor(m / 1440)) }

export function System() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health') }).data
  return <Page title={tx('系统和更新')}>
    <Updates />
    {health && <Section title={tx('服务')}>
      <Service health={health} />
      <Row label={tx('密钥存储')}><span className="text-[13px] text-muted">{health.secrets === 'keychain' ? tx('系统钥匙串') : tx('加密文件')}</span></Row>
    </Section>}
    <Access />
    <Healthy />
  </Page>
}

/** The header card and 更新: checked by the service twice a day; a package install can update itself and restart. */
function Updates() {
  const qc = useQueryClient()
  const [updating, setUpdating] = useState<{ from: string; target: string } | null>(null)
  const [lost, setLost] = useState(false)
  const status = useQuery({ queryKey: ['update'], queryFn: () => api.get<UpdateStatus>('/update'), refetchInterval: updating ? 2000 : false, retry: false })
  const check = useMutation({ mutationFn: () => api.post<UpdateStatus>('/update/check'), onSuccess: data => qc.setQueryData(['update'], data) })
  const setPrefs = useMutation({ mutationFn: (patch: Partial<UpdatePrefs>) => api.put<UpdateStatus>('/update/settings', patch), onSuccess: data => qc.setQueryData(['update'], data) })
  const start = useMutation({
    mutationFn: () => api.post<UpdateStatus>('/update'),
    onSuccess: data => { qc.setQueryData(['update'], data); setLost(false); setUpdating({ from: data.current, target: data.run?.target ?? '' }) },
  })
  const s = status.data
  // The service restarts mid-update: requests fail for a moment, then the new version answers.
  const reloaded = useRef(false)
  useEffect(() => {
    if (!updating) return
    if (status.isError) setLost(true)
    if (s && s.current !== updating.from && !reloaded.current) { reloaded.current = true; setTimeout(() => location.reload(), 800) }
    if (s?.run?.state === 'failed') setUpdating(null)
  }, [status.dataUpdatedAt, status.errorUpdatedAt])
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!updating) { setSlow(false); return }
    const t = setTimeout(() => setSlow(true), 45_000)
    return () => clearTimeout(t)
  }, [updating])
  if (!s) return null
  const running = Boolean(updating) || s.run?.state === 'running'
  const stuck = running && slow && Boolean(updating)
  const state = running ? (stuck ? (lost ? tx('服务没有回来：在终端运行 super-assistant start 看看') : tx('装好了，但服务没有重启：请手动重启')) : lost ? tx('正在重启服务…') : tx('正在安装 {0}…', updating?.target || s.run?.target))
    : s.checkError ? tx('检查失败') : s.available ? tx('{0} 可以更新了', s.latest?.tag) : s.latest ? tx('已是最新') : tx('还没检查过')
  const prefs = s.prefs
  return <>
    <div className="flex items-center gap-4 rounded-2xl bg-sunken px-5 py-4">
      <Mascot color={BRAND} size={48} />
      <div className="min-w-0 flex-1">
        <div className="text-[17px] font-semibold">super-assistant</div>
        <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted">
          <span>v{s.current.replace(/^v/, '')}</span>·<span className={s.available ? 'text-accent' : s.checkError ? 'text-danger' : ''}>{state}</span>·
          <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-fg">GitHub</a>·
          <a href={s.latest?.url ?? `${REPO}/releases`} target="_blank" rel="noreferrer" className="hover:text-fg">{tx('更新日志')}</a>·<span>{tx('MIT 开源')}</span>
        </div>
      </div>
      {s.available && s.canUpdate
        ? <Btn tone="ink" onClick={() => start.mutate()} disabled={start.isPending || running}><Download size={13} />{tx('立即更新')}</Btn>
        : <Btn onClick={() => check.mutate()} disabled={check.isPending || running}><RefreshCw size={13} className={check.isPending ? 'animate-spin' : ''} />{tx('检查更新')}</Btn>}
    </div>
    {(s.checkError || start.error || s.run?.state === 'failed' || (s.available && !s.canUpdate)) && <Foot>
      {s.checkError && <span className="block text-danger">{tx('检查失败：{0}', s.checkError)}</span>}
      {start.error && <span className="block text-danger">{(start.error as Error).message}</span>}
      {s.run?.state === 'failed' && !running && <span className="block text-danger">{tx('更新失败：{0}', s.run.error)}</span>}
      {s.available && !s.canUpdate && <span className="block">{s.hint}</span>}
    </Foot>}
    {(running || s.run?.state === 'failed') && s.run?.log && <pre className="max-h-48 overflow-y-auto rounded-2xl bg-sunken p-3 font-mono text-[11px] whitespace-pre-wrap text-muted">{s.run.log}</pre>}
    {prefs && <Section title={tx('更新')} foot={setPrefs.error ? <span className="text-danger">{(setPrefs.error as Error).message}</span> : !s.canUpdate ? s.hint : undefined}>
      <Row label={tx('自动检查更新')} sub={tx('每天看两次有没有新版')}><Toggle label={tx('自动检查更新')} checked={prefs.auto} onChange={auto => setPrefs.mutate({ auto })} /></Row>
      <Row label={tx('更新渠道')} sub={prefs.channel === 'beta' ? tx('测试版更早拿到新东西，也可能不太稳') : undefined}>
        <Choice label={tx('更新渠道')} value={prefs.channel} onChange={channel => setPrefs.mutate({ channel })} options={[{ id: 'stable', label: tx('正式版') }, { id: 'beta', label: tx('测试版') }]} />
      </Row>
      {s.canUpdate && <Row label={tx('自动下载并安装')} sub={tx('找到新版就装好，服务自己重启')}><Toggle label={tx('自动下载并安装')} checked={prefs.install} disabled={!prefs.auto} onChange={install => setPrefs.mutate({ install })} /></Row>}
    </Section>}
  </>
}

function Service({ health }: { health: Health }) {
  const access = useQuery({ queryKey: ['access'], queryFn: () => api.get<AccessStatus>('/system/access'), retry: false }).data
  const [restarting, setRestarting] = useState(false)
  const restart = useMutation({ mutationFn: () => api.post('/system/restart'), onSuccess: () => { setRestarting(true); setTimeout(() => location.reload(), 4000) } })
  return <Row label={tx('本机服务')} sub={restart.error ? <span className="text-danger">{(restart.error as Error).message}</span> : tx('{0} · pid {1} · 已运行 {2}', restarting ? tx('正在重启') : tx('运行中'), health.pid, uptime(health.uptimeMs))}>
    {access?.canRestart ? <Btn onClick={() => restart.mutate()} disabled={restart.isPending || restarting}><RefreshCw size={13} className={restarting ? 'animate-spin' : ''} />{tx('重启服务')}</Btn>
      : <span className="text-xs text-faint">{tx('重启：super-assistant restart')}</span>}
  </Row>
}

const SOURCE = { flag: tx('启动命令里的参数'), env: tx('环境变量'), file: '', default: '' } as const

/**
 * 谁能打开网页版: where the service listens and (desktop app) whether browsers may open it. Saved for the next start;
 * 重启服务 applies it now. On the network the login link is the password, so it is shown with the addresses to use.
 */
function Access() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['access'], queryFn: () => api.get<AccessStatus>('/system/access'), retry: false })
  const s = status.data
  const [form, setForm] = useState<{ web: boolean; mode: 'local' | 'lan' | 'custom'; host: string; port: string } | null>(null)
  useEffect(() => {
    if (!s || form) return
    const mode = s.saved.host === '127.0.0.1' ? 'local' : s.saved.host === '0.0.0.0' ? 'lan' : 'custom'
    setForm({ web: s.saved.web, mode, host: mode === 'custom' ? s.saved.host : '', port: String(s.saved.port) })
  }, [s])
  const save = useMutation({
    mutationFn: () => {
      const host = form!.mode === 'local' ? '127.0.0.1' : form!.mode === 'lan' ? '0.0.0.0' : form!.host.trim()
      return api.put<AccessStatus>('/system/access', { host, port: Number(form!.port), ...(s?.desktop ? { web: form!.web } : {}) })
    },
    onSuccess: data => qc.setQueryData(['access'], data),
  })
  const [restarting, setRestarting] = useState(false)
  const restart = useMutation({
    mutationFn: () => api.post('/system/restart'),
    onSuccess: () => {
      setRestarting(true)
      const target = s!.saved
      const host = target.host === '0.0.0.0' || target.host === '::' ? location.hostname : target.host
      const moved = String(target.port) !== location.port || (host !== location.hostname && !['127.0.0.1', 'localhost'].includes(host))
      const isDesktop = Boolean((window as { superAssistantDesktop?: unknown }).superAssistantDesktop)
      setTimeout(() => {
        if (moved && !isDesktop) location.href = `http://${host.includes(':') ? `[${host}]` : host}:${target.port}/`
        else location.reload()
      }, 4000)
    },
  })
  if (!s || !form) return null
  const host = form.mode === 'local' ? '127.0.0.1' : form.mode === 'lan' ? '0.0.0.0' : form.host.trim()
  const dirty = host !== s.saved.host || form.port !== String(s.saved.port) || (s.desktop && form.web !== s.saved.web)
  const overridden = (['host', 'port'] as const).filter(k => s.sources[k] === 'flag' || s.sources[k] === 'env')
  return <Section title={tx('谁能打开网页版')} foot={<>
    {form.mode !== 'local' && tx('选局域网时，同一网络的手机、电脑用登录链接就能打开；登录链接就是密码，别直接放到公网上（远程访问请用 HTTPS 反向代理或 SSH 隧道）。')}
    {overridden.length > 0 && <span className="block text-warn">{tx('{0}，这里存的值要去掉它之后才生效。', overridden.map(k => tx('{0}由{1}指定', k === 'host' ? tx('地址') : tx('端口'), SOURCE[s.sources[k]])).join('，'))}</span>}
    {(save.error || restart.error) && <span className="block text-danger">{((save.error ?? restart.error) as Error).message}</span>}
  </>}>
    {s.desktop && <Row label={tx('允许在浏览器里打开')} sub={tx('关掉时只有这个应用能用')}><Toggle label={tx('允许在浏览器里打开')} checked={form.web} onChange={web => setForm({ ...form, web })} /></Row>}
    {(!s.desktop || form.web) && <>
      <Row label={tx('访问')}>
        <Choice label={tx('访问')} value={form.mode} onChange={mode => setForm({ ...form, mode })} options={[{ id: 'local', label: tx('仅本机') }, { id: 'lan', label: tx('局域网') }, { id: 'custom', label: tx('指定 IP') }]} />
      </Row>
      {form.mode === 'custom' && <Row label={tx('IP 地址')}><TextInput className="font-mono" value={form.host} placeholder="192.168.1.20" onChange={e => setForm({ ...form, host: e.target.value })} /></Row>}
      <Row label={tx('端口')}><NumberInput value={form.port} onChange={e => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })} aria-label={tx('端口')} className="w-[90px] font-mono" /></Row>
    </>}
    {(dirty || s.restartNeeded) && <Row label={dirty ? tx('还没保存') : restarting ? tx('正在重启…') : tx('已保存，重启服务后生效')}>
      {dirty && <Btn tone="ink" onClick={() => save.mutate()} disabled={save.isPending || !form.port || (form.mode === 'custom' && !form.host.trim())}>{tx('保存')}</Btn>}
      {!dirty && s.restartNeeded && (s.canRestart ? <Btn onClick={() => restart.mutate()} disabled={restart.isPending || restarting}>{tx('重启服务')}</Btn> : <span className="text-xs text-faint">super-assistant restart</span>)}
    </Row>}
    {s.running.web && <>
      <LinkRow label={tx('本机')} url={s.localUrl} />
      {s.networkUrls.map(u => <LinkRow key={u} label={tx('局域网')} url={u} />)}
    </>}
  </Section>
}

function LinkRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false)
  return <Row label={tx('登录链接 · {0}', label)} sub={<span className="font-mono break-all">{url.replace(/token=.*/, 'token=••••••')}</span>}>
    <Btn onClick={async () => { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? <CheckIcon size={13} /> : <Copy size={13} />}{copied ? tx('已复制') : tx('复制')}</Btn>
  </Row>
}

/** 健康: the watchdog (with its own chat) and the environment check. */
function Healthy() {
  const doctor = useQuery({ queryKey: ['doctor'], queryFn: () => api.get<{ checks: Check[] }>('/doctor') })
  const run = useMutation({ mutationFn: () => api.post<{ findings: { kind: string; detail: string }[] }>('/watchdog/run') })
  const [all, setAll] = useState(false)
  const checks = doctor.data?.checks ?? []
  const ok = checks.filter(c => c.status === 'ok').length
  const notes = checks.filter(c => c.status !== 'ok')
  const open = async () => { const { conversationId } = await api.get<{ conversationId: string }>('/watchdog'); location.hash = `/c/${conversationId}` }
  return <Section title={tx('健康')}>
    <Row label={tx('看门狗')} sub={run.data ? (run.data.findings.length ? run.data.findings.map(f => `${f.kind}：${f.detail}`).join('；') : tx('这次没发现问题')) : tx('每分钟看一眼有没有卡住的任务、出错的来源，发现了会告诉你')}>
      <Btn onClick={() => run.mutate()} disabled={run.isPending}>{tx('立即巡检')}</Btn>
      <Btn onClick={open}>{tx('和它聊')}</Btn>
    </Row>
    <Row label={tx('环境检查')} sub={doctor.data ? tx('{0} 项正常{1}', ok, notes.length ? tx(' · {0} 项提醒：{1}', notes.length, notes.map(n => n.label).join('、')) : '') : tx('在检查…')}>
      <Btn onClick={() => setAll(v => !v)} disabled={!checks.length}>{all ? tx('收起') : tx('查看')}</Btn>
      <Btn onClick={() => doctor.refetch()} disabled={doctor.isFetching}><RefreshCw size={13} className={doctor.isFetching ? 'animate-spin' : ''} />{tx('重新检查')}</Btn>
    </Row>
    {all && checks.map(c => <Row key={c.id} label={<span className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${c.status === 'ok' ? 'bg-ok' : c.status === 'warn' ? 'bg-warn' : 'bg-danger'}`} />{c.label}</span>}
      sub={<>{c.detail}{c.status !== 'ok' && c.fix && <span className="block text-faint">{c.fix}</span>}</>} />)}
  </Section>
}
