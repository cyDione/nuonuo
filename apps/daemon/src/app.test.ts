import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { generateOf, lastUserText, streamOf, systemText } from '@super-agent/agent-runtime/src/testing'
import { EventMapper, partialString } from './events'
import { ModelHub } from '@super-agent/models'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  process.env.SUPERAGENT_HOME = mkdtempSync(join(tmpdir(), 'sa-home-'))
  process.env.SUPERAGENT_SECRETS = 'file'
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
