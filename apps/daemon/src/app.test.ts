import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
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
  // Swap in a hub whose models are mocks, keeping the runtime's store and secrets.
  const streaming = () => new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: '你好，' }, { type: 'text-delta', id: '1', delta: '我在。' },
      { type: 'text-end', id: '1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } } },
    ]) }),
    doGenerate: { content: [{ type: 'text', text: '问候' }], finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
      usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } },
  })
  rt.hub = new ModelHub(rt.store, rt.secrets, { language: () => streaming(), embedding: () => { throw new Error('unused') } })
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

  it('streams a reply over SSE, stores both messages, records usage and names the conversation', async () => {
    const { provider } = await (await call('/api/providers', { method: 'POST', body: JSON.stringify({ kind: 'openai', name: 'O', apiKey: 'k' }) })).json() as any
    await call('/api/roles/router', { method: 'PUT', body: JSON.stringify({ chain: [{ providerId: provider.id, model: 'm' }] }) })
    const { conversation } = await (await call('/api/conversations', { method: 'POST', body: '{}' })).json() as any
    const res = await call(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content: '在吗' }) })
    const text = await res.text()
    expect(text).toContain('event: message')
    expect(text).toContain('event: delta')
    expect(text).toContain('event: done')
    const { messages } = await (await call(`/api/conversations/${conversation.id}/messages`)).json() as any
    expect(messages.map((m: any) => [m.role, m.content])).toEqual([['user', '在吗'], ['assistant', '你好，我在。']])
    const usage = await (await call('/api/usage?days=1')).json() as any
    expect(usage.rows[0]).toMatchObject({ role: 'router', inputTokens: 12, outputTokens: 4 })
    await new Promise(r => setTimeout(r, 50))
    const list = await (await call('/api/conversations')).json() as any
    expect(list.conversations[0]).toMatchObject({ title: '问候', lastMessage: '你好，我在。' })
  })
})
