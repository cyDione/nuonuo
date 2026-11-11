import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { generateOf, lastUserText, streamOf, systemText } from '@super-assistant/agent-runtime/src/testing'
import { EventMapper, partialString } from './events'
import { ModelHub } from '@super-assistant/models'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { schema } from '@super-assistant/db'
import { createApp } from './app'
import { resolveConfig } from './config'
import { createRuntime, type Runtime } from './runtime'

let rt: Runtime
let app: ReturnType<typeof createApp>
const TOKEN = 'test-token-123456'
const base = 'http://127.0.0.1:7420'
const headers = { host: '127.0.0.1:7420', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const call = (path: string, init: RequestInit = {}) => app.request(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } })

beforeEach(async () => {
  process.env.SUPER_ASSISTANT_HOME = mkdtempSync(join(tmpdir(), 'sa-home-'))
  process.env.SUPER_ASSISTANT_SECRETS = 'file'
  rt = await createRuntime(resolveConfig({ port: 7420 }), { lock: false })
  // Swap in a hub whose models are scripted mocks, keeping the runtime's store and secrets.
  const script = (opts: any) => {
    if (!systemText(opts).includes("You are the owner's personal assistant")) return { text: '问候' }
    if (opts.prompt.at(-1).role === 'tool') return { text: 'done' }
    const cnv = /conversation_id="([a-z]+_[a-z0-9]+)"/.exec(lastUserText(opts))?.[1]
    return { calls: [{ name: 'reply', input: { conversation_id: cnv, text: '你好，我在。' } }] }
  }
  const model = new MockLanguageModelV4({ doStream: async o => streamOf(script(o)), doGenerate: async o => generateOf(script(o)) })
  rt.hub = new ModelHub(rt.store, rt.secrets, { language: () => model, embedding: () => { throw new Error('unused') } })
  ;(rt.agents as any).hub = rt.hub
  ;(rt.engine as any).runtime = rt.agents
  app = createApp(rt, TOKEN)
})
afterEach(async () => { await rt.close() })

describe('access control', () => {
  it('refuses a missing token, a foreign Host and a foreign Origin', async () => {
    expect((await app.request(`${base}/api/health`, { headers: { host: '127.0.0.1:7420' } })).status).toBe(401)
    expect((await call('/api/health', { headers: { host: 'evil.example:7420' } })).status).toBe(403)
    expect((await call('/api/health', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call('/api/health')).status).toBe(200)
  })
  it('accepts any Host when listening on the network, but still wants the token and a same-origin page', async () => {
    const open = createApp(rt, TOKEN, undefined, undefined, undefined)
    ;(rt.config as any).host = '0.0.0.0'
    const lan = createApp(rt, TOKEN)
    ;(rt.config as any).host = '127.0.0.1'
    const h = { host: '192.168.1.5:7420', authorization: `Bearer ${TOKEN}` }
    expect((await open.request('http://192.168.1.5:7420/api/health', { headers: h })).status).toBe(403)
    expect((await lan.request('http://192.168.1.5:7420/api/health', { headers: h })).status).toBe(200)
    expect((await lan.request('http://192.168.1.5:7420/api/health', { headers: { host: h.host } })).status).toBe(401)
    expect((await lan.request('http://192.168.1.5:7420/api/health', { headers: { ...h, origin: 'http://192.168.1.5:7420' } })).status).toBe(200)
    expect((await lan.request('http://192.168.1.5:7420/api/health', { headers: { ...h, origin: 'http://evil.example' } })).status).toBe(403)
  })
  it('serves the desktop app only its window while browser access is off', async () => {
    ;(rt.config as any).desktop = true
    ;(rt.config as any).web = false
    const desktop = createApp(rt, TOKEN)
    expect((await desktop.request(`${base}/auth?token=${TOKEN}`, { headers: { host: '127.0.0.1:7420' } })).status).toBe(403)
    expect((await desktop.request(`${base}/auth?token=${TOKEN}`, { headers: { host: '127.0.0.1:7420', 'x-super-assistant-client': 'desktop' } })).status).toBe(302)
    expect((await desktop.request(`${base}/api/health`, { headers })).status).toBe(200)
  })
  it('saves the listening address for the next start and says a restart is needed', async () => {
    const before = await (await call('/api/system/access')).json() as any
    expect(before).toMatchObject({ running: { host: '127.0.0.1', port: 7420, web: true }, restartNeeded: false, canRestart: false })
    const after = await (await call('/api/system/access', { method: 'PUT', body: JSON.stringify({ host: '0.0.0.0', port: 7500 }) })).json() as any
    expect(after).toMatchObject({ saved: { host: '0.0.0.0', port: 7500 }, restartNeeded: true })
    expect((await call('/api/system/access', { method: 'PUT', body: JSON.stringify({ host: 'not a host' }) })).status).toBe(400)
    expect((await call('/api/system/restart', { method: 'POST' })).status).toBe(409)
  })
  it('trades the login link for an HttpOnly cookie', async () => {
    const res = await app.request(`${base}/auth?token=${TOKEN}`, { headers: { host: '127.0.0.1:7420' } })
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toMatch(/sa_token=.*HttpOnly.*SameSite=Strict/)
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    expect((await app.request(`${base}/api/health`, { headers: { host: '127.0.0.1:7420', cookie } })).status).toBe(200)
  })
})

describe('providers and layers', () => {
  it('creates a provider without echoing its key, configures the router layer, and validates input', async () => {
    const created = await (await call('/api/providers', { method: 'POST', body: JSON.stringify({ kind: 'anthropic', name: 'Claude', apiKey: 'sk-ant-abcd9876' }) })).json() as any
    expect(created.provider).toMatchObject({ name: 'Claude', hasKey: true, keyHint: '…9876' })
    expect(JSON.stringify(created)).not.toContain('sk-ant')
    const bad = await call('/api/providers', { method: 'POST', body: JSON.stringify({ kind: 'openai-compatible', name: 'x' }) })
    expect(bad.status).toBe(400)
    const put = await call('/api/roles/router', { method: 'PUT', body: JSON.stringify({ chain: [{ providerId: created.provider.id, model: 'claude-sonnet-5-5' }] }) })
    expect(put.status).toBe(200)
    const roles = await (await call('/api/roles')).json() as any
    expect(roles.resolved.worker).toMatchObject({ source: 'router', model: { model: 'claude-sonnet-5-5' } })
    expect(roles.resolved.filter).toBeNull()
    expect((await call('/api/roles/nope', { method: 'PUT', body: '{}' })).status).toBe(404)
  })
  it('lists a provider\'s models for a layer without caching, and keeps the suggestions when the list fails', async () => {
    const gw = (await (await call('/api/providers', { method: 'POST', body: JSON.stringify({ kind: 'openai-compatible', name: 'gw', baseUrl: 'http://127.0.0.1:9/v1' }) })).json() as any).provider
    const res = await call(`/api/providers/${gw.id}/models?role=reviewer`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json() as any
    expect(body.models[0]).toBe('jev-latest')
    expect(body.error).toBeTruthy()
    expect((await (await call(`/api/providers/${gw.id}/models?role=router`)).json() as any).models).not.toContain('jev-latest')
    expect((await call(`/api/providers/${gw.id}/models?role=nope`)).status).toBe(400)
    expect((await call('/api/providers/missing/models')).status).toBe(404)
  })
})

describe('conversations', () => {
  it('asks for a router model before chatting', async () => {
    const { conversation } = await (await call('/api/conversations', { method: 'POST', body: '{}' })).json() as any
    const res = await call(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content: 'hi' }) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('no_model')
  })

  it('stores the message as a trigger, lets the router answer it, names the conversation and serves tasks', async () => {
    const { provider } = await (await call('/api/providers', { method: 'POST', body: JSON.stringify({ kind: 'openai', name: 'O', apiKey: 'k' }) })).json() as any
    await call('/api/roles/router', { method: 'PUT', body: JSON.stringify({ chain: [{ providerId: provider.id, model: 'm' }] }) })
    const { conversation } = await (await call('/api/conversations', { method: 'POST', body: '{}' })).json() as any
    const res = await call(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content: '在吗' }) })
    expect(res.status).toBe(201)
    for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 40)); await rt.agents.idle() }
    const { messages } = await (await call(`/api/conversations/${conversation.id}/messages`)).json() as any
    expect(messages.map((m: any) => [m.role, m.content])).toEqual([['user', '在吗'], ['assistant', '你好，我在。']])
    const usage = await (await call('/api/usage?days=1')).json() as any
    expect(usage.rows[0]).toMatchObject({ role: 'router' })
    const list = await (await call('/api/conversations')).json() as any
    expect(list.conversations.find((c: any) => c.id === conversation.id)).toMatchObject({ title: '问候' })
    expect((await (await call('/api/tickets')).json() as any).tickets).toEqual([])
    expect((await call('/api/tickets/tkt_nope')).status).toBe(404)
  })

  it('serves 点子 and their cadence, and refuses to think them up without a model', async () => {
    expect(await (await call('/api/ideas')).json()).toEqual({ batch: null, settings: { cadence: 'daily', hour: 7 } })
    const put = await call('/api/settings/ideas', { method: 'PUT', body: JSON.stringify({ cadence: 'weekly' }) })
    expect(((await put.json()) as any).settings.cadence).toBe('weekly')
    expect((await call('/api/settings/ideas', { method: 'PUT', body: JSON.stringify({ cadence: 'hourly' }) })).status).toBe(400)
    expect((await call('/api/ideas/ida_nope/dismiss', { method: 'POST' })).status).toBe(400)
    expect((await call('/api/ideas/refresh', { method: 'POST' })).status).toBe(400)
  })

  it('searches the conversations and what it remembers, taking % literally', async () => {
    const { conversation } = await (await call('/api/conversations', { method: 'POST', body: '{}' })).json() as any
    rt.store.db.insert(schema.messages).values([
      { id: 'msg_a', conversationId: conversation.id, role: 'user', content: '那帮我盯着 XM6 耳机，降到 2000 以下告诉我', createdAt: 1 },
      { id: 'msg_b', conversationId: conversation.id, role: 'assistant', content: '折扣 100% 是假的', createdAt: 2 },
    ]).run()
    rt.memory.add({ kind: 'profile', text: '你更喜欢头戴式耳机，通勤用', trust: 'user', createdBy: 'owner' })
    const found = await (await call(`/api/search?q=${encodeURIComponent('耳机')}`)).json() as any
    expect(found.messages.map((m: any) => m.id)).toEqual(['msg_a'])
    expect(found.memories[0].text).toContain('头戴式')
    expect(found.artifacts).toEqual([])
    const pct = await (await call(`/api/search?q=${encodeURIComponent('0%')}`)).json() as any
    expect(pct.messages.map((m: any) => m.id)).toEqual(['msg_b'])
    expect((await (await call('/api/search?q=%20')).json() as any).messages).toEqual([])
  })
})

describe('attachments and folder access', () => {
  it('uploads a file, sends it with a quoted message, serves it and lists it for the agent', async () => {
    const { provider } = await (await call('/api/providers', { method: 'POST', body: JSON.stringify({ kind: 'openai', name: 'O', apiKey: 'k' }) })).json() as any
    await call('/api/roles/router', { method: 'PUT', body: JSON.stringify({ chain: [{ providerId: provider.id, model: 'm' }] }) })
    const { conversation } = await (await call('/api/conversations', { method: 'POST', body: '{}' })).json() as any
    rt.store.db.insert(schema.messages).values({ id: 'msg_q', conversationId: conversation.id, role: 'assistant', content: '周五前要交报告', createdAt: 1 }).run()
    const form = new FormData()
    form.set('file', new File([new Uint8Array([137, 80, 78, 71])], '../收据 1.png', { type: 'image/png' }))
    form.set('conversation', conversation.id)
    const up = await app.request(`${base}/api/uploads`, { method: 'POST', body: form, headers: { host: headers.host, authorization: headers.authorization } })
    expect(up.status).toBe(201)
    const { upload } = await up.json() as any
    expect(upload).toMatchObject({ name: '收据 1.png', mime: 'image/png', size: 4 })
    const file = await call(`/api/uploads/${upload.id}`)
    expect(file.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
    expect((await call(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content: '' }) })).status).toBe(400)
    const res = await call(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content: '看看这个', attachments: [upload.id], quote: 'msg_q' }) })
    expect(res.status).toBe(201)
    const { message } = await res.json() as any
    expect(message.meta.attachments).toEqual([{ id: upload.id, name: '收据 1.png', mime: 'image/png', size: 4 }])
    expect(message.meta.quote).toMatchObject({ messageId: 'msg_q' })
    const trigger = rt.store.db.select().from(schema.triggers).all().at(-1)!
    expect(trigger.text).toContain('> 周五前要交报告')
    expect(trigger.text).toContain(`[附件]\n- 收据 1.png（image/png，4B）：${join(rt.uploadsDir, upload.id, '收据 1.png')}`)
    // Sent once: a second send and deleting it are refused.
    expect((await call(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content: 'again', attachments: [upload.id] }) })).status).toBe(400)
    expect((await call(`/api/uploads/${upload.id}`, { method: 'DELETE' })).status).toBe(409)
    await rt.agents.idle()
  })

  it('saves folder and app permissions, keeping the locked never-touch folders', async () => {
    const got = await (await call('/api/settings/access')).json() as any
    expect(got.settings.locked).toContain('~/.ssh')
    const put = await call('/api/settings/access', { method: 'PUT', body: JSON.stringify({ folders: [{ path: '~/Documents', write: true }], never: ['~/.ssh', '~/Taxes'], apps: { calendar: 'auto' } }) })
    const { settings } = await put.json() as any
    expect(settings).toMatchObject({ folders: [{ path: '~/Documents', write: true }], never: ['~/Taxes'], apps: { calendar: 'auto', photos: 'off' } })
    expect((await call('/api/settings/access', { method: 'PUT', body: JSON.stringify({ apps: { mail: 'auto' } }) })).status).toBe(400)
  })
})

describe('reply streaming', () => {
  it('reads partial JSON strings', () => {
    expect(partialString('{"conversation_id":"cnv_1","text":"你好\\n世', 'text')).toBe('你好\n世')
    expect(partialString('{"conversation_id":"cnv_1","text":"a\\u4e16b"}', 'text')).toBe('a世b')
    expect(partialString('{"conversation_id":"cn', 'text')).toBeUndefined()
  })
  it('turns the router reply tool input into reply.delta events', () => {
    const mapper = new EventMapper()
    const part = (p: any) => mapper.map({ type: 'session.part', role: 'router', sessionId: 's', part: p } as any)
    expect(part({ kind: 'tool-input-start', id: 'c1', tool: 'reply' })).toEqual([])
    expect(part({ kind: 'tool-input-delta', id: 'c1', delta: '{"conversation_id":"cnv_a' })).toEqual([])
    expect(part({ kind: 'tool-input-delta', id: 'c1', delta: '","text":"Hel' })).toEqual([{ type: 'reply.delta', conversationId: 'cnv_a', callId: 'c1', text: 'Hel' }])
    expect(part({ kind: 'tool-input-delta', id: 'c1', delta: 'lo"}' })[0]).toMatchObject({ text: 'Hello' })
  })
})
