#!/usr/bin/env node
import { Command } from 'commander'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadToken, rotateToken } from './auth'
import { loadEnvFile, resolveConfig, VERSION } from './config'
import { runDoctor } from './doctor'
import { createRuntime, readLock } from './runtime'
import { startDaemon } from './server'
import { installService, uninstallService } from './service'
import { Updater } from './update'

// Keys in <home>/env reach every command, including a service started at login.
loadEnvFile(resolveConfig().home)

const program = new Command('super-assistant').version(VERSION).description('你的个人 Super-assistant（本机运行）')
const entry = fileURLToPath(import.meta.url)

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  execFile(cmd, [url], () => { /* no desktop: the printed link is enough */ })
}

program.command('start').description('启动本机服务（仅监听 127.0.0.1）')
  .option('-p, --port <port>', '端口', v => Number(v))
  .option('--no-open', '不自动打开浏览器')
  .option('--dev', '开发模式：允许 Vite 开发服务器（localhost:5173）访问 API')
  .action(async (opts: { port?: number; open: boolean; dev?: boolean }) => {
    const config = resolveConfig(opts)
    let stopping = false
    let child: ReturnType<typeof spawn> | undefined
    // After a self-update from the web UI (when not run by systemd): stop, then run the new version in this terminal.
    const launch = () => {
      if (child) return
      const args = process.argv.slice(2)
      child = spawn(process.execPath, [entry, ...args, ...(args.includes('--no-open') ? [] : ['--no-open'])], { stdio: 'inherit' })
      // Ctrl+C reaches the child directly (same process group); a SIGTERM to this process is passed on.
      process.removeAllListeners('SIGINT').on('SIGINT', () => {})
      process.removeAllListeners('SIGTERM').on('SIGTERM', () => child?.kill('SIGTERM'))
      child.on('error', error => { console.error(`无法启动新版本：${error.message}`); process.exit(1) })
      child.on('exit', code => process.exit(code ?? 0))
    }
    const restart = async () => {
      if (stopping) return
      stopping = true
      console.log('已安装新版本，正在重启…')
      // A shutdown that hangs must not stop the new version from starting: launch anyway once the deadline passes.
      const deadline = setTimeout(() => { console.error('停止超时，直接启动新版本'); launch() }, 8_000)
      try { await started.stop() } catch (error) { console.error(error instanceof Error ? error.message : error) } finally { clearTimeout(deadline) }
      launch()
    }
    const started = await startDaemon(config, { restart: () => { void restart() } })
    console.log(`Super-assistant ${VERSION} 已启动`)
    console.log(`  数据目录  ${config.home}`)
    console.log(`  密钥存储  ${started.runtime.secrets.backend}${started.runtime.secretsNote ? `（${started.runtime.secretsNote}）` : ''}`)
    console.log(`  登录链接  ${config.dev ? started.loginUrl.replace(started.url, 'http://localhost:5173') : started.loginUrl}`)
    if (opts.open && !config.dev) openBrowser(started.loginUrl)
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

program.command('status').description('查看服务是否在运行').action(async () => {
  const config = resolveConfig()
  const lock = readLock(config.home)
  if (!lock) { console.log('未运行'); process.exitCode = 1; return }
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`, { headers: { authorization: `Bearer ${loadToken(config.home)}` } })
    const health = await res.json() as { version: string; uptimeMs: number; effects: { kind: string; failing: number }[] }
    const failing = health.effects.filter(e => e.failing > 0)
    console.log(`运行中  pid ${lock.pid}  端口 ${lock.port}  版本 ${health.version}  已运行 ${Math.round(health.uptimeMs / 60000)} 分钟`)
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
    for (const check of runDoctor(rt)) {
      console.log(`${icon[check.status]} ${pad(check.label, 14)}${check.detail}${check.status !== 'ok' && check.fix ? `\n    → ${check.fix}` : ''}`)
    }
  } finally { await rt.close() }
})

program.command('token').description('打印登录链接').option('--rotate', '生成新令牌（旧的登录会失效）').action((opts: { rotate?: boolean }) => {
  const config = resolveConfig()
  const token = opts.rotate ? rotateToken(config.home) : loadToken(config.home)
  const port = readLock(config.home)?.port ?? config.port
  console.log(`http://127.0.0.1:${port}/auth?token=${token}`)
  if (opts.rotate) console.log('已轮换令牌；运行中的服务需重启后生效')
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
    if (readLock(config.home) && !process.env.INVOCATION_ID) console.log('提示：如果服务在终端里运行（不是 systemd 服务），请重启它以使用新版本')
  })

const service = program.command('service').description('开机自启（macOS launchd / Linux systemd 用户服务）')
service.command('install').option('--dry-run', '只打印将写入的文件').action((opts: { dryRun?: boolean }) => {
  console.log(installService(entry, resolveConfig().home, Boolean(opts.dryRun)))
})
service.command('uninstall').action(() => console.log(uninstallService(entry, resolveConfig().home)))

program.parseAsync().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
