#!/usr/bin/env node
import { Command, Option } from 'commander'
import { execFile, spawn } from 'node:child_process'
import { CHANNEL_PRESETS, scaffoldChannel } from '@nuonuo/sources'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadToken, rotateToken } from './auth'
import { connectHost, homeDir, isLoopback, loadEnvFile, networkUrls, readSavedConfig, resolveConfig, VERSION, writeSavedConfig, type SavedConfig } from './config'
import { runDoctor } from './doctor'
import { createRuntime, readLock, type LockInfo } from './runtime'
import { startDaemon } from './server'
import { adoptLegacyEnv, migrateLegacyHome } from './legacy'
import { installService, uninstallService } from './service'
import { runsAsService, Updater } from './update'
import { findDockerHost, widenPath } from './shell-env'

// Variables from before the rename (SUPER_ASSISTANT_*) still apply, from the environment and from <home>/env.
adoptLegacyEnv()
// Keys in <home>/env reach every command, including a service started at login.
loadEnvFile(homeDir())
adoptLegacyEnv()
// A GUI- or launchd-started service on macOS sees only /usr/bin:/bin: find Homebrew, Docker and the login shell's tools.
widenPath()

const program = new Command('nuonuo').version(VERSION).description('你的个人 Nuonuo（本机运行）')
const entry = fileURLToPath(import.meta.url)

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
  execFile(cmd, args, () => { /* no desktop: the printed link is enough */ })
}

interface StartOpts { port?: number; host?: string; open: boolean; dev?: boolean; daemon?: boolean; desktop?: boolean }

const parsePort = (v: string) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`无效的端口：${v}`)
  return n
}

/** Health of the service a lock file describes, reached the way this machine can reach it. */
async function health(home: string, lock: LockInfo) {
  const res = await fetch(`http://${connectHost(lock.host ?? '127.0.0.1')}:${lock.port}/api/health`, {
    headers: { authorization: `Bearer ${loadToken(home)}` }, signal: AbortSignal.timeout(3_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as { version: string; uptimeMs: number; effects: { kind: string; failing: number }[] }
}

function printLinks(home: string, lock: LockInfo) {
  const token = loadToken(home)
  const host = lock.host ?? '127.0.0.1'
  console.log(`  登录链接  http://${connectHost(host)}:${lock.port}/auth?token=${token}`)
  for (const url of networkUrls(host, lock.port)) console.log(`  局域网    ${url}/auth?token=${token}`)
}

function warnIfOpen(host: string) {
  if (isLoopback(host)) return
  console.log(`  注意      服务监听在 ${host}，同一网络里的设备都能访问。登录令牌就是密码；不要直接暴露到公网，`)
  console.log('            需要远程访问时请放在 HTTPS 反向代理之后（或用 SSH 隧道）')
}

/** `start -d`: runs the service detached (output in <home>/logs/daemon.log) and returns once it answers. */
async function startInBackground(opts: StartOpts) {
  migrateLegacyHome()
  const config = resolveConfig(opts)
  const running = readLock(config.home)
  if (running) {
    console.log(`已在运行（pid ${running.pid}，端口 ${running.port}）`)
    printLinks(config.home, running)
    return
  }
  mkdirSync(join(config.home, 'logs'), { recursive: true })
  const logFile = join(config.home, 'logs', 'daemon.log')
  const out = openSync(logFile, 'a')
  const args = ['start', '--no-open', ...(opts.host ? ['--host', opts.host] : []), ...(opts.port !== undefined ? ['--port', String(opts.port)] : []),
    ...(opts.dev ? ['--dev'] : []), ...(opts.desktop ? ['--desktop'] : [])]
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
    printLinks(config.home, lock)
    warnIfOpen(lock.host ?? '127.0.0.1')
    console.log(`  日志      ${logFile}`)
    console.log('  停止      nuonuo stop')
    process.exit(0)
  }
  console.error(`后台服务没有启动起来，请查看 ${logFile}`)
  process.exit(1)
}

program.command('start').description('启动服务（默认只监听 127.0.0.1:7420；-d 在后台运行）')
  .option('-H, --host <ip>', '监听地址：127.0.0.1 仅本机，0.0.0.0 所有网卡（局域网可访问），或某个网卡的 IP')
  .option('-p, --port <port>', '端口（默认 7420）', parsePort)
  .option('-d, --daemon', '在后台运行（输出写到数据目录的 logs/daemon.log），用 nuonuo stop 停止')
  .option('--no-open', '不自动打开浏览器')
  .option('--dev', '开发模式：允许 Vite 开发服务器（localhost:5173）访问 API')
  .addOption(new Option('--desktop', '由桌面应用启动').hideHelp())
  .action(async (opts: StartOpts) => {
    // An install from before the rename: move ~/.super-assistant to ~/.nuonuo now that the old service has stopped.
    const move = migrateLegacyHome()
    if (move.moved) console.log(`数据目录已从 ${move.from} 移到 ${move.to}`)
    else if (move.reason) console.warn(move.reason)
    if (opts.daemon) return startInBackground(opts)
    const config = resolveConfig(opts)
    let stopping = false
    let child: ReturnType<typeof spawn> | undefined
    // After a self-update or a settings change (when not run by systemd): stop, then run again in this terminal.
    const launch = () => {
      if (child) return
      const args = process.argv.slice(2)
      child = spawn(process.execPath, [...process.execArgv, entry, ...args, ...(args.includes('--no-open') ? [] : ['--no-open'])], { stdio: 'inherit', windowsHide: true })
      // Ctrl+C reaches the child directly (same process group); a SIGTERM to this process is passed on.
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
        // systemd (Restart=on-failure) starts the service again after a failing exit.
        try { await started.stop() } catch (error) { console.error(error instanceof Error ? error.message : error) }
        process.exit(75)
      }
      // A shutdown that hangs must not stop the new process from starting: launch anyway once the deadline passes.
      const deadline = setTimeout(() => { console.error('停止超时，直接重新启动'); launch() }, 8_000)
      try { await started.stop() } catch (error) { console.error(error instanceof Error ? error.message : error) } finally { clearTimeout(deadline) }
      launch()
    }
    const started = await startDaemon(config, { restart: () => { void restart() } })
    void findDockerHost().then(host => { if (host) console.log(`Docker：使用 ${host}`) })
    console.log(`Nuonuo ${VERSION} 已启动`)
    console.log(`  数据目录  ${config.home}`)
    console.log(`  密钥存储  ${started.runtime.secrets.backend}${started.runtime.secretsNote ? `（${started.runtime.secretsNote}）` : ''}`)
    console.log(`  登录链接  ${config.dev ? started.loginUrl.replace(started.url, 'http://localhost:5173') : started.loginUrl}`)
    const token = started.loginUrl.slice(started.loginUrl.indexOf('/auth'))
    for (const url of started.networkUrls) console.log(`  局域网    ${url}${token}`)
    if (config.web) warnIfOpen(config.host)
    if (opts.open && !config.dev && !config.desktop) openBrowser(started.loginUrl)
    const stop = async (signal: NodeJS.Signals) => {
      // A second Ctrl+C means "I don't care how far you got": exit now instead of ignoring it.
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

/** Asks the running service to stop and waits until it is gone. Returns false when nothing was running. */
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
    console.log('服务由 systemd 管理：用 systemctl --user stop nuonuo 停止（否则开机自启的设置会让它再起来）')
  }
  console.log(await stopRunning(config.home) ? '已停止' : '未运行')
})

program.command('restart').description('重启服务（在后台运行，使用保存的地址和端口）')
  .option('-H, --host <ip>', '这次使用的监听地址').option('-p, --port <port>', '这次使用的端口', parsePort)
  .action(async (opts: { host?: string; port?: number }) => {
    const config = resolveConfig()
    if (await stopRunning(config.home)) console.log('已停止')
    await startInBackground({ ...opts, open: false })
  })

program.command('config').description('查看或保存监听地址和端口（保存在数据目录的 config.json，下次启动生效）')
  .option('-H, --host <ip>', '监听地址：127.0.0.1 仅本机，0.0.0.0 所有网卡')
  .option('-p, --port <port>', '端口', parsePort)
  .option('--web <on|off>', '桌面版：是否允许在浏览器里打开')
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
    const saved = readSavedConfig(config.home)
    if (saved.web !== undefined) console.log(`桌面版网页访问  ${saved.web ? '开启' : '关闭'}`)
  })

program.command('status').description('查看服务是否在运行').action(async () => {
  const config = resolveConfig()
  const lock = readLock(config.home)
  if (!lock) { console.log('未运行'); process.exitCode = 1; return }
  try {
    const h = await health(config.home, lock)
    const failing = h.effects.filter(e => e.failing > 0)
    console.log(`运行中  pid ${lock.pid}  地址 ${lock.host ?? '127.0.0.1'}:${lock.port}  版本 ${h.version}  已运行 ${Math.round(h.uptimeMs / 60000)} 分钟`)
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

program.command('token').description('打印登录链接').option('--rotate', '生成新令牌（旧的登录会失效）').action((opts: { rotate?: boolean }) => {
  const config = resolveConfig()
  const token = opts.rotate ? rotateToken(config.home) : loadToken(config.home)
  const lock = readLock(config.home)
  console.log(`http://${connectHost(lock?.host ?? config.host)}:${lock?.port ?? config.port}/auth?token=${token}`)
  if (opts.rotate) console.log('已轮换令牌；运行中的服务需重启后生效')
})

/** Calls the running service's owner API (the service must be running: pairing codes live in its memory). */
async function ownerApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = resolveConfig()
  const lock = readLock(config.home)
  if (!lock) throw new Error('服务没有在运行：先运行 nuonuo start -d')
  const res = await fetch(`http://${connectHost(lock.host ?? '127.0.0.1')}:${lock.port}/api${path}`, {
    ...init, headers: { authorization: `Bearer ${loadToken(config.home)}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json() as T & { error?: { message: string } }
  if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`)
  return data
}

const KIND_NAMES: Record<string, string> = { phone: '手机', tablet: '平板', watch: '手表', speaker: '音箱', car: '车机', tv: '电视', glasses: '眼镜', desktop: '电脑', bot: '机器人', other: '设备' }

program.command('pair').description('生成一个配对码，让手机、手表、音箱等设备接入（客户端协议）')
  .option('--name <name>', '给设备起名（默认用设备自己报的名字）')
  .option('--approvals', '允许这个设备回答「要不要做」的确认')
  .option('--no-notices', '不给这个设备推送通知')
  .action(async (opts: { name?: string; approvals?: boolean; notices: boolean }) => {
    try {
      const scopes = ['chat', ...(opts.notices ? ['notices'] : []), ...(opts.approvals ? ['approvals'] : [])]
      const r = await ownerApi<{ code: string; expiresAt: number; scopes: string[]; urls: string[]; base: string; reachable: boolean }>('/devices/pair', { method: 'POST', body: JSON.stringify({ scopes, ...(opts.name ? { name: opts.name } : {}) }) })
      console.log(`  配对码    ${r.code}   （10 分钟内有效，只能用一次）`)
      console.log(`  权限      ${r.scopes.join(', ')}`)
      for (const url of r.urls) console.log(`  地址      ${url}${r.base}`)
      if (!r.reachable) console.log('  注意      服务只监听本机，其他设备连不上：在「设置 → 系统 → 网页访问」开启局域网访问，或运行 nuonuo config --host 0.0.0.0 后重启')
      console.log('  协议文档  https://github.com/cyDione/nuonuo/blob/main/docs/11-client-protocol.md')
    } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
  })

const devicesCmd = program.command('devices').description('查看或移除已配对的设备')
devicesCmd.command('list', { isDefault: true }).description('列出已配对的设备').action(async () => {
  try {
    const { devices } = await ownerApi<{ devices: { id: string; name: string; kind: string; scopes: string[]; lastSeenAt: number | null }[] }>('/devices')
    if (!devices.length) { console.log('还没有配对的设备。运行 nuonuo pair 生成配对码。'); return }
    for (const d of devices) console.log(`  ${d.id}  ${d.name}（${KIND_NAMES[d.kind] ?? d.kind}）  ${d.scopes.join(',')}  ${d.lastSeenAt ? `上次在线 ${new Date(d.lastSeenAt).toLocaleString()}` : ''}`)
  } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
})
devicesCmd.command('revoke <id>').description('移除一个设备（它的令牌立刻失效）').action(async (id: string) => {
  try { await ownerApi(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); console.log('已移除') } catch (error) { console.error((error as Error).message); process.exitCode = 1 }
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
    console.log('下一步：把 index.mjs 里带 TODO 的地方换成这个软件的接口，然后在「设置 → 插件」里从本机文件夹安装它。')
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
    // Run install.sh in the foreground (the web UI's button runs the same thing in the background).
    const { script, env } = await updater.prepare()
    const child = spawn('bash', ['-s'], { stdio: ['pipe', 'inherit', 'inherit'], env })
    child.stdin.end(script)
    const code = await new Promise<number>(done => child.on('exit', c => done(c ?? 1)))
    if (code !== 0) { console.error('更新失败'); process.exitCode = code; return }
    // install.sh restarts the systemd service itself; a service started in a terminal has to be restarted by hand.
    const lock = readLock(config.home)
    if (lock && !runsAsService({}, `/proc/${lock.pid}/cgroup`)) console.log('提示：如果服务在终端里运行（不是 systemd 服务），请重启它以使用新版本')
  })

const service = program.command('service').description('开机自启（macOS launchd / Linux systemd 用户服务）')
service.command('install').option('--dry-run', '只打印将写入的文件').action((opts: { dryRun?: boolean }) => {
  console.log(installService(entry, resolveConfig().home, Boolean(opts.dryRun)))
})
service.command('uninstall').action(() => console.log(uninstallService(entry, resolveConfig().home)))

program.parseAsync().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
