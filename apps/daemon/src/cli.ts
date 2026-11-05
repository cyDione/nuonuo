#!/usr/bin/env node
import { Command } from 'commander'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadToken, rotateToken } from './auth'
import { loadEnvFile, resolveConfig, VERSION } from './config'
import { runDoctor } from './doctor'
import { createRuntime, readLock } from './runtime'
import { startDaemon } from './server'
import { installService, uninstallService } from './service'

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
    const started = await startDaemon(config)
    console.log(`Super-assistant ${VERSION} 已启动`)
    console.log(`  数据目录  ${config.home}`)
    console.log(`  密钥存储  ${started.runtime.secrets.backend}${started.runtime.secretsNote ? `（${started.runtime.secretsNote}）` : ''}`)
    console.log(`  登录链接  ${config.dev ? started.loginUrl.replace(started.url, 'http://localhost:5173') : started.loginUrl}`)
    if (opts.open && !config.dev) openBrowser(started.loginUrl)
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      console.log('正在停止…')
      await started.stop()
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

const service = program.command('service').description('开机自启（macOS launchd / Linux systemd 用户服务）')
service.command('install').option('--dry-run', '只打印将写入的文件').action((opts: { dryRun?: boolean }) => {
  console.log(installService(entry, resolveConfig().home, Boolean(opts.dryRun)))
})
service.command('uninstall').action(() => console.log(uninstallService(entry, resolveConfig().home)))

program.parseAsync().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
