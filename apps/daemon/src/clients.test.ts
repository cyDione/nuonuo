import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { generateOf, lastUserText, streamOf, systemText } from '@nuonuo/agent-runtime/src/testing'
import { NuonuoClient, NuonuoError, type ClientEvent } from '@nuonuo/client'
import { ModelHub } from '@nuonuo/models'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { deviceNote } from '@nuonuo/core'
import { clientMessage } from './clients'
import { resolveConfig } from './config'
import { createRuntime, type Runtime } from './runtime'

let rt: Runtime
let app: ReturnType<typeof createApp>
let prompts: string[]
const TOKEN = 'test-token-123456'
const base = 'http://127.0.0.1:7420'
/** The SDK's fetch, served by the app in memory. */
const viaApp: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers)
  headers.set('host', '127.0.0.1:7420')
  return Promise.resolve(app.request(String(input), { ...init, headers }))
}
const owner = (path: string, init: RequestInit = {}) => app.request(`${base}${path}`, { ...init,
  headers: { host: '127.0.0.1:7420', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers as object) } })
const code = async (scopes?: string[]) => (await (await owner('/api/devices/pair', { method: 'POST', body: JSON.stringify(scopes ? { scopes } : {}) })).json() as { code: string }).code

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
  app = createApp(rt, TOKEN)
})
afterEach(async () => { await rt.close() })

describe('client protocol v1', () => {
  it('pairs a device with a one-time code', async () => {
    const c = await code()
    const paired = await NuonuoClient.pair(base, c, { name: '客厅音箱', kind: 'speaker' }, { fetch: viaApp })
    expect(paired.token).toMatch(/^nnd_/)
    expect(paired.device).toMatchObject({ name: '客厅音箱', kind: 'speaker', display: 'none', scopes: ['chat', 'notices'] })
    expect(paired.device).not.toHaveProperty('tokenHash')
    // Used once only.
    await expect(NuonuoClient.pair(base, c, { name: 'again' }, { fetch: viaApp })).rejects.toMatchObject({ status: 401, code: 'invalid_code' })
    const list = await (await owner('/api/devices')).json() as { devices: unknown[] }
    expect(list.devices).toHaveLength(1)
  })

  it('locks pairing after too many wrong codes', async () => {
    const good = await code()
    for (let i = 0; i < 10; i++) await NuonuoClient.pair(base, 'AAAA-AAAA', { name: 'x' }, { fetch: viaApp }).catch(() => undefined)
    await expect(NuonuoClient.pair(base, good, { name: 'x' }, { fetch: viaApp })).rejects.toMatchObject({ status: 429 })
  })

  it('keeps the device token and the owner token apart', async () => {
    const { token } = await NuonuoClient.pair(base, await code(), { name: '手机' }, { fetch: viaApp })
    expect((await app.request(`${base}/api/health`, { headers: { host: '127.0.0.1:7420', authorization: `Bearer ${token}` } })).status).toBe(401)
    expect((await app.request(`${base}/client/v1/hello`, { headers: { host: '127.0.0.1:7420', authorization: `Bearer ${TOKEN}` } })).status).toBe(401)
    expect((await app.request(`${base}/client/v1/hello`, { headers: { host: '127.0.0.1:7420' } })).status).toBe(401)
  })

  it('says hello, sends a message and gets the answer', async () => {
    const { token } = await NuonuoClient.pair(base, await code(), { name: '客厅音箱', kind: 'speaker' }, { fetch: viaApp })
    const nuonuo = new NuonuoClient({ baseUrl: base, token, fetch: viaApp })
    const hello = await nuonuo.hello()
    expect(hello).toMatchObject({ protocol: '1.0', server: { name: 'nuonuo' }, mainConversationId: rt.engine.mainConversation() })
    expect(hello.features).toContain('notices')
    expect(hello.features).not.toContain('approvals')
    const reply = await nuonuo.ask('明天要带伞吗？', { timeoutMs: 10_000 })
    expect(reply).toMatchObject({ role: 'assistant', text: '带上吧，下午有雨。', conversationId: hello.mainConversationId })
    // The assistant was told the device has no screen.
    expect(prompts.at(-1)).toContain('没有屏幕')
    const history = await nuonuo.messages('main')
    expect(history.find(m => m.role === 'user')).toMatchObject({ text: '明天要带伞吗？', device: { name: '客厅音箱', kind: 'speaker' } })
  })

  it('does not send the same message twice for one clientId', async () => {
    const { token } = await NuonuoClient.pair(base, await code(), { name: '手机', kind: 'phone' }, { fetch: viaApp })
    const nuonuo = new NuonuoClient({ baseUrl: base, token, fetch: viaApp })
    const a = await nuonuo.send('你好', { clientId: 'same-1' })
    const b = await nuonuo.send('你好', { clientId: 'same-1' })
    expect(b.id).toBe(a.id)
    expect((await nuonuo.messages('main')).filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('streams message events', async () => {
    const { token } = await NuonuoClient.pair(base, await code(), { name: '手表', kind: 'watch' }, { fetch: viaApp })
    const nuonuo = new NuonuoClient({ baseUrl: base, token, fetch: viaApp })
    const abort = new AbortController()
    const seen: ClientEvent[] = []
    const done = (async () => {
      for await (const e of nuonuo.events({ signal: abort.signal })) {
        seen.push(e)
        if (e.type === 'ready') void nuonuo.send('几点了')
        if (e.type === 'message' && e.message.role === 'assistant') abort.abort()
      }
    })()
    await Promise.race([done, new Promise(r => setTimeout(r, 10_000))])
    abort.abort()
    expect(seen[0]).toMatchObject({ type: 'ready', protocol: '1.0' })
    expect(seen.some(e => e.type === 'message' && e.message.role === 'user' && e.message.text === '几点了')).toBe(true)
    expect(seen.some(e => e.type === 'message' && e.message.role === 'assistant')).toBe(true)
  })

  it('enforces scopes, and a revoked device is out', async () => {
    const { token, device } = await NuonuoClient.pair(base, await code(['chat']), { name: '车机', kind: 'car' }, { fetch: viaApp })
    const nuonuo = new NuonuoClient({ baseUrl: base, token, fetch: viaApp })
    await expect(nuonuo.approvals()).rejects.toMatchObject({ status: 403 })
    expect((await owner(`/api/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify({ scopes: ['approvals'] }) })).status).toBe(200)
    expect(await nuonuo.approvals()).toEqual([])
    expect((await owner(`/api/devices/${device.id}`, { method: 'DELETE' })).status).toBe(204)
    const error = await nuonuo.hello().catch(e => e)
    expect(error).toBeInstanceOf(NuonuoError)
    expect(error.status).toBe(401)
  })

  it('lets a device unpair itself, answers CORS preflight and 404s unknown paths', async () => {
    const { token } = await NuonuoClient.pair(base, await code(), { name: '网页' }, { fetch: viaApp })
    const nuonuo = new NuonuoClient({ baseUrl: base, token, fetch: viaApp })
    const pre = await viaApp(`${base}/client/v1/hello`, { method: 'OPTIONS', headers: { origin: 'https://app.example' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
    const other = await viaApp(`${base}/client/v1/hello`, { headers: { origin: 'https://app.example', authorization: `Bearer ${token}` } })
    expect(other.status).toBe(200)
    expect((await viaApp(`${base}/client/v1/nope`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    await nuonuo.forget()
    await expect(nuonuo.hello()).rejects.toMatchObject({ status: 401 })
  })

  it('tells the assistant about small and missing screens only', () => {
    expect(deviceNote({ id: 'd', name: '手表', kind: 'watch', display: 'small' })).toContain('屏幕很小')
    expect(deviceNote({ id: 'd', name: '手机', kind: 'phone', display: 'full' })).toBe('')
  })

  it('marks "I am on it" messages as not final while their task works', () => {
    const m = (meta: Record<string, unknown> = {}, ticketId: string | null = 'tkt_1') =>
      ({ id: 'msg_1', conversationId: 'cnv_1', role: 'assistant', content: '好，我查一下', meta, ticketId, triggerId: null, createdAt: 1 }) as any
    const working = () => ({ title: '查天气', ended: null, attention: null })
    expect(clientMessage(m(), working)).toMatchObject({ final: false, task: { id: 'tkt_1', title: '查天气', state: 'working' } })
    expect(clientMessage(m({ result: { summary: 'x' } }), working)!.final).toBe(true)
    expect(clientMessage(m(), () => ({ title: 't', ended: { at: 1 }, attention: null }))!.task!.state).toBe('done')
    expect(clientMessage(m(), () => ({ title: 't', ended: null, attention: { kind: 'question' } }))).toMatchObject({ final: true, task: { state: 'waiting' } })
    expect(clientMessage(m({}, null))).toMatchObject({ final: true, task: null })
  })
})
