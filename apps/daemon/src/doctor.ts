/** Environment checks shown by `superagent doctor` and Settings → System. */
import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import type { Runtime } from './runtime'

export interface Check { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string; fix?: string }

function version(cmd: string, args: string[] = ['--version']): string | undefined {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0] }
  catch { return undefined }
}

export function runDoctor(rt: Runtime): Check[] {
  const checks: Check[] = []
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number]
  checks.push({ id: 'node', label: 'Node.js', status: major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'error',
    detail: process.versions.node, fix: '需要 Node.js 22.12 或更高版本' })
  checks.push({ id: 'platform', label: '平台', status: ['darwin', 'linux'].includes(process.platform) ? 'ok' : 'warn',
    detail: `${process.platform} ${process.arch}`, fix: '目前只适配 macOS 与 Linux' })
  try { accessSync(rt.config.home, constants.W_OK); checks.push({ id: 'home', label: '数据目录', status: 'ok', detail: rt.config.home }) }
  catch { checks.push({ id: 'home', label: '数据目录', status: 'error', detail: `${rt.config.home} 不可写` }) }
  const sqlite = rt.store.sqlite.prepare('select sqlite_version() as v').get() as { v: string }
  checks.push({ id: 'sqlite', label: 'SQLite', status: 'ok', detail: sqlite.v })
  checks.push({ id: 'secrets', label: '密钥存储', status: rt.secrets.backend === 'keychain' ? 'ok' : 'warn',
    detail: rt.secrets.backend === 'keychain' ? '系统钥匙串' : `加密文件（${rt.secretsNote ?? ''}）`,
    fix: rt.secrets.backend === 'keychain' ? undefined : 'Linux 上可安装并解锁 gnome-keyring / KWallet 以使用系统钥匙串；加密文件模式下请勿把数据目录同步到云端' })
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
  const gh = version('gh')
  checks.push({ id: 'gh', label: 'GitHub CLI', status: gh ? 'ok' : 'warn', detail: gh ?? '未安装', fix: 'M2 的 GitHub 插件可复用 gh 登录' })
  const docker = version('docker', ['version', '--format', '{{.Server.Version}}'])
  checks.push({ id: 'docker', label: 'Docker', status: docker ? 'ok' : 'warn', detail: docker ? `server ${docker}` : '不可用', fix: '沙箱执行档（M3）需要 Docker' })
  return checks
}
