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
