import { serve, type ServerType } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { loadToken } from './auth'
import type { DaemonConfig } from './config'
import { createRuntime, type Runtime } from './runtime'

/** The built web UI: next to the bundled daemon (`dist/web`) or in the workspace (`apps/web/dist`). */
export function findWebRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, 'web'), join(here, '../../web/dist')].find(p => existsSync(join(p, 'index.html')))
}

export interface Started { runtime: Runtime; server: ServerType; url: string; loginUrl: string; stop(): Promise<void> }

export async function startDaemon(config: DaemonConfig): Promise<Started> {
  const runtime = await createRuntime(config)
  const token = loadToken(config.home)
  const app = createApp(runtime, token, findWebRoot())
  runtime.effects.start()
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s))
    s.once('error', reject)
  }).catch(async error => { await runtime.close(); throw error })
  const url = `http://127.0.0.1:${config.port}`
  return {
    runtime, server, url, loginUrl: `${url}/auth?token=${token}`,
    async stop() {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await runtime.close()
    },
  }
}
