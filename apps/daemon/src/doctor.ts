/** Environment checks shown by `nuonuo doctor` and Settings → System. */
import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import type { Runtime } from './runtime'
import { findDockerHost } from './shell-env'

export interface Check { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string; fix?: string }

function version(cmd: string, args: string[] = ['--version']): string | undefined {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0] }
  catch { return undefined }
}

export async function runDoctor(rt: Runtime): Promise<Check[]> {
  const checks: Check[] = []
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number]
  checks.push({ id: 'node', label: 'Node.js', status: major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'error',
    detail: process.versions.node, fix: '需要 Node.js 22.12 或更高版本' })
  checks.push({ id: 'platform', label: '平台', status: ['darwin', 'linux'].includes(process.platform) ? 'ok' : 'warn',
    detail: `${process.platform} ${process.arch}`, fix: '目前只适配 macOS 与 Linux' })
  try { accessSync(rt.config.home, constants.W_OK); checks.push({ id: 'home', label: '数据目录', status: 'ok', detail: rt.config.home }) }
  catch { checks.push({ id: 'home', label: '数据目录', status: 'error', detail: `${rt.config.home} 不可写` }) }
  const root = process.getuid?.() === 0
  checks.push({ id: 'user', label: '运行身份', status: root ? 'warn' : 'ok', detail: root ? 'root' : `uid ${process.getuid?.() ?? '?'}`,
    fix: root ? '任务的命令以服务的身份执行。建议用一个单独的普通用户运行 nuonuo，只给它需要的权限；或在 设置 → 执行 里把沙箱设为「全部」' : undefined })
  const sqlite = rt.store.sqlite.prepare('select sqlite_version() as v').get() as { v: string }
  checks.push({ id: 'sqlite', label: 'SQLite', status: 'ok', detail: sqlite.v })
  // macOS uses the encrypted file on purpose (packages/models/src/secrets.ts), so it is not a warning there.
  const secretsOk = rt.secrets.backend === 'keychain' || process.platform === 'darwin'
  checks.push({ id: 'secrets', label: '密钥存储', status: secretsOk ? 'ok' : 'warn',
    detail: rt.secrets.backend === 'keychain' ? '系统钥匙串' : `加密文件（${rt.secretsNote ?? ''}）`,
    fix: secretsOk ? undefined : 'Linux 上可安装并解锁 gnome-keyring / KWallet 以使用系统钥匙串；加密文件模式下请勿把数据目录同步到云端' })
  const providers = rt.hub.listProviders()
  checks.push({ id: 'providers', label: '模型供应商', status: providers.length ? 'ok' : 'warn',
    detail: providers.length ? `${providers.length} 个` : '尚未添加', fix: '设置 → 模型供应商 中添加 API key' })
  const router = rt.hub.resolve('router')
  checks.push({ id: 'router', label: '主 Agent 模型', status: router ? 'ok' : 'warn',
    detail: router ? `${router.config.chain[0]!.model}` : '未配置', fix: '设置 → 分层模型 中为主 Agent 选择模型' })
  for (const health of rt.effects.health().filter(h => h.failing > 0)) {
    checks.push({ id: `effects:${health.kind}`, label: `后台队列 ${health.kind}`, status: 'error', detail: health.lastError ?? `${health.failing} 项失败` })
  }
  const git = version('git')
  checks.push({ id: 'git', label: 'git', status: git ? 'ok' : 'warn', detail: git ?? '未安装', fix: 'M1 起任务工作目录依赖 git' })
  // Docker Desktop may be started after the service: look for its socket again on every check.
  await findDockerHost()
  const docker = version('docker', ['version', '--format', '{{.Server.Version}}'])
  const cli = docker ? undefined : version('docker')
  const sandbox = rt.engine.execution().sandbox
  checks.push({ id: 'docker', label: 'Docker', status: docker ? 'ok' : sandbox.mode === 'off' ? 'warn' : 'error',
    detail: docker ? `server ${docker}${sandbox.mode !== 'off' ? `，沙箱：${sandbox.image}` : ''}`
      : `${cli ? '已安装但连不上引擎' : '未找到 docker 命令'}${sandbox.mode === 'off' ? '（沙箱未启用）' : '，但沙箱已启用'}`,
    fix: cli ? '启动 Docker Desktop / OrbStack / Colima 后点「重新检查」；仍连不上时可在数据目录的 env 文件里设置 DOCKER_HOST'
      : '安装并启动 Docker（macOS：Docker Desktop / OrbStack），沙箱执行档需要它' })
  checks.push({ id: 'browser', label: '浏览器', status: rt.browserPath ? 'ok' : 'warn', detail: rt.browserPath ?? '未找到',
    fix: '安装 Google Chrome，或设置 NUONUO_BROWSER 指向 Chromium/Chrome 可执行文件' })
  return checks
}
