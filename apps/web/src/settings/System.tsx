/**
 * 系统和更新 (Figma 21 · 16): the version and updates (check by itself, channel, install by itself), the background
 * service, who may open the web version, and health (the watchdog and the environment check).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check as CheckIcon, Copy, Download, Fingerprint, KeyRound, LogOut, QrCode, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type AccessStatus, type Check, type Health, type UpdatePrefs, type UpdateStatus } from '../api'
import { disconnectCurrent, isPasskeyBrowserSupported, openConnectionCenter, registerPasskey, useConnection } from '../connection'
import { BRAND, Mascot } from '../persona'
import { Btn, Choice, Foot, NumberInput, Page, Row, Section, TextInput, Toggle } from './kit'
import { tx } from '../i18n'
import { desktop } from '../shell'

const REPO = 'https://github.com/cyDione/nuonuo'
const uptime = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? tx('{0} 分钟', m) : m < 1440 ? tx('{0} 小时', Math.floor(m / 60)) : tx('{0} 天', Math.floor(m / 1440)) }

export function System() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health') }).data
  return <Page title={tx('系统和更新')}>
    <ConnectionCard />
    <Updates />
    {health && <Section title={tx('服务')}>
      <Service health={health} />
      {health.secrets && <Row label={tx('密钥存储')}><span className="text-[13px] text-muted">{health.secrets === 'keychain' ? tx('系统钥匙串') : tx('加密文件')}</span></Row>}
    </Section>}
    <AuthSecuritySection />
    <Access />
    <Healthy />
  </Page>
}

function ConnectionCard() {
  const conn = useConnection()
  const active = conn.profiles.find(p => p.id === conn.activeProfileId)
  return <Section title={tx('当前连接')}>
    <Row label={active?.name || tx('当前服务')} sub={<span className="font-mono">{conn.baseUrl || location.origin}</span>}>
      <Btn onClick={openConnectionCenter}><Server size={13} />{tx('切换服务')}</Btn>
      <Btn onClick={() => void disconnectCurrent(true)}><LogOut size={13} />{tx('退出登录')}</Btn>
    </Row>
  </Section>
}

function AuthSecuritySection() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api.get<{ hasPassword: boolean; passkeyCount: number; activeDevices: number; activeSessions: number }>('/auth/status'), retry: false }).data
  const devices = useQuery({ queryKey: ['auth-devices'], queryFn: () => api.get<{ devices: { id: string; name: string; kind: string; scopes: string[]; lastSeenAt: number | null }[] }>('/devices'), retry: false }).data?.devices ?? []
  const passkeys = useQuery({ queryKey: ['auth-passkeys'], queryFn: () => api.get<{ passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[] }>('/auth/passkeys'), retry: false }).data?.passkeys ?? []

  const [pairAdmin, setPairAdmin] = useState(true)
  const [pairName, setPairName] = useState('')
  const [pairResult, setPairResult] = useState<{ code: string; uri: string; qrSvg: string; expiresAt: number } | null>(null)
  const [copiedUri, setCopiedUri] = useState(false)
  const makePair = useMutation({
    mutationFn: () => api.post<{ code: string; uri: string; qrSvg: string; expiresAt: number }>('/auth/pair/codes', {
      admin: pairAdmin,
      ...(!pairAdmin ? { scopes: ['chat', 'notices', 'approvals'] } : {}),
      ...(pairName.trim() ? { name: pairName.trim() } : {}),
    }),
    onSuccess: data => setPairResult(data),
  })

  const [pw, setPw] = useState('')
  const [curPw, setCurPw] = useState('')
  const [pwMsg, setPwMsg] = useState<string | null>(null)
  const savePw = useMutation({
    mutationFn: () => api.post('/auth/password', { password: pw, ...(status?.hasPassword ? { currentPassword: curPw } : {}) }),
    onSuccess: () => { setPw(''); setCurPw(''); setPwMsg(tx('密码已保存')); void qc.invalidateQueries({ queryKey: ['auth-status'] }) },
  })
  const clearPw = useMutation({
    mutationFn: () => api.del('/auth/password'),
    onSuccess: () => { setPwMsg(tx('已关闭密码登录')); void qc.invalidateQueries({ queryKey: ['auth-status'] }) },
  })

  const [pkName, setPkName] = useState('')
  const [pkErr, setPkErr] = useState<string | null>(null)
  const addPasskey = async () => {
    setPkErr(null)
    try {
      await registerPasskey(pkName.trim() || tx('我的 Passkey'))
      setPkName('')
      void qc.invalidateQueries({ queryKey: ['auth-passkeys'] })
      void qc.invalidateQueries({ queryKey: ['auth-status'] })
    } catch (e) {
      setPkErr((e as Error).message)
    }
  }
  const delPasskey = useMutation({
    mutationFn: (id: string) => api.del(`/auth/passkeys/${encodeURIComponent(id)}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['auth-passkeys'] }); void qc.invalidateQueries({ queryKey: ['auth-status'] }) },
  })
  const revokeDevice = useMutation({
    mutationFn: (id: string) => api.del(`/devices/${encodeURIComponent(id)}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['auth-devices'] }); void qc.invalidateQueries({ queryKey: ['auth-status'] }) },
  })

  return <>
    <Section title={tx('配对与二维码接入')} foot={makePair.error ? <span className="text-danger">{(makePair.error as Error).message}</span> : tx('配对码 10 分钟内有效且仅能使用一次；新设备扫码或粘贴连接串后即可安全换取独立轮换令牌。')}>
      <Row label={tx('权限级别')} sub={pairAdmin ? tx('完整管理权限（桌面端 / Web 管理端）') : tx('轻量设备权限（对话 + 通知 + 审批，不含系统设置）')}>
        <Choice label={tx('权限级别')} value={pairAdmin ? 'admin' : 'client'} onChange={v => setPairAdmin(v === 'admin')}
          options={[{ id: 'admin', label: tx('管理端') }, { id: 'client', label: tx('轻量设备') }]} />
      </Row>
      <Row label={tx('设备备注（可选）')}>
        <TextInput value={pairName} onChange={e => setPairName(e.target.value)} placeholder={tx('例如：iPad / 手机')} />
        <Btn tone="ink" onClick={() => makePair.mutate()} disabled={makePair.isPending}><QrCode size={13} />{tx('生成配对码')}</Btn>
      </Row>
      {pairResult && <div className="flex flex-col items-center gap-3 px-4 py-4 sm:flex-row sm:items-start">
        <div className="shrink-0 overflow-hidden rounded-2xl border border-line bg-white p-2" dangerouslySetInnerHTML={{ __html: pairResult.qrSvg }} />
        <div className="min-w-0 flex-1 space-y-2 text-center sm:text-left">
          <div className="font-mono text-2xl font-bold tracking-[0.18em]">{pairResult.code}</div>
          <p className="font-mono text-[11px] break-all text-muted">{pairResult.uri}</p>
          <div className="flex justify-center gap-2 sm:justify-start">
            <Btn onClick={async () => { await navigator.clipboard.writeText(pairResult.uri); setCopiedUri(true); setTimeout(() => setCopiedUri(false), 1500) }}>
              {copiedUri ? <CheckIcon size={13} /> : <Copy size={13} />}{copiedUri ? tx('已复制') : tx('复制连接串')}
            </Btn>
          </div>
        </div>
      </div>}
    </Section>

    <Section title={tx('密码与 Passkey 登录')} foot={savePw.error ? <span className="text-danger">{(savePw.error as Error).message}</span> : pkErr ? <span className="text-danger">{pkErr}</span> : pwMsg ?? undefined}>
      <div className="space-y-2.5 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">{tx('Owner 登录密码')}</div>
          <div className="mt-0.5 text-xs text-muted">{status?.hasPassword ? tx('已设置（scrypt 哈希存储，防爆破限速）') : tx('未设置，设置后可在公网浏览器用密码直接登录')}</div>
        </div>
        <form
          onSubmit={e => { e.preventDefault(); if (pw.length >= 8 && !savePw.isPending) savePw.mutate() }}
          className="flex flex-wrap items-center gap-2"
        >
          {status?.hasPassword && <TextInput id="nuonuo-current-password" name="current-password" autoComplete="current-password" type="password" value={curPw} onChange={e => setCurPw(e.target.value)} placeholder={tx('当前密码')} className="w-40" />}
          <TextInput id="nuonuo-new-password" name="new-password" autoComplete="new-password" type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder={tx('新密码（≥8位）')} className="w-44" />
          <Btn type="submit" tone="ink" disabled={pw.length < 8 || savePw.isPending}><KeyRound size={13} />{tx('保存')}</Btn>
          {status?.hasPassword && <Btn type="button" onClick={() => clearPw.mutate()} disabled={clearPw.isPending}>{tx('关闭')}</Btn>}
        </form>
      </div>
      <Row label="Passkey" sub={isPasskeyBrowserSupported() ? tx('使用指纹、面容或安全密钥无密码登录（需 HTTPS 或 localhost）') : tx('当前来源不支持 WebAuthn Passkey')}>
        <TextInput id="nuonuo-passkey-name" name="passkey-name" value={pkName} onChange={e => setPkName(e.target.value)} placeholder={tx('例如：Mac Touch ID')} className="w-36" />
        <Btn disabled={!isPasskeyBrowserSupported()} onClick={() => void addPasskey()}><Fingerprint size={13} />{tx('添加 Passkey')}</Btn>
      </Row>
      {passkeys.map(k => <Row key={k.id} label={k.name} sub={tx('绑定于 {0}', new Date(k.createdAt).toLocaleDateString())}>
        <Btn onClick={() => delPasskey.mutate(k.id)}><Trash2 size={13} />{tx('移除')}</Btn>
      </Row>)}
    </Section>

    <Section title={tx('已认证设备 ({0})', devices.length)}>
      {devices.length === 0 && <Row label={tx('暂无其他已认证设备')} />}
      {devices.map(d => <Row key={d.id} label={`${d.name} (${d.kind})`} sub={tx('权限：{0}{1}', d.scopes.join(', '), d.lastSeenAt ? tx(' · 上次活跃 {0}', new Date(d.lastSeenAt).toLocaleString()) : '')}>
        <Btn onClick={() => revokeDevice.mutate(d.id)} disabled={revokeDevice.isPending}><Trash2 size={13} />{tx('吊销')}</Btn>
      </Row>)}
    </Section>
  </>
}

/** The header card and 更新: checked by the service twice a day; a package install can update itself and restart. */
function Updates() {
  const qc = useQueryClient()
  const [updating, setUpdating] = useState<{ from: string; target: string } | null>(null)
  const [lost, setLost] = useState(false)
  // Desktop app: 立即更新 downloads in the background, then installs through the app (which quits and comes back).
  const [wantInstall, setWantInstall] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const status = useQuery({ queryKey: ['update'], queryFn: () => api.get<UpdateStatus>('/update'), retry: false,
    refetchInterval: q => (updating || q.state.data?.download?.state === 'downloading' ? 1500 : false) })
  const check = useMutation({ mutationFn: () => api.post<UpdateStatus>('/update/check'), onSuccess: data => qc.setQueryData(['update'], data) })
  const setPrefs = useMutation({ mutationFn: (patch: Partial<UpdatePrefs>) => api.put<UpdateStatus>('/update/settings', patch), onSuccess: data => qc.setQueryData(['update'], data) })
  const start = useMutation({
    mutationFn: () => api.post<UpdateStatus>('/update'),
    onSuccess: data => {
      qc.setQueryData(['update'], data)
      if (data.install === 'desktop') { setWantInstall(true); return }
      setLost(false); setUpdating({ from: data.current, target: data.run?.target ?? '' })
    },
  })
  const s = status.data
  const installApp = async () => {
    setInstallError(null)
    const result = await desktop?.update?.install().catch((error: Error) => error.message)
    if (result && result !== 'ok') setInstallError(result)
  }
  const dl = s?.install === 'desktop' && s.available ? s.download : null
  useEffect(() => {
    if (!wantInstall || !dl || dl.state === 'downloading') return
    setWantInstall(false)
    if (dl.state === 'ready') void installApp()
  }, [wantInstall, dl?.state])
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
  const pct = dl?.size ? Math.min(99, Math.floor(dl.received / dl.size * 100)) : 0
  const state = dl?.state === 'downloading' ? tx('正在下载 {0}… {1}%', dl.tag, pct)
    : dl?.state === 'ready' ? (s.prefs?.install ? tx('{0} 已下载好，退出时自动安装', dl.tag) : tx('{0} 已下载好', dl.tag))
    : running ? (stuck ? (lost ? tx('服务没有回来：在终端运行 nuonuo start 看看') : tx('装好了，但服务没有重启：请手动重启')) : lost ? tx('正在重启服务…') : tx('正在安装 {0}…', updating?.target || s.run?.target))
    : s.checkError ? tx('检查失败') : s.available ? tx('{0} 可以更新了', s.latest?.tag) : s.latest ? tx('已是最新') : tx('还没检查过')
  const prefs = s.prefs
  return <>
    <div className="flex items-center gap-4 rounded-2xl bg-sunken px-5 py-4">
      <Mascot color={BRAND} size={48} />
      <div className="min-w-0 flex-1">
        <div className="text-[17px] font-semibold">nuonuo</div>
        <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted">
          <span>v{s.current.replace(/^v/, '')}</span>·<span className={s.available ? 'text-accent' : s.checkError ? 'text-danger' : ''}>{state}</span>·
          <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-fg">GitHub</a>·
          <a href={s.latest?.url ?? `${REPO}/releases`} target="_blank" rel="noreferrer" className="hover:text-fg">{tx('更新日志')}</a>·<span>{tx('MIT 开源')}</span>
        </div>
      </div>
      {dl?.state === 'ready' && desktop?.update
        ? <Btn tone="ink" onClick={() => void installApp()}><Download size={13} />{tx('重启并更新')}</Btn>
        : s.available && s.canUpdate
        ? <Btn tone="ink" onClick={() => start.mutate()} disabled={start.isPending || running || dl?.state === 'downloading'}><Download size={13} />{tx('立即更新')}</Btn>
        : <Btn onClick={() => check.mutate()} disabled={check.isPending || running}><RefreshCw size={13} className={check.isPending ? 'animate-spin' : ''} />{tx('检查更新')}</Btn>}
    </div>
    {(s.checkError || start.error || installError || dl?.state === 'failed' || s.run?.state === 'failed' || (s.available && !s.canUpdate)) && <Foot>
      {s.checkError && <span className="block text-danger">{tx('检查失败：{0}', s.checkError)}</span>}
      {start.error && <span className="block text-danger">{(start.error as Error).message}</span>}
      {installError && <span className="block text-danger">{tx('没能自动安装：{0}', installError)}</span>}
      {dl?.state === 'failed' && <span className="block text-danger">{tx('下载失败：{0}', dl.error)}</span>}
      {s.run?.state === 'failed' && !running && <span className="block text-danger">{tx('更新失败：{0}', s.run.error)}</span>}
      {s.available && !s.canUpdate && <span className="block">{s.hint}</span>}
    </Foot>}
    {(running || s.run?.state === 'failed') && s.run?.log && <pre className="max-h-48 overflow-y-auto rounded-2xl bg-sunken p-3 font-mono text-[11px] whitespace-pre-wrap text-muted">{s.run.log}</pre>}
    {prefs && <Section title={tx('更新')} foot={setPrefs.error ? <span className="text-danger">{(setPrefs.error as Error).message}</span> : !s.canUpdate ? s.hint : undefined}>
      <Row label={tx('自动检查更新')} sub={tx('每天看两次有没有新版')}><Toggle label={tx('自动检查更新')} checked={prefs.auto} onChange={auto => setPrefs.mutate({ auto })} /></Row>
      <Row label={tx('更新渠道')} sub={prefs.channel === 'beta' ? tx('测试版更早拿到新东西，也可能不太稳') : undefined}>
        <Choice label={tx('更新渠道')} value={prefs.channel} onChange={channel => setPrefs.mutate({ channel })} options={[{ id: 'stable', label: tx('正式版') }, { id: 'beta', label: tx('测试版') }]} />
      </Row>
      {s.canUpdate && <Row label={tx('自动下载并安装')} sub={s.install === 'desktop' ? tx('在后台下载好，退出应用时装上') : tx('找到新版就装好，服务自己重启')}><Toggle label={tx('自动下载并安装')} checked={prefs.install} disabled={!prefs.auto} onChange={install => setPrefs.mutate({ install })} /></Row>}
    </Section>}
  </>
}

function Service({ health }: { health: Health }) {
  const access = useQuery({ queryKey: ['access'], queryFn: () => api.get<AccessStatus>('/system/access'), retry: false }).data
  const [restarting, setRestarting] = useState(false)
  const restart = useMutation({ mutationFn: () => api.post('/system/restart'), onSuccess: () => { setRestarting(true); setTimeout(() => location.reload(), 4000) } })
  return <Row label={tx('服务端进程')} sub={restart.error ? <span className="text-danger">{(restart.error as Error).message}</span> : tx('{0} · pid {1} · 已运行 {2}', restarting ? tx('正在重启') : tx('运行中'), health.pid ?? '-', uptime(health.uptimeMs))}>
    {access?.canRestart ? <Btn onClick={() => restart.mutate()} disabled={restart.isPending || restarting}><RefreshCw size={13} className={restarting ? 'animate-spin' : ''} />{tx('重启服务')}</Btn>
      : <span className="text-xs text-faint">{tx('重启：nuonuo restart')}</span>}
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
      return api.put<AccessStatus>('/system/access', { host, port: Number(form!.port), web: form!.web })
    },
    onSuccess: data => qc.setQueryData(['access'], data),
  })
  const [restarting, setRestarting] = useState(false)
  const restart = useMutation({
    mutationFn: () => api.post('/system/restart'),
    onSuccess: () => {
      setRestarting(true)
      setTimeout(() => location.reload(), 4000)
    },
  })
  if (!s || !form) return null
  const host = form.mode === 'local' ? '127.0.0.1' : form.mode === 'lan' ? '0.0.0.0' : form.host.trim()
  const dirty = host !== s.saved.host || form.port !== String(s.saved.port) || form.web !== s.saved.web
  const overridden = (['host', 'port', 'web'] as const).filter(k => s.sources[k] === 'flag' || s.sources[k] === 'env')
  return <Section title={tx('服务端网络与 WebUI')} foot={<>
    {tx('服务端默认以纯 API 模式运行；可通过 nuonuo start --web 或开启上方开关托管内置网页界面。公网访问请配合 HTTPS 反向代理或 Tailscale。')}
    {overridden.length > 0 && <span className="block text-warn">{tx('{0}，这里存的值要去掉它之后才生效。', overridden.map(k => tx('{0}由{1}指定', k === 'host' ? tx('地址') : k === 'port' ? tx('端口') : 'WebUI', SOURCE[s.sources[k]])).join('，'))}</span>}
    {(save.error || restart.error) && <span className="block text-danger">{((save.error ?? restart.error) as Error).message}</span>}
  </>}>
    <Row label={tx('开启服务端 WebUI')} sub={tx('关闭时仅提供 /v1 API（默认关闭）')}><Toggle label={tx('开启服务端 WebUI')} checked={form.web} onChange={web => setForm({ ...form, web })} /></Row>
    <Row label={tx('监听范围')}>
      <Choice label={tx('监听范围')} value={form.mode} onChange={mode => setForm({ ...form, mode })} options={[{ id: 'local', label: tx('仅本机') }, { id: 'lan', label: tx('局域网') }, { id: 'custom', label: tx('指定 IP') }]} />
    </Row>
    {form.mode === 'custom' && <Row label={tx('IP 地址')}><TextInput className="font-mono" value={form.host} placeholder="192.168.1.20" onChange={e => setForm({ ...form, host: e.target.value })} /></Row>}
    <Row label={tx('端口')}><NumberInput value={form.port} onChange={e => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })} aria-label={tx('端口')} className="w-[90px] font-mono" /></Row>
    {(dirty || s.restartNeeded) && <Row label={dirty ? tx('还没保存') : restarting ? tx('正在重启…') : tx('已保存，重启服务后生效')}>
      {dirty && <Btn tone="ink" onClick={() => save.mutate()} disabled={save.isPending || !form.port || (form.mode === 'custom' && !form.host.trim())}>{tx('保存')}</Btn>}
      {!dirty && s.restartNeeded && (s.canRestart ? <Btn onClick={() => restart.mutate()} disabled={restart.isPending || restarting}>{tx('重启服务')}</Btn> : <span className="text-xs text-faint">nuonuo restart</span>)}
    </Row>}
    <LinkRow label={tx('本机地址')} url={s.localUrl} />
    {s.networkUrls.map(u => <LinkRow key={u} label={tx('局域网地址')} url={u} />)}
  </Section>
}

function LinkRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false)
  return <Row label={label} sub={<span className="font-mono break-all">{url}</span>}>
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
