/**
 * A service started by the macOS desktop app (or launchd) gets the minimal GUI PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so tools installed by Homebrew, Docker Desktop or OrbStack are invisible to the doctor and to tasks. Before anything
 * runs, fold in the login shell's PATH and the usual install places; then point DOCKER_HOST at a running engine's
 * socket when the docker CLI cannot find one by itself.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const MARK = '__NUONUO_PATH__'

/** The usual places macOS tools live that a GUI-launched process does not see. */
export function extraPathDirs(home = homedir()): string[] {
  return [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    join(home, '.docker/bin'), join(home, '.orbstack/bin'), '/Applications/Docker.app/Contents/Resources/bin',
    '/Applications/OrbStack.app/Contents/MacOS/xbin', join(home, '.rd/bin'), join(home, '.local/bin'),
  ]
}

/** PATH with `extra` entries appended after the current ones, without duplicates or empty entries. */
export function mergePath(current: string | undefined, ...extra: (string | undefined)[][]): string {
  const seen = new Set<string>()
  for (const list of [(current ?? '').split(delimiter), ...extra]) for (const dir of list) if (dir) seen.add(dir)
  return [...seen].join(delimiter)
}

function loginShellPath(): string[] {
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const out = execFileSync(shell, ['-ilc', `printf '%s%s%s' ${MARK} "$PATH" ${MARK}`], { encoding: 'utf8', timeout: 4_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(MARK)[1]?.split(delimiter) ?? []
  } catch { return [] }
}

/** On macOS, widen PATH with the login shell's and the common install directories. */
export function widenPath() {
  if (process.platform !== 'darwin') return
  process.env.PATH = mergePath(process.env.PATH, loginShellPath(), extraPathDirs())
}

/** Sockets that Docker Desktop, OrbStack, Colima, Rancher Desktop and Podman listen on. */
export function dockerSockets(home = homedir()): string[] {
  return [
    join(home, '.docker/run/docker.sock'), join(home, '.orbstack/run/docker.sock'), join(home, '.colima/default/docker.sock'),
    join(home, '.colima/docker.sock'), join(home, '.rd/docker.sock'), '/var/run/docker.sock',
  ]
}

const dockerUp = (env: NodeJS.ProcessEnv) => new Promise<boolean>(resolve => {
  execFile('docker', ['version', '--format', '{{.Server.Version}}'], { env, timeout: 8_000 }, (err, out) => resolve(!err && Boolean(String(out).trim())))
})

/**
 * When `docker` cannot reach an engine on its own (e.g. /var/run/docker.sock missing because Docker Desktop's
 * privileged helper is off), try the per-user sockets and keep the first that answers in DOCKER_HOST, which every
 * command the service runs afterwards inherits. Returns the socket chosen, if any.
 */
export async function findDockerHost(): Promise<string | undefined> {
  if (process.env.DOCKER_HOST || process.platform === 'win32') return undefined
  if (await dockerUp(process.env)) return undefined
  for (const sock of dockerSockets()) {
    if (!existsSync(sock)) continue
    const host = `unix://${sock}`
    if (await dockerUp({ ...process.env, DOCKER_HOST: host })) { process.env.DOCKER_HOST = host; return host }
  }
  return undefined
}
