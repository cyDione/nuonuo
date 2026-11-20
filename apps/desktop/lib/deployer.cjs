// On-demand Local Deploy engine for the thin Nuonuo desktop client.
// The desktop app ships NO Node.js and NO daemon; when a user explicitly clicks "Local Deploy",
// this module installs/starts a local Nuonuo server (via CLI/install.sh or Docker) and exchanges a
// standard one-time admin pairing code over loopback so the desktop connects just like any client.
const { execFileSync, spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, resolve } = require('node:path')

const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh'
const DOCKER_CONTAINER = 'nuonuo-server'
const DOCKER_IMAGE = process.env.NUONUO_DOCKER_IMAGE || 'ghcr.io/cydione/nuonuo:latest'
const LOCAL_ADMIN_HEADER = 'x-nuonuo-local-admin'

function homeDir() {
  const set = (process.env.NUONUO_HOME || '').trim()
  return set ? resolve(set) : join(homedir(), '.nuonuo')
}

function readLock() {
  try {
    const info = JSON.parse(readFileSync(join(homeDir(), 'daemon.json'), 'utf8'))
    process.kill(info.pid, 0)
    return info
  } catch {
    return null
  }
}

function readLocalAdminKey() {
  try {
    return readFileSync(join(homeDir(), 'local-admin.key'), 'utf8').trim() || null
  } catch {
    return null
  }
}

function connectHost(host) {
  const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return h.includes(':') ? `[${h}]` : h
}

function findExecutable(names, extraPaths = []) {
  for (const p of extraPaths) {
    if (p && existsSync(p)) return p
  }
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  for (const name of names) {
    try {
      const out = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3_000, windowsHide: true }).split(/\r?\n/)[0].trim()
      if (out && existsSync(out)) return out
    } catch { /* not found */ }
  }
  return null
}

function findNode() {
  const extras = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', join(homedir(), '.local/share/nuonuo/node/bin/node')]
  return findExecutable(['node'], extras)
}

function findCli() {
  const devCli = join(__dirname, '..', '..', 'daemon', 'dist', 'cli.mjs')
  const extras = [
    process.env.NUONUO_CLI,
    join(homedir(), '.local/bin/nuonuo'),
    '/usr/local/bin/nuonuo',
    '/opt/homebrew/bin/nuonuo',
    existsSync(devCli) ? devCli : null,
  ]
  return findExecutable(['nuonuo'], extras)
}

function runStream(cmd, args, opts, onLog) {
  return new Promise(resolvePromise => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const emit = chunk => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) onLog(line)
      }
    }
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)
    child.on('error', err => { onLog(`error: ${err.message}`); resolvePromise(1) })
    child.on('exit', code => resolvePromise(code ?? 1))
  })
}

async function waitForServer(serverUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl}/v1/auth/methods`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return true
    } catch { /* wait */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

async function issueLocalPairCode(serverUrl) {
  const key = readLocalAdminKey()
  if (!key) throw new Error('未找到本机管理密钥（~/.nuonuo/local-admin.key）')
  const res = await fetch(`${serverUrl}/v1/auth/pair/codes`, {
    method: 'POST',
    headers: { [LOCAL_ADMIN_HEADER]: key, 'content-type': 'application/json' },
    body: JSON.stringify({ admin: true, serverUrl }),
    signal: AbortSignal.timeout(5_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.code) throw new Error(data?.error?.message || `签发配对码失败（HTTP ${res.status}）`)
  return data.code
}

function detect() {
  const lock = readLock()
  const cliPath = findCli()
  const nodePath = findNode()
  let nodeVersion = null
  if (nodePath) {
    try { nodeVersion = execFileSync(nodePath, ['-v'], { encoding: 'utf8', timeout: 2_000, windowsHide: true }).trim() } catch { /* ignore */ }
  }
  const dockerPath = findExecutable(['docker'], ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'])
  let dockerRunning = false
  if (dockerPath) {
    try {
      execFileSync(dockerPath, ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 3_000, windowsHide: true })
      dockerRunning = true
    } catch { dockerRunning = false }
  }
  return {
    platform: process.platform,
    daemonRunning: lock ? { pid: lock.pid, host: connectHost(lock.host), port: lock.port, web: Boolean(lock.web) } : null,
    hasCli: Boolean(cliPath),
    cliPath,
    hasNode: Boolean(nodePath),
    nodeVersion,
    hasDocker: Boolean(dockerPath),
    dockerRunning,
  }
}

async function startLocal(opts = {}, onLog = () => {}) {
  const port = Number(opts.port) || 7420
  const host = opts.host || '127.0.0.1'
  const web = Boolean(opts.web)

  // 1. Reuse already-running local server if healthy.
  const existing = readLock()
  if (existing) {
    const existingUrl = `http://${connectHost(existing.host)}:${existing.port}`
    onLog(`检测到本机服务正在运行（${existingUrl}），正在申请一次性配对码…`)
    if (await waitForServer(existingUrl, 5_000)) {
      const pairCode = await issueLocalPairCode(existingUrl)
      return { ok: true, serverUrl: existingUrl, pairCode }
    }
  }

  // 2. Ensure CLI is installed (or run official install.sh on Unix).
  let cli = findCli()
  if (!cli) {
    if (process.platform === 'win32') {
      return { ok: false, error: 'Windows 本机部署请先安装 Node.js 22+ 或改用 Docker 一键部署。' }
    }
    onLog(`未检测到 nuonuo CLI，正在通过官方脚本安装服务端：${INSTALL_SCRIPT_URL}`)
    const code = await runStream('/bin/bash', ['-lc', `curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- --server`], { env: { ...process.env, NUONUO_COMPONENT: 'server' } }, onLog)
    if (code !== 0) return { ok: false, error: `安装脚本退出码 ${code}` }
    cli = findCli()
    if (!cli) return { ok: false, error: '安装完成后仍未找到 nuonuo 命令，请查看日志' }
  }

  // 3. Start daemon in background (`--web` only if requested).
  const startArgs = ['start', '-d', '--no-open', '--host', host, '--port', String(port), web ? '--web' : '--no-web']
  const isMjs = cli.endsWith('.mjs')
  const cmd = isMjs ? findNode() : cli
  const args = isMjs ? [cli, ...startArgs] : startArgs
  if (!cmd) return { ok: false, error: '找不到 Node.js 22+ 运行时' }

  onLog(`正在启动本机服务：${cmd} ${args.join(' ')}`)
  const startCode = await runStream(cmd, args, { env: { ...process.env, NUONUO_HOME: homeDir() } }, onLog)
  if (startCode !== 0) return { ok: false, error: `启动本机服务失败（退出码 ${startCode}）` }

  const serverUrl = `http://${connectHost(host)}:${port}`
  if (!(await waitForServer(serverUrl, 25_000))) {
    return { ok: false, error: `等待服务就绪超时（${serverUrl}）` }
  }
  const pairCode = await issueLocalPairCode(serverUrl)
  onLog('本机服务已就绪，正在自动完成安全配对…')
  return { ok: true, serverUrl, pairCode }
}

async function startDocker(opts = {}, onLog = () => {}) {
  const port = Number(opts.port) || 7420
  const web = Boolean(opts.web)
  const docker = findExecutable(['docker'], ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'])
  if (!docker) return { ok: false, error: '未检测到 Docker，请先安装并启动 Docker Desktop。' }

  const dataDir = homeDir()
  onLog(`准备通过 Docker 部署容器 ${DOCKER_CONTAINER}（数据目录：${dataDir}，WebUI：${web ? '开启' : '关闭'}）…`)

  // Stop & remove previous container with same name if present.
  await runStream(docker, ['rm', '-f', DOCKER_CONTAINER], {}, () => {})

  const runArgs = [
    'run', '-d',
    '--name', DOCKER_CONTAINER,
    '--restart', 'unless-stopped',
    '-p', `${port}:7420`,
    '-v', `${dataDir}:/data`,
    '-e', `NUONUO_WEB=${web ? '1' : '0'}`,
    '-e', 'NUONUO_HOST=0.0.0.0',
    DOCKER_IMAGE,
  ]
  const code = await runStream(docker, runArgs, {}, onLog)
  if (code !== 0) return { ok: false, error: `Docker 启动失败（退出码 ${code}）。如尚未拉取镜像，可先在仓库根目录运行 docker build -t ${DOCKER_IMAGE} .` }

  const serverUrl = `http://127.0.0.1:${port}`
  if (!(await waitForServer(serverUrl, 30_000))) {
    return { ok: false, error: `容器启动后未在 ${serverUrl} 响应` }
  }
  const pairCode = await issueLocalPairCode(serverUrl)
  onLog('Docker 服务已就绪，正在自动完成安全配对…')
  return { ok: true, serverUrl, pairCode }
}

function stopLocal() {
  const lock = readLock()
  if (!lock) return { ok: false }
  try {
    process.kill(lock.pid, 'SIGTERM')
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

module.exports = { detect, startLocal, startDocker, stopLocal, homeDir, readLock }
