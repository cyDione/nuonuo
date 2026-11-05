import { serve, type ServerType } from '@hono/node-server'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { loadToken } from './auth'
import { connectHost, networkUrls, type DaemonConfig } from './config'
import { createRuntime, type Runtime } from './runtime'
import { Updater } from './update'

/** The built web UI: next to the bundled daemon (`dist/web`) or in the workspace (`apps/web/dist`). */
export function findWebRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, 'web'), join(here, '../../web/dist')].find(p => existsSync(join(p, 'index.html')))
}

export interface Started {
  runtime: Runtime; updater: Updater; server: ServerType
  /** The address on this machine, and the login link there. */
  url: string; loginUrl: string
  /** Addresses other devices can use (empty on loopback). */
  networkUrls: string[]
  stop(): Promise<void>
}

/**
 * `restart` stops this process and runs it again (after a self-update, or when the settings page changes the address);
 * without it nothing restarts the service.
 */
export async function startDaemon(config: DaemonConfig, opts: { restart?: () => void } = {}): Promise<Started> {
  const runtime = await createRuntime(config)
  const token = loadToken(config.home)
  // Bundled, this module is cli.mjs itself; from source it is src/server.ts. Either locates the installation.
  const updater = new Updater({ home: config.home, entry: fileURLToPath(import.meta.url), restart: opts.restart, desktop: config.desktop })
  // Aborted on shutdown: ends the web UI's event streams, which would otherwise hold the server open.
  const closing = new AbortController()
  let listening: ServerType | undefined
  const port = () => (listening?.address() as AddressInfo | null)?.port ?? config.port
  const app = createApp(runtime, token, findWebRoot(), updater, closing.signal, { restart: opts.restart, port })
  runtime.effects.start()
  runtime.startAgents()
  updater.startBackgroundChecks()
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s))
    s.once('error', reject)
  }).catch(async error => { await runtime.close(); throw error })
  listening = server
  const url = `http://${connectHost(config.host)}:${port()}`
  return {
    runtime, updater, server, url, loginUrl: `${url}/auth?token=${token}`, networkUrls: config.web ? networkUrls(config.host, port()) : [],
    async stop() {
      updater.stop()
      // End the event streams first: a browser keeps them open while it waits for the server to come back, so
      // server.close() would wait for a client that is itself waiting for us (the process never exits).
      closing.abort()
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      const sockets = server as unknown as { closeIdleConnections?(): void; closeAllConnections?(): void }
      sockets.closeIdleConnections?.()
      // In-flight requests get a moment; whatever is left is cut, so shutdown always finishes.
      const timer = setTimeout(() => sockets.closeAllConnections?.(), 1_500)
      try { await closed } finally { clearTimeout(timer) }
      await runtime.close()
    },
  }
}
