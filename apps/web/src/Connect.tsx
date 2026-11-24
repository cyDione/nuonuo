/**
 * Decoupled Connection & Auth Center:
 * - Connects to any Nuonuo server via one-time Pairing Code / QR (`nuonuo://pair?...`), Owner Password, or Passkey.
 * - Manages saved server profiles (encrypted via OS safeStorage on desktop).
 * - On desktop, provides one-click Local Deploy (native install script or Docker) with live log streaming + auto-pair.
 */
import { ArrowRight, CheckCircle2, Container, Fingerprint, KeyRound, Laptop, Lock, QrCode, RefreshCw, Server, ShieldAlert, Terminal, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  discoverServer,
  isHttpWebOrigin,
  isInsecureRemoteUrl,
  isPasskeyBrowserSupported,
  loginWithPairCode,
  loginWithPasskey,
  loginWithPassword,
  normalizeServerUrl,
  parsePairUri,
  removeSavedProfile,
  switchProfile,
  useConnection,
  type AuthMethodsResponse,
} from './connection'
import { tx } from './i18n'
import { BrandIcon } from './persona'
import { QrScanner } from './QrScanner'
import { desktop, type LocalDeployDetect } from './shell'
import { cx } from './ui'

type AuthTab = 'pair' | 'password' | 'passkey'

export function Connect() {
  const conn = useConnection()
  const sameOriginWeb = isHttpWebOrigin()
  const [serverInput, setServerInput] = useState(conn.pendingPairUri?.server || conn.baseUrl || (sameOriginWeb ? location.origin : 'http://127.0.0.1:7420'))
  const [pairCode, setPairCode] = useState(conn.pendingPairUri?.code || '')
  const [password, setPassword] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [tab, setTab] = useState<AuthTab>('pair')
  const [methods, setMethods] = useState<AuthMethodsResponse | null>(null)
  const [probing, setProbing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(conn.error)
  const [insecureOk, setInsecureOk] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [showDeploy, setShowDeploy] = useState(false)

  useEffect(() => {
    if (conn.pendingPairUri) {
      setServerInput(conn.pendingPairUri.server)
      setPairCode(conn.pendingPairUri.code)
      setTab('pair')
    }
  }, [conn.pendingPairUri])

  const normalizedUrl = normalizeServerUrl(serverInput)
  const insecureRemote = isInsecureRemoteUrl(normalizedUrl)

  const probe = async (url = normalizedUrl) => {
    if (!url) return
    setProbing(true)
    setError(null)
    try {
      const m = await discoverServer(url)
      setMethods(m)
      if (m.methods.passkey && isPasskeyBrowserSupported() && !pairCode) setTab('passkey')
      else if (m.methods.password && !pairCode && tab === 'passkey') setTab('password')
    } catch (e) {
      setMethods(null)
      setError(tx('无法探测服务端：{0}', (e as Error).message))
    } finally {
      setProbing(false)
    }
  }

  useEffect(() => {
    if (sameOriginWeb) void probe(location.origin)
  }, [])

  const applyScannedOrPasted = (raw: string) => {
    const parsed = parsePairUri(raw)
    if (parsed) {
      setServerInput(parsed.server)
      setPairCode(parsed.code)
      setTab('pair')
      setError(null)
      void probe(parsed.server)
      return true
    }
    if (/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(raw.trim())) {
      setPairCode(raw.trim().toUpperCase())
      setTab('pair')
      return true
    }
    return false
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!normalizedUrl) { setError(tx('请输入服务端地址')); return }
    if (insecureRemote && !insecureOk) { setError(tx('连接非本机明文 HTTP 服务存在窃听风险，请先勾选风险确认或改用 HTTPS。')); return }
    setBusy(true)
    setError(null)
    try {
      const opts = { ...(deviceName.trim() ? { deviceName: deviceName.trim() } : {}), insecureAllowed: insecureRemote }
      if (tab === 'pair') {
        if (!pairCode.trim()) throw new Error(tx('请输入一次性配对码'))
        await loginWithPairCode(normalizedUrl, pairCode, opts)
      } else if (tab === 'password') {
        if (!password) throw new Error(tx('请输入密码'))
        await loginWithPassword(normalizedUrl, password, opts)
      } else {
        await loginWithPasskey(normalizedUrl, opts)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="sky-stage relative flex min-h-dvh items-center justify-center overflow-y-auto p-5">
    <div className="dot-grid pointer-events-none fixed inset-0 opacity-60" aria-hidden />
    <div className="relative z-10 w-full max-w-lg space-y-4">
      <div className="ceramic-card anim-pop rounded-[28px] p-7">
        <div className="flex items-center gap-3.5">
          <BrandIcon size={52} className="drop-shadow-[0_6px_14px_rgba(159,18,57,0.22)]" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-xl font-semibold">{tx('连接 Nuonuo 服务')}</h1>
            <p className="text-xs text-muted">{tx('应用端与服务端已解绑 · 支持远程连接、扫码配对与本机部署')}</p>
          </div>
          <button type="button" onClick={() => setShowQr(true)} title={tx('扫码或识别二维码')}
            className="press flex h-9 items-center gap-1.5 rounded-xl border border-line bg-sunken px-3 text-xs font-medium hover:border-faint">
            <QrCode size={15} />{tx('扫码')}
          </button>
        </div>

        {/* Saved servers */}
        {conn.profiles.length > 0 && <div className="mt-5 space-y-1.5">
          <div className="text-[11px] font-medium text-faint">{tx('已保存的服务')}</div>
          <div className="space-y-1.5">
            {conn.profiles.map(p => <div key={p.id} className="flex items-center gap-2 rounded-2xl border border-line bg-sunken px-3.5 py-2.5">
              <Server size={15} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="truncate text-[11px] text-faint">{p.baseUrl || location.origin}</div>
              </div>
              <button type="button" onClick={() => void switchProfile(p.id)}
                className="press h-7 rounded-lg bg-ink px-2.5 text-xs font-medium text-ink-fg">{tx('连接')}</button>
              <button type="button" onClick={() => void removeSavedProfile(p.id)} aria-label={tx('移除')}
                className="press rounded-lg p-1.5 text-faint hover:bg-panel hover:text-danger"><Trash2 size={14} /></button>
            </div>)}
          </div>
        </div>}

        <form onSubmit={submit} className="mt-5 space-y-4">
          {/* Server URL / Pair URI input */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted">{tx('服务地址或 nuonuo://pair 连接串')}</label>
            <div className="flex gap-2">
              <input
                value={serverInput}
                onChange={e => {
                  const v = e.target.value
                  if (!applyScannedOrPasted(v)) { setServerInput(v); setInsecureOk(false) }
                }}
                placeholder="https://nuonuo.example.com"
                className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-sunken px-3 font-mono text-xs outline-none focus:border-accent"
              />
              <button type="button" onClick={() => void probe()} disabled={probing || !normalizedUrl}
                className="press flex h-10 shrink-0 items-center gap-1 rounded-xl border border-line bg-sunken px-3 text-xs font-medium hover:border-faint disabled:opacity-50">
                <RefreshCw size={13} className={probing ? 'animate-spin' : ''} />{tx('检测')}
              </button>
            </div>
            {methods && <div className="flex items-center gap-1.5 text-[11px] text-ok">
              <CheckCircle2 size={12} />
              <span>{tx('已连通 Nuonuo v{0}', methods.server.version)}</span>
              {methods.methods.password && <span>· {tx('支持密码')}</span>}
              {methods.methods.passkey && <span>· {tx('支持 Passkey')}</span>}
            </div>}
          </div>

          {/* Non-local HTTP security warning */}
          {insecureRemote && <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-warn/40 bg-warn-soft/50 p-3 text-xs">
            <input type="checkbox" checked={insecureOk} onChange={e => setInsecureOk(e.target.checked)} className="mt-0.5 accent-warn" />
            <span className="text-pretty text-fg">
              <strong className="inline-flex items-center gap-1 font-semibold text-warn"><ShieldAlert size={13} />{tx('非加密 HTTP 警告')}</strong>
              <span className="mt-0.5 block text-muted">{tx('当前目标是非本机 HTTP 地址，认证信息可能被同网络监听。生产环境请使用 HTTPS 或 Tailscale；我已知晓风险并继续。')}</span>
            </span>
          </label>}

          {/* Auth mode switcher */}
          <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-sunken p-1">
            {([
              ['pair', tx('配对码 / 扫码'), KeyRound],
              ['password', tx('密码登录'), Lock],
              ['passkey', 'Passkey', Fingerprint],
            ] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" onClick={() => { setTab(id); setError(null) }}
                className={cx('press flex h-8 items-center justify-center gap-1.5 rounded-xl text-xs font-medium transition-colors',
                  tab === id ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg')}>
                <Icon size={13} />{label}
              </button>
            ))}
          </div>

          {tab === 'pair' && <div className="space-y-2">
            <label className="block text-xs font-medium text-muted">{tx('一次性配对码（服务端运行 nuonuo pair --admin --qr 获取）')}</label>
            <input
              value={pairCode}
              onChange={e => {
                if (!applyScannedOrPasted(e.target.value)) setPairCode(e.target.value.toUpperCase())
              }}
              placeholder="XXXX-XXXX"
              autoComplete="one-time-code"
              className="h-11 w-full rounded-xl border border-line bg-sunken px-3.5 text-center font-mono text-base tracking-[0.2em] outline-none focus:border-accent"
            />
          </div>}

          {tab === 'password' && <div className="space-y-2">
            <label className="block text-xs font-medium text-muted">{tx('Owner 登录密码（服务端用 nuonuo auth set-password 设置）')}</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={tx('输入密码')}
              autoComplete="current-password"
              className="h-10 w-full rounded-xl border border-line bg-sunken px-3 text-sm outline-none focus:border-accent"
            />
          </div>}

          {tab === 'passkey' && <div className="rounded-2xl bg-sunken p-4 text-center text-xs text-muted">
            <Fingerprint size={26} className="mx-auto mb-2 text-accent" />
            {isPasskeyBrowserSupported()
              ? tx('使用系统指纹、面容或硬件安全密钥无密码登录（仅支持 HTTPS 或 localhost）。')
              : tx('当前环境不支持 WebAuthn Passkey，请使用配对码或密码登录。')}
          </div>}

          <div className="space-y-1">
            <label className="block text-[11px] text-faint">{tx('设备名称（可选，便于在服务端识别与吊销）')}</label>
            <input
              value={deviceName}
              onChange={e => setDeviceName(e.target.value)}
              placeholder={desktop ? tx('例如：我的 MacBook') : tx('例如：办公室 Chrome')}
              className="h-9 w-full rounded-xl border border-line bg-sunken px-3 text-xs outline-none focus:border-accent"
            />
          </div>

          {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

          <button type="submit" disabled={busy || (tab === 'passkey' && !isPasskeyBrowserSupported())}
            className="press flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-ink text-sm font-medium text-ink-fg hover:opacity-90 disabled:opacity-50">
            {busy ? <RefreshCw size={15} className="animate-spin" /> : <ArrowRight size={15} />}
            {tab === 'pair' ? tx('验证配对并连接') : tab === 'password' ? tx('密码登录') : tx('使用 Passkey 登录')}
          </button>
        </form>

        {/* Desktop-only Local Deploy entry */}
        {desktop?.deploy && <div className="mt-5 border-t border-line pt-4">
          <button type="button" onClick={() => setShowDeploy(v => !v)}
            className="press flex w-full items-center justify-between rounded-2xl bg-sunken px-4 py-3 text-left hover:bg-hero-2">
            <span className="flex items-center gap-2.5">
              <Laptop size={16} className="text-accent" />
              <span>
                <span className="block text-sm font-medium">{tx('还没有服务端？点击一键部署到本机')}</span>
                <span className="block text-[11px] text-faint">{tx('桌面端已轻量化，按需通过安装脚本或 Docker 部署本机服务')}</span>
              </span>
            </span>
            <ArrowRight size={14} className="text-muted" />
          </button>
          {showDeploy && <LocalDeployPanel />}
        </div>}
      </div>
    </div>
    {showQr && <QrScanner onClose={() => setShowQr(false)} onDetected={raw => { setShowQr(false); if (!applyScannedOrPasted(raw)) setError(tx('二维码不是有效的 Nuonuo 配对码')) }} />}
  </div>
}

function LocalDeployPanel() {
  const [info, setInfo] = useState<LocalDeployDetect | null>(null)
  const [enableWeb, setEnableWeb] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void desktop?.deploy?.detect().then(setInfo).catch(() => {})
    const off = desktop?.deploy?.onLog(line => setLogs(prev => [...prev.slice(-80), line]))
    return () => { off?.() }
  }, [])

  const runDeploy = async (mode: 'local' | 'docker') => {
    if (!desktop?.deploy) return
    setRunning(true)
    setErr(null)
    setLogs([])
    try {
      const res = mode === 'local'
        ? await desktop.deploy.startLocal({ web: enableWeb })
        : await desktop.deploy.startDocker({ web: enableWeb })
      if (!res.ok || !res.serverUrl || !res.pairCode) {
        throw new Error(res.error || tx('部署失败，请查看日志'))
      }
      await loginWithPairCode(res.serverUrl, res.pairCode, { profileName: mode === 'docker' ? tx('本机 Docker 服务') : tx('本机服务') })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return <div className="mt-3 space-y-3 rounded-2xl border border-line bg-sunken p-4">
    {info && <div className="flex flex-wrap gap-2 text-[11px] text-muted">
      <span>{info.daemonRunning ? tx('本机服务已运行 (:{0})', info.daemonRunning.port) : tx('本机服务未运行')}</span>
      <span>·</span>
      <span>{info.hasCli ? tx('已安装 CLI') : info.hasNode ? tx('Node {0}', info.nodeVersion ?? '') : tx('将自动安装运行环境')}</span>
      <span>·</span>
      <span>{info.dockerRunning ? tx('Docker 可用') : tx('Docker 未启动')}</span>
    </div>}

    <label className="flex cursor-pointer items-center gap-2 text-xs text-fg">
      <input type="checkbox" checked={enableWeb} onChange={e => setEnableWeb(e.target.checked)} className="accent-accent" />
      <span>{tx('同时开启服务端 WebUI（等价于 nuonuo start --web）')}</span>
    </label>

    <div className="grid grid-cols-2 gap-2">
      <button type="button" disabled={running} onClick={() => void runDeploy('local')}
        className="press flex h-10 items-center justify-center gap-1.5 rounded-xl bg-ink px-3 text-xs font-medium text-ink-fg disabled:opacity-50">
        <Terminal size={14} />{info?.daemonRunning ? tx('连接本机已有服务') : tx('本机安装并启动')}
      </button>
      <button type="button" disabled={running || !info?.dockerRunning} onClick={() => void runDeploy('docker')}
        className="press flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line bg-panel px-3 text-xs font-medium hover:border-faint disabled:opacity-40">
        <Container size={14} />{tx('Docker 一键部署')}
      </button>
    </div>

    {err && <p className="text-xs text-danger">{err}</p>}
    {logs.length > 0 && <pre className="max-h-40 overflow-y-auto rounded-xl bg-ink p-3 font-mono text-[11px] whitespace-pre-wrap text-ink-fg/90">{logs.join('\n')}</pre>}
  </div>
}
