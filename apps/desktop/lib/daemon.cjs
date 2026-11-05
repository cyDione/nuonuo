// Finds the running Super-assistant daemon, or starts one with the system's Node.js.
// The desktop app and the CLI share one daemon and one data directory; the daemon keeps running after the window closes,
// so routines and sources keep working.
const { spawn, execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, openSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, resolve } = require('node:path')

const home = () => resolve(process.env.SUPER_ASSISTANT_HOME || join(homedir(), '.super-assistant'))

function readLock() {
  try {
    const info = JSON.parse(readFileSync(join(home(), 'daemon.json'), 'utf8'))
    process.kill(info.pid, 0)
    return info
  } catch { return undefined }
}

const token = () => { try { return readFileSync(join(home(), 'token'), 'utf8').trim() } catch { return undefined } }

async function health(port) {
  const t = token()
  if (!t) return false
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(2_000) })
    return res.ok
  } catch { return false }
}

/** GUI apps on macOS start with a minimal PATH, so look where Node usually lives too. */
function findNode() {
  if (process.env.SUPER_ASSISTANT_NODE) return process.env.SUPER_ASSISTANT_NODE
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', join(homedir(), '.volta/bin/node')]
  try {
    const nvm = join(homedir(), '.nvm/versions/node')
    if (existsSync(nvm)) for (const v of require('node:fs').readdirSync(nvm).sort().reverse()) candidates.push(join(nvm, v, 'bin/node'))
  } catch { /* no nvm */ }
  try { candidates.unshift(execFileSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5_000 }).trim()) } catch { /* no login shell node */ }
  return candidates.find(p => p && existsSync(p))
}

/** The daemon's CLI: next to the app when packaged, else in the repository. */
function findCli() {
  const options = [process.env.SUPER_ASSISTANT_CLI, process.resourcesPath && join(process.resourcesPath, 'daemon', 'cli.mjs'), join(__dirname, '..', '..', 'daemon', 'dist', 'cli.mjs')]
  return options.find(p => p && existsSync(p))
}

/** Returns { port, token } of a healthy daemon, starting one if needed. */
async function ensureDaemon(log = console.log) {
  const running = readLock()
  if (running && await health(running.port)) return { port: running.port, token: token(), started: false }
  const node = findNode()
  const cli = findCli()
  if (!node) throw new Error('找不到 Node.js（需要 22.12 或更高版本）。安装 Node，或设置环境变量 SUPER_ASSISTANT_NODE 指向 node 可执行文件。')
  if (!cli) throw new Error('找不到 Super-assistant 服务（apps/daemon/dist/cli.mjs）。先在仓库里运行 pnpm build，或设置 SUPER_ASSISTANT_CLI。')
  mkdirSync(join(home(), 'logs'), { recursive: true })
  const out = openSync(join(home(), 'logs', 'daemon.log'), 'a')
  log(`starting daemon: ${node} ${cli}`)
  const child = spawn(node, [cli, 'start', '--no-open'], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, SUPER_ASSISTANT_HOME: home() }, cwd: join(cli, '..') })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500))
    const lock = readLock()
    if (lock && await health(lock.port)) return { port: lock.port, token: token(), started: true }
    if (child.exitCode !== null) break
  }
  throw new Error(`服务没有启动起来，请查看 ${join(home(), 'logs', 'daemon.log')}`)
}

function stopDaemon() {
  const lock = readLock()
  if (lock) process.kill(lock.pid, 'SIGTERM')
  return Boolean(lock)
}

module.exports = { ensureDaemon, stopDaemon, home, token }
