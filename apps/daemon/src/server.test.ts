import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { loadToken } from './auth'
import { resolveConfig } from './config'
import { startDaemon } from './server'

describe('shutdown', () => {
  it('stops even while a web UI tab holds the event stream open', async () => {
    process.env.NUONUO_HOME = mkdtempSync(join(tmpdir(), 'sa-home-'))
    process.env.NUONUO_SECRETS = 'file'
    const config = resolveConfig({ port: 0 })
    const started = await startDaemon(config)
    const port = (started.server.address() as AddressInfo).port
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { authorization: `Bearer ${loadToken(config.home)}` } })
    await res.body!.getReader().read() // the "ready" event: the stream is open and stays open
    const t0 = Date.now()
    await started.stop()
    // Before the fix this waited for the client — which waits for the restart — and never returned.
    expect(Date.now() - t0).toBeLessThan(4_000)
  }, 30_000)
})
