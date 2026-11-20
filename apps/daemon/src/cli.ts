#!/usr/bin/env node
import { Command } from 'commander'
import { execFile, spawn } from 'node:child_process'
import { CHANNEL_PRESETS, scaffoldChannel } from '@nuonuo/sources'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { loadLocalAdminKey, LOCAL_ADMIN_HEADER, rotateLocalAdminKey } from './auth'
import { SCOPES, type Scope } from './auth-service'
import { connectHost, homeDir, isLoopback, loadEnvFile, networkUrls, resolveConfig, VERSION, writeSavedConfig, type SavedConfig } from './config'
import { runDoctor } from './doctor'
import { createRuntime, readLock, type LockInfo } from './runtime'
import { startDaemon } from './server'
import { adoptLegacyEnv, migrateLegacyHome } from './legacy'
import { installService, uninstallService } from './service'
import { runsAsService, Updater } from './update'
import { findDockerHost, widenPath } from './shell-env'

adoptLegacyEnv()
loadEnvFile(homeDir())
adoptLegacyEnv()
widenPath()

const program = new Command('nuonuo').version(VERSION).description('Nuonuo 服务端（统一 /v1 协议，默认纯 API 模式，加 --web 开启 WebUI）')
const entry = fileURLToPath(import.meta.url)

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
  execFile(cmd, args, () => {})
}

interface StartOpts { port?: number; host?: string; web?: boolean; open?: boolean; dev?: boolean; daemon?: boolean }

const parsePort = (v: string) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`无效的端口：${v}`)
  return n
}

async function health(home: string, lock: LockInfo) {
  const res = await fetch(`http://${connectHost(lock.host ?? '127.0.0.1')}:${lock.port}/v1/health`, {
    headers: { [LOCAL_ADMIN_HEADER]: loadLocalAdminKey(home) },
    signal: AbortSignal.timeout(3_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as { version: string; webUi: boolean; uptimeMs: number; effects?: { kind: string; failing: number }[] }
}

function printEndpoints(lock: LockInfo) {
  const host = lock.host ?? '127.0.0.1'
  const local = `http://${connectHost(host)}:${lock.port}`
  console.log(`  API 地址  ${local}/v1`)
  if (lock.web) console.log(`  Web UI    ${local}`)
  else console.log('  Web UI    未开启（使用 nuonuo start --web 或 NUONUO_WEB=1 开启）')
  for (const url of networkUrls(host, lock.port)) console.log(`  局域网    ${url}/v1`)
  console.log('  接入客户端 运行 nuonuo pair --admin --qr 生成一次性配对码与二维码')
}

function warnIfOpen(host: string) {
  if (isLoopback(host)) return
  console.log(`  注意      服务监听在 ${host}，请勿在公网明文暴露端口；公网访问请置于 HTTPS 反向代理或 Tailscale 之后`)
}

async function startInBackground(opts: StartOpts) {
  migrateLegacyHome()
  const config = resolveConfig({
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.web !== undefined ? { web: opts.web } : {}),
    ...(opts.dev ? { dev: true } : {}),
  })
  const running = readLock(config.home)
  if (running) {
    console.log(`已在运行（pid ${running.pid}，端口 ${running.port}）`)
    printEndpoints(running)
    return
  }
  mkdirSync(join(config.home, 'logs'), { recursive: true })
  const logFile = join(config.home, 'logs', 'daemon.log')
  const out = openSync(logFile, 'a')
  const args = [
    'start',
    '--no-open',
    ...(opts.host ? ['--host', opts.host] : []),
    ...(opts.port !== undefined ? ['--port', String(opts.port)] : []),
    ...(opts.web === true ? ['--web'] : opts.web === false ? ['--no-web'] : []),
    ...(opts.dev ? ['--dev'] : []),
  ]
  const child = spawn(process.execPath, [...process.execArgv, entry, ...args], { detached: true, stdio: ['ignore', out, out], windowsHide: true })
  child.unref()
  closeSync(out)
  let exited: number | null = null
  child.on('exit', code => { exited = code ?? 1 })
  for (let i = 0; i < 120 && exited === null; i++) {
    await new Promise(r => setTimeout(r, 250))
    const lock = readLock(config.home)
    if (!lock || lock.pid !== child.pid) continue
    try { await health(config.home, lock) } catch { continue }
    console.log(`Nuonuo ${VERSION} 已在后台启动（pid ${lock.pid}）`)
    printEndpoints(lock)
    warnIfOpen(lock.host ?? '127.0.0.1')
    console.log(`  日志      ${logFile}`)
    console.log('  停止      nuonuo stop')
    process.exit(0)
  }
  console.error(`后台服务没有启动起来，请查看 ${logFile}`)
  process.exit(1)
}

program.command('start').description('启动服务（默认纯 API 模式，监听 127.0.0.1:7420；加 --web 开启 WebUI；-d 后台运行）')
  .option('-H, --host <ip>', '监听地址：127.0.0.1 仅本机，0.0.0.0 所有网卡')
  .option('-p, --port <port>', '端口（默认 7420）', parsePort)
  .option('--web', '开启服务端内置 WebUI 页面（默认关闭，也可用 NUONUO_WEB=1）')
  .option('--no-web', '强制关闭服务端 WebUI 页面')
  .option('-d, --daemon', '在后台运行（输出写到数据目录的 logs/daemon.log），用 nuonuo stop 停止')
  .option('--open', '开启 --web 时自动打开浏览器')
  .option('--no-open', '不自动打开浏览器')
  .option('--dev', '开发模式')
  .action(async (opts: StartOpts) => {
    const move = migrateLegacyHome()
    if (move.moved) console.log(`数据目录已从 ${move.from} 移到 ${move.to}`)
    else if (move.reason) console.warn(move.reason)
    if (opts.daemon) return startInBackground(opts)
    const config = resolveConfig({
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.web !== undefined ? { web: opts.web } : {}),
      ...(opts.dev ? { dev: true } : {}),
    })
    let stopping = false
    let child: ReturnType<typeof spawn> | undefined
    const launch = () => {
      if (child) return
      const args = process.argv.slice(2)
      child = spawn(process.execPath, [...process.execArgv, entry, ...args, ...(args.includes('--no-open') ? [] : ['--no-open'])], { stdio: 'inherit', windowsHide: true })
      process.removeAllListeners('SIGINT').on('SIGINT', () => {})
      process.removeAllListeners('SIGTERM').on('SIGTERM', () => child?.kill('SIGTERM'))
      child.on('error', error => { console.error(`无法重新启动：${error.message}`); process.exit(1) })
      child.on('exit', code => process.exit(code ?? 0))
    }
    const restart = async () => {
      if (stopping) return
      stopping = true
      console.log('正在重启…')
      if (runsAsService()) {
        try { await started.stop() } catch (error) { console.error(error instanceof Error ? error.message : error) }
        process.exit(75)
      }
      const deadline = setTimeout(() => { console.error('停止超时，直接重新启动'); launch() }, 8_000)
      try { await started.stop() } catch (error) { console.error(error instanceof Error ? error.message : error) } finally { clearTimeout(deadline) }
      launch()
    }
    const started = await startDaemon(config, { restart: () => { void restart() } })
    void findDockerHost().then(host => { if (host) console.log(`Docker：使用 ${host}`) })
    console.log(`Nuonuo ${VERSION} 已启动`)
    console.log(`  数据目录  ${config.home}`)
    console.log(`  密钥存储  ${started.runtime.secrets.backend}${started.runtime.secretsNote ? `（${started.runtime.secretsNote}）` : ''}`)
    console.log(`  API 地址  ${started.url}/v1`)
    if (config.web) console.log(`  Web UI    ${started.url}`)
    else console.log('  Web UI    未开启（使用 nuonuo start --web 或 NUONUO_WEB=1 开启）')
    for (const url of started.networkUrls) console.log(`  局域网    ${url}/v1`)
    console.log('  接入客户端 运行 nuonuo pair --admin --qr 生成配对码与二维码')
    warnIfOpen(config.host)
    if (opts.open && config.web && !config.dev) openBrowser(started.url)
    const stop = async (signal: NodeJS.Signals) => {
      if (stopping) { console.error(`\n再次收到 ${signal}，强制退出`); process.exit(130) }
      stopping = true
      console.log('正在停止…')
      const deadline = setTimeout(() => { console.error('停止超时，强制退出'); process.exit(1) }, 15_000)
      deadline.unref()
      try { await started.stop() } catch (error) { console.error(error instanceof Error ? error.message : error) }
      clearTimeout(deadline)
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })

async function stopRunning(home: string): Promise<boolean> {
  const lock = readLock(home)
  if (!lock) return false
  process.kill(lock.pid, 'SIGTERM')
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (!readLock(home)) return true
  }
  throw new Error(`进程 ${lock.pid} 没有在 20 秒内停止`)
}

program.command('stop').description('停止运行中的服务').action(async () => {
  const config = resolveConfig()
  const lock = readLock(config.home)
  if (lock && runsAsService({}, `/proc/${lock.pid}/cgroup`)) {
    console.log('服务由 systemd 管理：用 systemctl --user stop nuonuo 停止')
  }
  console.log(await stopRunning(config.home) ? '已停止' : '未运行')
})

program.command('restart').description('重启服务（在后台运行）')
  .option('-H, --host <ip>', '这次使用的监听地址')
  .option('-p, --port <port>', '这次使用的端口', parsePort)
  .option('--web', '开启 WebUI')
  .option('--no-web', '关闭 WebUI')
  .action(async (opts: { host?: string; port?: number; web?: boolean }) => {
    const config = resolveConfig()
    if (await stopRunning(config.home)) console.log('已停止')
    await startInBackground({ ...opts, open: false })
  })

program.command('config').description('查看或保存监听地址、端口与 WebUI 开关（保存至 config.json，下次启动生效）')
  .option('-H, --host <ip>', '监听地址：127.0.0.1 仅本机，0.0.0.0 所有网卡')
  .option('-p, --port <port>', '端口', parsePort)
  .option('--web <on|off>', '是否默认开启服务端 WebUI（默认关闭）')
  .action((opts: { host?: string; port?: number; web?: string }) => {
    const config = resolveConfig()
    const patch: SavedConfig = {}
    if (opts.host !== undefined) patch.host = opts.host
    if (opts.port !== undefined) patch.port = opts.port
    if (opts.web !== undefined) patch.web = /^(on|true|1|yes)$/i.test(opts.web)
    if (Object.keys(patch).length) {
      writeSavedConfig(config.home, patch)
      console.log(`已保存到 ${join(config.home, 'config.json')}；重启服务后生效（nuonuo restart）`)
    }
    const next = resolveConfig()
    const from = { flag: '命令行', env: '环境变量', file: 'config.json', default: '默认' } as const
    console.log(`监听地址  ${next.host}（${from[next.sources.host]}）`)
    console.log(`端口      ${next.port}（${from[next.sources.port]}）`)
    console.log(`Web UI    ${next.web ? '开启' : '关闭'}（${from[next.sources.web]}）`)
  })

program.command('status').description('查看服务是否在运行').action(async () => {
  const config = resolveConfig()
  const lock = readLock(config.home)
  if (!lock) { console.log('未运行'); process.exitCode = 1; return }
  try {
    const h = await health(config.home, lock)
    const failing = (h.effects ?? []).filter(e => e.failing > 0)
    console.log(`运行中  pid ${lock.pid}  地址 ${lock.host ?? '127.0.0.1'}:${lock.port}  WebUI ${h.webUi ? '开启' : '关闭'}  版本 ${h.version}  已运行 ${Math.round(h.uptimeMs / 60000)} 分钟`)
    if (failing.length) { console.log(`后台队列异常：${failing.map(f => f.kind).join(', ')}`); process.exitCode = 2 }
  } catch (error) {
    console.log(`进程 ${lock.pid} 存在，但 API 无响应：${(error as Error).message}`)
    process.exitCode = 2
  }
})

program.command('doctor').description('检查运行环境').action(async () => {
  const config = resolveConfig()
  const rt = await createRuntime(config, { lock: false })
  try {
    const icon = { ok: '✓', warn: '!', error: '✗' } as const
    const width = (t: string) => [...t].reduce((n, ch) => n + (/[\u1100-\uffff]/.test(ch) ? 2 : 1), 0)
    const pad = (t: string, n: number) => t + ' '.repeat(Math.max(1, n - width(t)))
    for (const check of await runDoctor(rt)) {
      console.log(`${icon[check.status]} ${pad(check.label, 14)}${check.detail}${check.status !== 'ok' && check.fix ? `\n    → ${check.fix}` : ''}`)
    }
  } finally { await rt.close() }
})

/** Calls the running local service using the loopback-only `<home>/local-admin.key`. */
async function localAdminApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = resolveConfig()
  const lock = readLock(config.home)
  if (!lock) throw new Error('服务没有在运行：先运行 nuonuo start -d')
  const res = await fetch(`http://${connectHost(lock.host ?? '127.0.0.1')}:${lock.port}/v1${path}`, {
    ...init,
    headers: { [LOCAL_ADMIN_HEADER]: loadLocalAdminKey(config.home), 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json() as T & { error?: { message: string } }
  if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`)
  return data
}

const KIND_NAMES: Record<string, string> = {
  phone: '手机', tablet: '平板', watch: '手表', speaker: '音箱', car: '车机', tv: '电视', glasses: '眼镜', desktop: '桌面端', web: '浏览器', cli: 'CLI', bot: '机器人', other: '设备',
}

program.command('pair').description('生成一次性配对码与二维码，让桌面端、Web、手机或任意第三方客户端安全接入')
  .option('--admin', '授予完整管理权限（桌面端 / Web 管理端必选）')
  .option('--name <name>', '给设备起名（默认用设备自己报的名字）')
  .option('--approvals', '允许这个设备回答「要不要做」的确认')
  .option('--tasks', '允许这个设备查看和操作任务、记忆、目标与动态')
  .option('--scopes <list>', `自定义逗号分隔权限：${SCOPES.join(',')}`)
  .option('--server <url>', '覆盖写入二维码中的外部服务地址（如 https://nuonuo.example.com）')
  .option('--no-notices', '不给这个设备推送通知')
  .option('--qr', '在终端打印可扫描的二维码', true)
  .option('--no-qr', '不打印二维码')
  .option('--json', '以 JSON 输出（供脚本与桌面端自动配对使用）')
  .action(async (opts: { admin?: boolean; name?: string; approvals?: boolean; tasks?: boolean; scopes?: string; server?: string; notices: boolean; qr?: boolean; json?: boolean }) => {
    try {
      const scopes: Scope[] = opts.scopes
        ? (opts.scopes.split(',').map(s => s.trim()).filter(Boolean) as Scope[])
        : [
            'chat',
            ...(opts.notices ? ['notices' as const] : []),
            ...(opts.approvals ? ['approvals' as const] : []),
            ...(opts.tasks ? ['tasks:read' as const, 'tasks:write' as const] : []),
            ...(opts.admin ? ['admin' as const] : []),
          ]
      const r = await localAdminApi<{ code: string; expiresAt: number; scopes: string[]; uri: string; urls: string[]; base: string; reachable: boolean }>('/auth/pair/codes', {
        method: 'POST',
        body: JSON.stringify({
          scopes,
          ...(opts.admin ? { admin: true } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.server ? { serverUrl: opts.server } : {}),
        }),
      })
      if (opts.json) {
        console.log(JSON.stringify(r))
        return
      }
      console.log(`  配对码    ${r.code}   （10 分钟内有效，仅可使用一次）`)
      console.log(`  权限      ${r.scopes.join(', ')}`)
      console.log(`  连接串    ${r.uri}`)
      for (const url of r.urls) console.log(`  服务地址  ${url}`)
      if (opts.qr !== false) {
        const ascii = await QRCode.toString(r.uri, { type: 'terminal', small: true })
        console.log(`\n${ascii}`)
      }
      if (!r.reachable) console.log('  提示      服务当前仅监听本机 127.0.0.1；跨设备接入请运行 nuonuo config --host 0.0.0.0 并重启（公网请配 HTTPS 反代）')
    } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
  })

const authCmd = program.command('auth').description('管理服务端认证方式（密码、本地管理密钥、状态）')
authCmd.command('status').description('查看当前认证配置状态').action(async () => {
  try {
    const s = await localAdminApi<{ hasPassword: boolean; passkeyCount: number; activeDevices: number; activeSessions: number }>('/auth/status')
    console.log(`  密码登录  ${s.hasPassword ? '已开启' : '未设置（可用 nuonuo auth set-password 设置）'}`)
    console.log(`  Passkey   ${s.passkeyCount} 把`)
    console.log(`  已连设备  ${s.activeDevices} 台`)
    console.log(`  活跃会话  ${s.activeSessions} 个`)
  } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
})
authCmd.command('set-password <password>').description('设置或修改 Owner 登录密码（至少 8 位）').action(async (password: string) => {
  try {
    const config = resolveConfig()
    if (readLock(config.home)) {
      await localAdminApi('/auth/password', { method: 'POST', body: JSON.stringify({ password }) })
    } else {
      const rt = await createRuntime(config, { lock: false })
      try { rt.auth.setPassword(password) } finally { await rt.close() }
    }
    console.log('Owner 密码已更新（scrypt 哈希存储）')
  } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
})
authCmd.command('clear-password').description('关闭密码登录（仅保留配对码与 Passkey）').action(async () => {
  try {
    const config = resolveConfig()
    if (readLock(config.home)) {
      await localAdminApi('/auth/password', { method: 'DELETE' })
    } else {
      const rt = await createRuntime(config, { lock: false })
      try { rt.auth.clearPassword() } finally { await rt.close() }
    }
    console.log('已关闭密码登录')
  } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
})
authCmd.command('rotate-local-key').description('轮换本机 CLI 通信密钥（重启服务后生效）').action(() => {
  const config = resolveConfig()
  rotateLocalAdminKey(config.home)
  console.log('已轮换本机 local-admin.key；如服务正在运行，请运行 nuonuo restart 使新密钥生效')
})

const devicesCmd = program.command('devices').description('查看或吊销已认证客户端设备')
devicesCmd.command('list', { isDefault: true }).description('列出已认证设备').action(async () => {
  try {
    const { devices } = await localAdminApi<{ devices: { id: string; name: string; kind: string; scopes: string[]; lastSeenAt: number | null }[] }>('/devices')
    if (!devices.length) { console.log('还没有已连接设备。运行 nuonuo pair --admin --qr 生成配对码。'); return }
    for (const d of devices) console.log(`  ${d.id}  ${d.name}（${KIND_NAMES[d.kind] ?? d.kind}）  ${d.scopes.join(',')}  ${d.lastSeenAt ? `上次在线 ${new Date(d.lastSeenAt).toLocaleString()}` : ''}`)
  } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
})
devicesCmd.command('revoke <id>').description('吊销一个设备（其所有访问/刷新令牌立即失效）').action(async (id: string) => {
  try { await localAdminApi(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); console.log('已吊销') } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
})

const sessionsCmd = program.command('sessions').description('查看或踢下线活跃会话')
sessionsCmd.command('list', { isDefault: true }).description('列出活跃会话').action(async () => {
  try {
    const { sessions } = await localAdminApi<{ sessions: { id: string; deviceId: string; deviceName?: string; ip: string | null; rotatedAt: number | null; createdAt: number }[] }>('/sessions')
    if (!sessions.length) { console.log('当前没有活跃会话。'); return }
    for (const s of sessions) console.log(`  ${s.id}  ${s.deviceName ?? s.deviceId}  IP=${s.ip ?? '-'}  创建=${new Date(s.createdAt).toLocaleString()}`)
  } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
})
sessionsCmd.command('revoke <id>').description('立即吊销一个会话').action(async (id: string) => {
  try { await localAdminApi(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); console.log('会话已踢下线') } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
})

const channelCmd = program.command('channel').description('写新的聊天软件接入（Channel 适配器）')
channelCmd.command('new <name>').description('按软件 API 的能力生成适配器骨架（一个插件文件夹）')
  .option('--preset <preset>', `能力预设：${Object.keys(CHANNEL_PRESETS).join(' / ')}`, 'websocket')
  .option('--title <title>', '显示名（默认取预设的名字）')
  .option('--dir <dir>', '写到哪个文件夹（默认 ./<name>）')
  .action((name: string, opts: { preset: string; title?: string; dir?: string }) => {
    const files = scaffoldChannel({ name, preset: opts.preset, ...(opts.title ? { title: opts.title } : {}) })
    const dir = resolve(opts.dir ?? name)
    if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} 已经有文件了，换个名字或用 --dir 指定空文件夹`)
    mkdirSync(dir, { recursive: true })
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
    console.log(`已生成 ${dir}`)
    for (const path of Object.keys(files)) console.log(`  ${path}`)
  })
channelCmd.command('presets').description('列出能力预设').action(() => {
  for (const [id, p] of Object.entries(CHANNEL_PRESETS)) console.log(`  ${id.padEnd(12)} ${p.summary}`)
})

program.command('update').description('检查并安装新版本（Linux 安装包）')
  .option('--check', '只检查，不安装')
  .action(async (opts: { check?: boolean }) => {
    const config = resolveConfig()
    const updater = new Updater({ home: config.home, entry })
    const status = await updater.check()
    if (status.checkError) { console.error(`检查更新失败：${status.checkError}`); process.exitCode = 1; return }
    const latest = status.latest!
    if (!status.available) {
      console.log(latest.hasPackage || latest.version === VERSION ? `已是最新版本 ${VERSION}` : `最新发布 ${latest.tag} 还没有 Linux 安装包；当前 ${VERSION}`)
      return
    }
    console.log(`有新版本：${VERSION} → ${latest.tag}  ${latest.url}`)
    if (opts.check) return
    if (!status.canUpdate) { console.log(status.hint); process.exitCode = 1; return }
    const { script, env } = await updater.prepare()
    const child = spawn('bash', ['-s'], { stdio: ['pipe', 'inherit', 'inherit'], env })
    child.stdin.end(script)
    const code = await new Promise<number>(done => child.on('exit', c => done(c ?? 1)))
    if (code !== 0) { console.error('更新失败'); process.exitCode = code; return }
    const lock = readLock(config.home)
    if (lock && !runsAsService({}, `/proc/${lock.pid}/cgroup`)) console.log('提示：如果服务在终端里运行（不是 systemd 服务），请重启它以使用新版本')
  })

const service = program.command('service').description('开机自启（macOS launchd / Linux systemd 用户服务）')
service.command('install').option('--dry-run', '只打印将写入的文件').action((opts: { dryRun?: boolean }) => {
  console.log(installService(entry, resolveConfig().home, Boolean(opts.dryRun)))
})
service.command('uninstall').action(() => console.log(uninstallService(entry, resolveConfig().home)))

program.parseAsync().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
