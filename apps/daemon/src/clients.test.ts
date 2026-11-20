import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { generateOf, lastUserText, streamOf, systemText } from '@nuonuo/agent-runtime/src/testing'
import { NuonuoClient, parsePairUri, type ClientEvent } from '@nuonuo/client'
import { ModelHub } from '@nuonuo/models'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { LOCAL_ADMIN_HEADER } from './auth'
import { resolveConfig } from './config'
import { createRuntime, type Runtime } from './runtime'

let rt: Runtime
let app: ReturnType<typeof createApp>
let prompts: string[]
const LOCAL_KEY = 'local-cli-admin-test-key'
const base = 'http://127.0.0.1:7420'

const viaApp: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers)
  headers.set('host', '127.0.0.1:7420')
  return Promise.resolve(app.request(String(input), { ...init, headers }))
}

const adminCall = (path: string, init: RequestInit = {}) => app.request(`${base}${path}`, {
  ...init,
  headers: { host: '127.0.0.1:7420', [LOCAL_ADMIN_HEADER]: LOCAL_KEY, 'content-type': 'application/json', ...(init.headers as object) },
})

const makePairCode = async (opts: { scopes?: string[]; admin?: boolean } = {}) => {
  const res = await adminCall('/v1/auth/pair/codes', { method: 'POST', body: JSON.stringify(opts) })
  expect(res.status).toBe(201)
  return (await res.json()) as { code: string; uri: string; qrSvg: string; scopes: string[] }
}

beforeEach(async () => {
  process.env.NUONUO_HOME = mkdtempSync(join(tmpdir(), 'sa-home-'))
  process.env.NUONUO_SECRETS = 'file'
  rt = await createRuntime(resolveConfig({ port: 7420 }), { lock: false })
  prompts = []
  const script = (opts: any) => {
    if (!systemText(opts).includes("You are the owner's personal assistant")) return { text: '问候' }
    if (opts.prompt.at(-1).role === 'tool') return { text: 'done' }
    const text = lastUserText(opts)
    prompts.push(text)
    const cnv = /conversation_id="([a-z]+_[a-z0-9]+)"/.exec(text)?.[1]
    return { calls: [{ name: 'reply', input: { conversation_id: cnv, text: '带上吧，下午有雨。' } }] }
  }
  const model = new MockLanguageModelV4({ doStream: async o => streamOf(script(o)), doGenerate: async o => generateOf(script(o)) })
  rt.hub = new ModelHub(rt.store, rt.secrets, { language: () => model, embedding: () => { throw new Error('unused') } })
  ;(rt.agents as any).hub = rt.hub
  ;(rt.engine as any).runtime = rt.agents
  const provider = rt.hub.createProvider({ kind: 'anthropic', name: 'A', apiKey: 'k' })
  rt.hub.saveRole('router', { enabled: true, chain: [{ providerId: provider.id, model: 'm' }] })
  app = createApp(rt, LOCAL_KEY)
})
afterEach(async () => { await rt.close() })

describe('unified /v1 client protocol & @nuonuo/client SDK', () => {
  it('discovers auth methods, pairs via QR URI / one-time code, and enforces scope isolation', async () => {
    const methods = await NuonuoClient.discover(base, { fetch: viaApp })
    expect(methods).toMatchObject({ protocol: '2.0', webUi: false, methods: { pairing: true, password: false, passkey: false } })

    const issued = await makePairCode()
    expect(issued.qrSvg).toContain('<svg')
    const parsed = parsePairUri(issued.uri)
    expect(parsed).toEqual({ server: base, code: issued.code })

    const paired = await NuonuoClient.pair(parsed!.server, parsed!.code, { name: '客厅音箱', kind: 'speaker' }, { fetch: viaApp })
    expect(paired.accessToken).toMatch(/^nna_/)
    expect(paired.refreshToken).toMatch(/^nnr_/)
    expect(paired.device).toMatchObject({ name: '客厅音箱', kind: 'speaker', display: 'none', scopes: ['chat', 'notices'] })

    // Pairing code cannot be reused.
    await expect(NuonuoClient.pair(base, issued.code, { name: 'again' }, { fetch: viaApp })).rejects.toMatchObject({ status: 401, code: 'invalid_code' })

    // Scope isolation: light device cannot call admin endpoints (`/v1/providers`, `/v1/devices`).
    const speaker = new NuonuoClient({ baseUrl: base, accessToken: paired.accessToken, refreshToken: paired.refreshToken, fetch: viaApp })
    await expect(speaker.devices()).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(speaker.request('GET', '/providers')).rejects.toMatchObject({ status: 403, code: 'forbidden' })

    // Admin device can manage devices and providers.
    const adminPair = await makePairCode({ admin: true })
    const adminAuth = await NuonuoClient.pair(base, adminPair.code, { name: 'My Mac', kind: 'desktop' }, { fetch: viaApp })
    const desktop = new NuonuoClient({ baseUrl: base, accessToken: adminAuth.accessToken, refreshToken: adminAuth.refreshToken, fetch: viaApp })
    expect((await desktop.devices()).length).toBe(2)
  })

  it('auto-rotates refresh token seamlessly when access token is missing or stale', async () => {
    const { code } = await makePairCode({ admin: true })
    const auth = await NuonuoClient.pair(base, code, { name: 'Mobile', kind: 'phone' }, { fetch: viaApp })
    let updatedRefresh = ''
    // Pass a stale/invalid access token alongside a valid refresh token -> client must auto-refresh once and succeed!
    const client = new NuonuoClient({
      baseUrl: base,
      accessToken: 'nna_expired.sig',
      refreshToken: auth.refreshToken,
      onTokensUpdated: next => { updatedRefresh = next.refreshToken },
      fetch: viaApp,
    })
    const hello = await client.hello()
    expect(hello.protocol).toBe('2.0')
    expect(updatedRefresh).toMatch(/^nnr_/)
    expect(updatedRefresh).not.toBe(auth.refreshToken)
  })

  it('supports password login, ask/idempotency, and SSE streaming via @nuonuo/client', async () => {
    rt.auth.setPassword('super-secure-password')
    const auth = await NuonuoClient.loginWithPassword(base, 'super-secure-password', { name: '客厅音箱', kind: 'speaker' }, { fetch: viaApp })
    const nuonuo = new NuonuoClient({ baseUrl: base, accessToken: auth.accessToken, refreshToken: auth.refreshToken, fetch: viaApp })

    const reply = await nuonuo.ask('明天要带伞吗？', { timeoutMs: 10_000 })
    expect(reply).toMatchObject({ role: 'assistant', text: '带上吧，下午有雨。' })
    expect(prompts.at(-1)).toContain('没有屏幕')

    // Idempotency by clientId.
    const a = await nuonuo.send('你好', { clientId: 'same-1' })
    const b = await nuonuo.send('你好', { clientId: 'same-1' })
    expect(b.id).toBe(a.id)

    // SSE stream.
    const abort = new AbortController()
    const seen: ClientEvent[] = []
    const done = (async () => {
      for await (const e of nuonuo.events({ signal: abort.signal })) {
        seen.push(e)
        if (e.type === 'ready') void nuonuo.send('几点了')
        if (e.type === 'message' && e.message?.role === 'assistant') abort.abort()
      }
    })()
    await Promise.race([done, new Promise(r => setTimeout(r, 10_000))])
    abort.abort()
    expect(seen[0]).toMatchObject({ type: 'ready', protocol: '2.0' })
    expect(seen.some(e => e.type === 'message' && e.message?.role === 'assistant')).toBe(true)

    // Logout invalidates the session immediately.
    await nuonuo.logout()
    await expect(nuonuo.hello()).rejects.toMatchObject({ status: 401 })
  })
})
