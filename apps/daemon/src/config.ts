import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const VERSION = '0.1.0'
export const DEFAULT_PORT = 7420

export interface DaemonConfig {
  home: string
  port: number
  /** Always loopback: the daemon drives a real machine and must not listen on the network. */
  host: '127.0.0.1'
  dev: boolean
  /** Extra origins allowed to call the API (the Vite dev server in --dev). */
  devOrigins: string[]
}

export function resolveConfig(opts: { port?: number; dev?: boolean } = {}): DaemonConfig {
  const home = resolve(process.env.SUPERAGENT_HOME || join(homedir(), '.superagent'))
  const port = opts.port ?? (Number(process.env.SUPERAGENT_PORT) || DEFAULT_PORT)
  const dev = Boolean(opts.dev)
  return { home, port, host: '127.0.0.1', dev, devOrigins: dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [] }
}

/**
 * Loads `<home>/env` (KEY=value lines) into the environment, without overriding what is already set. A service started
 * at login (launchd / systemd) does not see the shell's exports, so keys such as OPENAI_API_KEY live here instead.
 * The file holds secrets: it is kept at mode 0600.
 */
export function loadEnvFile(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = join(home, 'env')
  if (!existsSync(file)) return []
  try { if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600) } catch { /* best effort */ }
  const loaded: string[] = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
    if (env[m[1]!] === undefined) { env[m[1]!] = value; loaded.push(m[1]!) }
  }
  return loaded
}
