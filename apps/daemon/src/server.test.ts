import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { LOCAL_ADMIN_HEADER } from './auth'
import { resolveConfig } from './config'
import { startDaemon } from './server'

describe('daemon server lifecycle & headless --web gate', () => {
  it('stops cleanly while a client holds /v1/events open, and disables WebUI unless --web is enabled', async () => {
    process.env.NUONUO_HOME = mkdtempSync(join(tmpdir(), 'sa-home-'))
    process.env.NUONUO_SECRETS = 'file'
    const config = resolveConfig({ port: 0 })
    expect(config.web).toBe(false)
    const started = await startDaemon(config)
    const port = (started.server.address() as AddressInfo).port

    // Headless by default: root WebUI returns 404 web_ui_disabled, while /v1/auth/methods answers 200.
    const rootRes = await fetch(`http://127.0.0.1:${port}/`)
    expect(rootRes.status).toBe(404)
    expect((await rootRes.json() as any).error.code).toBe('web_ui_disabled')

    const methodsRes = await fetch(`http://127.0.0.1:${port}/v1/auth/methods`)
    expect(methodsRes.status).toBe(200)
    expect((await methodsRes.json() as any).webUi).toBe(false)

    // Hold SSE stream open and verify graceful shutdown finishes promptly.
    const res = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { [LOCAL_ADMIN_HEADER]: started.localAdminKey } })
    expect(res.status).toBe(200)
    await res.body!.getReader().read()
    const t0 = Date.now()
    await started.stop()
    expect(Date.now() - t0).toBeLessThan(4_000)
  }, 30_000)
})
