import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'

import pkg from '../package.json' with { type: 'json' }
import { resolveHome } from './legacy'

/** From apps/daemon/package.json; a release tag must match it (the release workflow checks). */
export const VERSION: string = pkg.version
export const DEFAULT_PORT = 7420

export const DEFAULT_HOST = '127.0.0.1'

export type ConfigSource = 'flag' | 'env' | 'file' | 'default'

export interface DaemonConfig {
  home: string
  port: number
  /**
   * The address the service listens on. Loopback (the default) keeps it on this machine; another address (0.0.0.0 for
   * every interface) opens the web UI to the network, still behind the login token.
   */
  host: string
  /** Started by the desktop app: the window is the main client, and browser access is a setting (`web`). */
  desktop: boolean
  /** Whether browsers may open the web UI. Always true for the headless service; off by default for the desktop app. */
  web: boolean
  /** Where host and port came from, so the settings page can say when a flag or variable overrides its saved value. */
  sources: { host: ConfigSource; port: ConfigSource }
  dev: boolean
  /** Extra origins allowed to call the API (the Vite dev server in --dev). */
  devOrigins: string[]
}

/** What the settings page (or `nuonuo config`) saves in `<home>/config.json`; applied on the next start. */
export interface SavedConfig { host?: string; port?: number; web?: boolean }

/** NUONUO_HOME, else ~/.nuonuo (or ~/.super-assistant until `start` moves it; see legacy.ts). */
export const homeDir = () => resolveHome()

export function readSavedConfig(home: string): SavedConfig {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as SavedConfig
    return {
      ...(typeof raw.host === 'string' && raw.host.trim() ? { host: raw.host.trim() } : {}),
      ...(validPort(raw.port) ? { port: raw.port } : {}),
      ...(typeof raw.web === 'boolean' ? { web: raw.web } : {}),
    }
  } catch { return {} }
}

export function writeSavedConfig(home: string, patch: SavedConfig): SavedConfig {
  if (patch.host !== undefined && !validHost(patch.host)) throw new Error(`无效的监听地址：${patch.host}`)
  if (patch.port !== undefined && !validPort(patch.port)) throw new Error(`无效的端口：${patch.port}（1–65535）`)
  const next = { ...readSavedConfig(home), ...patch }
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export const validPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= 0 && (port as number) <= 65535
/** An IPv4/IPv6 literal or a host name; the service binds to it, so anything else would only fail later. */
export const validHost = (host: string) => isIP(host) !== 0 || /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host)
export const isLoopback = (host: string) => host === 'localhost' || host === '::1' || /^127\./.test(host)
export const isWildcard = (host: string) => host === '0.0.0.0' || host === '::'

/** The address to reach a service listening on `host` from this machine: loopback for a wildcard bind. */
export function connectHost(host: string): string {
  const h = isWildcard(host) ? '127.0.0.1' : host
  return h.includes(':') ? `[${h}]` : h
}

/** URLs for a service listening on `host`: the interface addresses for a wildcard bind, else the address itself. */
export function networkUrls(host: string, port: number): string[] {
  if (isLoopback(host)) return []
  if (!isWildcard(host)) return [`http://${connectHost(host)}:${port}`]
  const v6 = host === '::'
  return Object.values(networkInterfaces()).flat()
    .filter(a => a && !a.internal && (a.family === 'IPv4' || (v6 && a.family === 'IPv6' && !a.address.startsWith('fe80'))))
    .map(a => `http://${a!.family === 'IPv6' ? `[${a!.address}]` : a!.address}:${port}`)
}

export function resolveConfig(opts: { port?: number; host?: string; dev?: boolean; desktop?: boolean } = {}): DaemonConfig {
  const home = homeDir()
  const saved = readSavedConfig(home)
  const envPort = Number(process.env.NUONUO_PORT)
  const envHost = process.env.NUONUO_HOST?.trim()
  const [port, portSource]: [number, ConfigSource] = opts.port !== undefined ? [opts.port, 'flag']
    : validPort(envPort) && process.env.NUONUO_PORT ? [envPort, 'env']
    : saved.port !== undefined ? [saved.port, 'file'] : [DEFAULT_PORT, 'default']
  let [host, hostSource]: [string, ConfigSource] = opts.host ? [opts.host, 'flag']
    : envHost ? [envHost, 'env'] : saved.host ? [saved.host, 'file'] : [DEFAULT_HOST, 'default']
  if (!validPort(port)) throw new Error(`无效的端口：${port}（1–65535）`)
  if (!validHost(host)) throw new Error(`无效的监听地址：${host}`)
  const desktop = Boolean(opts.desktop)
  const web = desktop ? saved.web ?? false : true
  // The desktop app without browser access keeps the service on this machine whatever address was saved.
  if (desktop && !web && hostSource !== 'flag') host = DEFAULT_HOST
  const dev = Boolean(opts.dev)
  return {
    home, port, host, desktop, web, sources: { host: hostSource, port: portSource }, dev,
    devOrigins: dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
  }
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
