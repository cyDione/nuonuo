import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { generateOf, lastUserText, streamOf, systemText } from '@nuonuo/agent-runtime/src/testing'
import { EventMapper, partialString } from './events'
import { ModelHub } from '@nuonuo/models'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { schema } from '@nuonuo/db'
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
  process.env.NUONUO_HOME = mkdtempSync(join(tmpdir(), 'sa-home-'))
  process.env.NUONUO_SECRETS = 'file'
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
    expect((await desktop.request(`${base}/auth?token=${TOKEN}`, { headers: { host: '127.0.0.1:7420', 'x-nuonuo-client': 'desktop' } })).status).toBe(302)
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
    expect(roles.defaults).toMatchObject({ router: 'auto', voice: 'none', worker: 'high', subagent: 'high', reviewer: 'low', watchdog: 'low', summarizer: 'auto', filter: 'none' })
    expect(roles.resolved.router).toMatchObject({ source: 'router', effectiveReasoning: 'auto', defaultReasoning: 'auto', reasoningInfo: { supported: true, canDisable: true } })
    expect(roles.resolved.voice).toMatchObject({ source: 'router', model: { model: 'claude-sonnet-5-5' }, effectiveReasoning: 'none', defaultReasoning: 'none' })
    expect(roles.resolved.worker).toMatchObject({ source: 'router', model: { model: 'claude-sonnet-5-5' }, effectiveReasoning: 'high', defaultReasoning: 'high' })
    expect(roles.resolved.filter).toBeNull()
    const rInfo = await (await call(`/api/models/reasoning-info?providerId=${created.provider.id}&model=gemini-4-argon-high`)).json() as any
    expect(rInfo).toEqual({ supported: false, fixedById: true, canDisable: false, levels: [] })
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

describe('Muse features (backend)', () => {
  const withModel = async () => {
    const { provider } = await (await call('/api/providers', { method: 'POST', body: JSON.stringify({ kind: 'openai', name: 'O', apiKey: 'k' }) })).json() as any
    await call('/api/roles/router', { method: 'PUT', body: JSON.stringify({ chain: [{ providerId: provider.id, model: 'm' }] }) })
  }
  const json = (method: string, b: unknown) => ({ method, body: JSON.stringify(b) })

  it('keeps 👍/👎/收藏 on 动态 and tells the agent the taste', async () => {
    const item = rt.feed.post({ title: 'XM6 降价了' })
    const up = await (await call(`/api/feed/${item.id}/react`, json('POST', { reaction: 'up' }))).json() as any
    expect(up.item.reaction).toBe('up')
    expect((await (await call(`/api/feed/${item.id}/save`, json('POST', { saved: true }))).json() as any).item.saved).toBe(true)
    expect(rt.feed.taste()).toContain('👍 XM6 降价了')
    const other = rt.feed.post({ title: '天气' })
    await call(`/api/feed/${other.id}/react`, json('POST', { reaction: 'down' }))
    expect(rt.feed.list().map(i => i.id)).toEqual([item.id])
    // 撤销 a 👎 brings the item back.
    await call(`/api/feed/${other.id}/react`, json('POST', { reaction: null }))
    expect(rt.feed.list().map(i => i.id).sort()).toEqual([item.id, other.id].sort())
  })

  it('adds steps under a goal and keeps the dragged order', async () => {
    const a = rt.goals.create({ title: '攒钱买相机', target: 12000, unit: '元' })
    const b = rt.goals.create({ title: '睡得更早', style: 'days', target: 21 })
    const step = await call('/api/goals', json('POST', { title: '每月存 2000', target: 6, unit: '次', parentId: a.id }))
    expect(step.status).toBe(201)
    const { goal } = await step.json() as any
    expect((await call('/api/goals', json('POST', { title: 'x', target: 1, parentId: goal.id }))).status).toBe(400)
    const order = await (await call('/api/goals/order', json('PUT', { ids: [b.id, a.id] }))).json() as any
    expect(order.goals.map((g: any) => g.title)).toEqual(['睡得更早', '攒钱买相机', '每月存 2000'])
    expect(rt.goals.describe()).toMatch(/攒钱买相机.*\n  └ .*每月存 2000/)
    rt.goals.remove(a.id)
    expect(rt.goals.list().map(g => g.title)).toEqual(['睡得更早'])
  })

  it('takes back, edits and regenerates messages', async () => {
    await withModel()
    const { conversation } = await (await call('/api/conversations', { method: 'POST', body: '{}' })).json() as any
    const { message } = await (await call(`/api/conversations/${conversation.id}/messages`, json('POST', { content: '订明天的票' }))).json() as any
    const edited = await call(`/api/messages/${message.id}/edit`, json('POST', { content: '订后天的票' }))
    expect(edited.status).toBe(201)
    const old = rt.store.db.select().from(schema.messages).all().find(m => m.id === message.id)!
    expect(old).toMatchObject({ content: '', meta: { recalled: true, edited: true } })
    expect((await call(`/api/messages/${message.id}/recall`, { method: 'POST' })).status).toBe(409)
    for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 40)); await rt.agents.idle() }
    const reply = rt.store.db.select().from(schema.messages).all().find(m => m.role === 'assistant')!
    expect((await call(`/api/messages/${reply.id}/regenerate`, { method: 'POST' })).status).toBe(200)
    expect(rt.store.db.select().from(schema.messages).all().find(m => m.id === reply.id)!.meta).toMatchObject({ superseded: true })
    await rt.agents.idle()
  })

  it('puts 带你去 links and cards on the assistant\'s message', () => {
    const cnv = rt.engine.mainConversation()
    const id = rt.engine.reply({ conversationId: cnv, text: '在这里改', extra: { open: { route: 'pane/permissions', label: '打开权限' } } })
    expect(rt.store.db.select().from(schema.messages).all().find(m => m.id === id)!.meta).toMatchObject({ open: { route: 'pane/permissions' } })
  })

  it('lists a routine\'s runs', async () => {
    const routine = rt.routines.create({ name: '早报', schedule: '0 8 * * *', prompt: '说说今天' })
    await call(`/api/routines/${routine.id}/run`, { method: 'POST' })
    const { runs } = await (await call(`/api/routines/${routine.id}/runs`)).json() as any
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ ok: true })
    await rt.agents.idle()
  })

  it('keeps 会做的事: the owner\'s are on, the assistant\'s wait to be switched on', async () => {
    const res = await call('/api/skills', json('POST', { name: '整理周报', when: '主人说写周报', steps: '- 看日历\n- 看提交' }))
    expect(res.status).toBe(201)
    const { skill } = await res.json() as any
    expect(skill).toMatchObject({ enabled: true, by: 'owner' })
    const proposed = rt.skills.create({ name: '订餐', when: '订外卖', steps: '- 先问忌口' }, 'assistant')
    expect(proposed.enabled).toBe(false)
    expect((await (await call(`/api/skills/${proposed.id}`, json('PATCH', { enabled: true }))).json() as any).skill.enabled).toBe(true)
    expect((await call('/api/skills', json('POST', { name: '整理周报', when: 'x', steps: 'y' }))).status).toBe(400)
  })

  it('imports memories from another assistant after a preview', async () => {
    const text = '以下是我记得的关于你的内容：\n- 住在杭州\n- 喜欢简短的回答\n\n## 工作方式\n1. 先给结论'
    const { items } = await (await call('/api/memories/import/preview', json('POST', { text }))).json() as any
    expect(items).toEqual([{ kind: 'profile', text: '住在杭州' }, { kind: 'profile', text: '喜欢简短的回答' }, { kind: 'lesson', text: '先给结论' }])
    const done = await (await call('/api/memories/import', json('POST', { items: items.slice(0, 2) }))).json() as any
    expect(done).toEqual({ added: 2, existing: 0, skipped: 0 })
  })

  it('has mood on by default, records stopping a task as a faint mood signal, and stays quiet when switched off', async () => {
    const before = ((await (await call('/api/mood')).json()) as any).mood
    expect(before.enabled).toBe(true)
    const cnv = rt.engine.mainConversation()
    const trig = rt.engine.receiveMessage(cnv, '帮我查一下')
    const ticket = rt.engine.startTask({ conversationId: cnv, triggerIds: [trig.triggerId], title: '查机票' })
    const stopRes = await call(`/api/tickets/${ticket.id}/stop`, { method: 'POST' })
    expect(stopRes.status).toBe(200)
    const after = ((await (await call('/api/mood')).json()) as any).mood
    expect(after.patience).toBe(before.patience - 2)
    expect(after.mood).toBeLessThan(before.mood)
    expect(after.history.at(-1)).toMatchObject({ attitude: 'stopped', note: '停下「查机票」' })

    await call('/api/mood', json('PUT', { enabled: false }))
    expect(((await (await call('/api/mood')).json()) as any).mood.enabled).toBe(false)
    const trig2 = rt.engine.receiveMessage(cnv, '再查一下')
    const ticket2 = rt.engine.startTask({ conversationId: cnv, triggerIds: [trig2.triggerId], title: '订酒店' })
    await call(`/api/tickets/${ticket2.id}/stop`, { method: 'POST' })
    expect(((await (await call('/api/mood')).json()) as any).mood.history).toHaveLength(after.history.length)
  })

  it('persists 2D voice tone via PUT /api/mood with origin snapping and exposes cleaned multi-bubble replies on /api/conversations/:id/messages', async () => {
    const initial = ((await (await call('/api/mood')).json()) as any).mood
    expect(initial.tone).toEqual({ x: 0, y: 0, id: 'natural', label: '自然', strength: 0 })

    // Four corners: 温和 (-1, +1), 风趣 (+1, +1), 沉静 (-1, -1), 犀利 (+1, -1)
    const warm = ((await (await call('/api/mood', json('PUT', { tone: { x: -0.8, y: 0.6 } }))).json()) as any).mood
    expect(warm.tone).toEqual({ x: -0.8, y: 0.6, id: 'warm', label: '温和', strength: 100 })

    const witty = ((await (await call('/api/mood', json('PUT', { tone: { x: 0.6, y: 0.8 } }))).json()) as any).mood
    expect(witty.tone).toEqual({ x: 0.6, y: 0.8, id: 'witty', label: '风趣', strength: 100 })

    const calm = ((await (await call('/api/mood', json('PUT', { tone: { x: -0.6, y: -0.8 } }))).json()) as any).mood
    expect(calm.tone).toEqual({ x: -0.6, y: -0.8, id: 'calm', label: '沉静', strength: 100 })

    const sharp = ((await (await call('/api/mood', json('PUT', { tone: { x: 0.8, y: -0.6 } }))).json()) as any).mood
    expect(sharp.tone).toEqual({ x: 0.8, y: -0.6, id: 'sharp', label: '犀利', strength: 100 })

    // Snap near origin (< 0.06) to (0, 0) 自然
    const snapped = ((await (await call('/api/mood', json('PUT', { tone: { x: 0.03, y: -0.04 } }))).json()) as any).mood
    expect(snapped.tone).toEqual({ x: 0, y: 0, id: 'natural', label: '自然', strength: 0 })

    // Multi-bubble reply is cleaned and exposed in Message.meta.bubbles
    const cnv = rt.engine.mainConversation()
    const msgId = rt.engine.reply({ conversationId: cnv, bubbles: ['搞定了。', '（微笑）测试也全过了。'] })
    const codeSnippet = '```ts\nconst status = 200;\n```'
    const codeMsgId = rt.engine.reply({ conversationId: cnv, bubbles: ['（叹气）配置漏了一行。', codeSnippet] })
    const { messages } = await (await call(`/api/conversations/${cnv}/messages`)).json() as any
    const bubbleMsg = messages.find((m: any) => m.id === msgId)
    expect(bubbleMsg).toMatchObject({
      content: '搞定了\n测试也全过了',
      meta: { bubbles: ['搞定了', '测试也全过了'] },
    })
    const codeMsg = messages.find((m: any) => m.id === codeMsgId)
    expect(codeMsg).toMatchObject({
      content: `配置漏了一行\n${codeSnippet}`,
      meta: { bubbles: ['配置漏了一行', codeSnippet] },
    })
  })
})

describe('non-streaming complete replies', () => {
  it('reads partial JSON strings', () => {
    expect(partialString('{"conversation_id":"cnv_1","text":"你好\\n世', 'text')).toBe('你好\n世')
    expect(partialString('{"conversation_id":"cnv_1","text":"a\\u4e16b"}', 'text')).toBe('a世b')
    expect(partialString('{"conversation_id":"cn', 'text')).toBeUndefined()
  })
  it('does not emit reply.delta events while the router streams reply tool input, showing only complete saved replies', () => {
    const mapper = new EventMapper()
    const part = (p: any) => mapper.map({ type: 'session.part', role: 'router', sessionId: 's', part: p } as any)
    expect(part({ kind: 'tool-input-start', id: 'c1', tool: 'reply' })).toEqual([])
    expect(part({ kind: 'tool-input-delta', id: 'c1', delta: '{"conversation_id":"cnv_a' })).toEqual([])
    expect(part({ kind: 'tool-input-delta', id: 'c1', delta: '","text":"Hel' })).toEqual([])
    expect(part({ kind: 'tool-input-delta', id: 'c1', delta: 'lo"}' })).toEqual([])
    expect(mapper.map({ type: 'session.state', role: 'router', sessionId: 's', ticketId: null, state: 'running' })).toEqual([
      { type: 'session.state', role: 'router', sessionId: 's', ticketId: null, state: 'running' },
    ])
    expect(mapper.map({ type: 'message.created', conversationId: 'cnv_a', messageId: 'msg_1' })).toEqual([
      { type: 'message.created', conversationId: 'cnv_a', messageId: 'msg_1' },
    ])
  })
  it('returns strictly one complete reply without duplicate bubbles for the 13:42 更新情况 scenario', async () => {
    const cnv = rt.engine.mainConversation()
    const finalText = 'nuonuo 两天连发 5 版，重心全在「浏览器 + 图形云电脑」：\n\n- **v0.3.4**（今天 12:24）：切到原生桌面 Chromium。'
    const id1 = rt.engine.reply({ conversationId: cnv, text: finalText, callId: 'chatcmpl-tool-910cd5b7241f962a' })
    const id2 = rt.engine.reply({ conversationId: cnv, text: finalText, callId: 'chatcmpl-tool-910cd5b7241f962a' })
    const id3 = rt.engine.reply({ conversationId: cnv, text: finalText, callId: 'chatcmpl-tool-another' })
    expect(id2).toBe(id1)
    expect(id3).toBe(id1)
    const { messages } = await (await call(`/api/conversations/${cnv}/messages`)).json() as any
    expect(messages.filter((m: any) => m.role === 'assistant' && m.content === finalText)).toHaveLength(1)
  })
})

describe('unified browsers & cloud desktop endpoints', () => {
  const json = (method: string, b: unknown) => ({ method, body: JSON.stringify(b) })

  it('drives native cloud desktop Chromium Web Browser, desktop stream, screenshots, takeover input, and ticket resume on return', async () => {
    const controls: string[] = []
    const browserCalls: Record<string, unknown>[] = []
    const openDesktopCalls: Array<{ url?: string; owner?: boolean }> = []
    const desktopInputs: unknown[] = []
    let desktopRunning = true
    let desktopTitle = '登录页'
    let desktopUrl = 'https://example.com/login'
    let handoffActive = false
    const fakePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

    const cnv = rt.engine.mainConversation()
    const trig = rt.engine.receiveMessage(cnv, '登录后台看看')
    rt.engine.startTask({ conversationId: cnv, triggerIds: [trig.triggerId], title: '查看后台' })

    const fakeComp = {
      id: 'instabox',
      title: 'Instabox 云电脑',
      pluginId: 'instabox',
      capabilities: {
        sudo: true,
        docker: true,
        sleeps: true,
        dataDir: '/data',
        maxExecSeconds: 600,
        desktop: { display: ':1', width: 1280, height: 800 },
      },
      status: async () => ({ state: 'ready' as const, name: 'box-1' }),
      wake: async () => ({ state: 'ready' as const }),
      exec: async (req: { command: string }) => ({
        exitCode: 0,
        stdout: req.command.includes('__nuonuo_ok__') ? '__nuonuo_ok__\n' : '',
        stderr: '',
      }),
      startDesktop: async () => {},
      desktopUrl: async (opts?: { viewOnly?: boolean }) => ({
        url: `https://stream.instabox.test/s1?ro=${Boolean(opts?.viewOnly)}`,
        expiresAt: '2099-01-01T00:00:00Z',
      }),
      desktopControl: async (action: 'takeover' | 'handback') => { controls.push(action) },
    }
    ;(rt.computers as any).list = () => [fakeComp]
    ;(rt.computers as any).ready = async () => {}
    ;(rt.computers as any).ensureDesktop = async () => {}
    ;(rt.computers as any).focusBrowserWindow = async () => {}
    ;(rt.computers as any).setDesktopHandoff = (_c: unknown, active: boolean) => { handoffActive = active }
    ;(rt.computers as any).desktopBrowserStatus = async () => ({
      running: desktopRunning,
      title: desktopRunning ? desktopTitle : '',
      url: desktopRunning ? desktopUrl : '',
      handoff: handoffActive,
    })
    ;(rt.computers as any).openDesktopBrowser = async (_c: unknown, url?: string, opts?: { owner?: boolean }) => {
      openDesktopCalls.push({ ...(url !== undefined ? { url } : {}), ...(opts?.owner !== undefined ? { owner: opts.owner } : {}) })
      desktopRunning = true
      if (url && url !== 'about:blank') {
        desktopUrl = url
        desktopTitle = 'Opened'
      }
      return { running: true, title: desktopTitle, url: desktopUrl }
    }
    ;(rt.computers as any).closeDesktopBrowser = async () => {
      desktopRunning = false
      desktopTitle = ''
      desktopUrl = ''
      handoffActive = false
      return true
    }
    ;(rt.computers as any).desktopScreenshot = async () => fakePng
    ;(rt.computers as any).desktopInput = async (_c: unknown, action: unknown) => { desktopInputs.push(action) }
    ;(rt.computers as any).browser = async (_c: unknown, req: Record<string, any>) => {
      browserCalls.push(req)
      return {}
    }

    // 1. Desktop stream & desktop screenshot
    const deskStream = await (await call('/api/computers/instabox/desktop', json('POST', { viewOnly: true }))).json() as any
    expect(deskStream).toEqual({ ok: true, url: 'https://stream.instabox.test/s1?ro=true', expiresAt: '2099-01-01T00:00:00Z' })
    const deskShot = await call('/api/computers/instabox/desktop/screenshot')
    expect(deskShot.status).toBe(200)
    expect(deskShot.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await deskShot.arrayBuffer()).equals(fakePng)).toBe(true)

    // 2. List browsers (via native desktopBrowserStatus, never calling browserd)
    const listed = await (await call('/api/browsers')).json() as any
    const tabKey = 'cloud:instabox:desktop:browser'
    expect(listed).toEqual({
      available: true,
      computer: { id: 'instabox', title: 'Instabox 云电脑', state: 'ready', hasDesktop: true },
      pages: [{
        key: tabKey,
        kind: 'cloud',
        computerId: 'instabox',
        browser: 'desktop',
        tab: 'browser',
        title: '登录页',
        url: 'https://example.com/login',
        handoff: false,
        hasDesktop: true,
      }],
    })
    const compBrowsers = await (await call('/api/computers/instabox/browsers')).json() as any
    expect(compBrowsers).toEqual({
      asleep: false,
      browsers: [{ name: 'desktop', idleSeconds: 0, tabs: [{ name: 'browser', title: '登录页', url: 'https://example.com/login', handoff: false }] }],
    })
    expect(browserCalls).toEqual([])

    // 3. Open URL (auto-prepending https://) and blank default browser activation
    const openedBlank = await (await call('/api/browsers/open', json('POST', {}))).json() as any
    expect(openedBlank).toEqual({
      key: tabKey,
      url: '',
      hasDesktop: true,
      computerId: 'instabox',
    })
    expect(openDesktopCalls.at(-1)).toEqual({ owner: true })

    const opened = await (await call('/api/browsers/open', json('POST', { url: 'example.org/path' }))).json() as any
    expect(opened).toEqual({
      key: tabKey,
      url: 'https://example.org/path',
      hasDesktop: true,
      computerId: 'instabox',
    })
    expect(openDesktopCalls.at(-1)).toEqual({ url: 'https://example.org/path', owner: true })

    // 4. Page screenshot returns desktop PNG screenshot
    const pageShot = await call(`/api/browsers/screenshot?key=${encodeURIComponent(tabKey)}`)
    expect(pageShot.status).toBe(200)
    expect(pageShot.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await pageShot.arrayBuffer()).equals(fakePng)).toBe(true)

    // 5. Handoff -> page input & desktop input -> return (resumes ticket!)
    const ho = await (await call('/api/browsers/handoff', json('POST', { key: tabKey }))).json() as any
    expect(ho).toEqual({ ok: true, url: 'https://example.org/path', title: 'Opened', hasDesktop: true, computerId: 'instabox' })
    expect(handoffActive).toBe(true)
    expect(controls).toEqual(['takeover'])

    const inpPage = await (await call('/api/browsers/input', json('POST', {
      key: tabKey, mode: 'page', action: { type: 'goto', url: 'example.com/dashboard' },
    }))).json() as any
    expect(inpPage).toEqual({ ok: true, url: 'https://example.com/dashboard', title: 'Opened', key: tabKey })

    // desktop:root handoff, goto (opens native desktop browser), and return
    const hoRoot = await (await call('/api/browsers/handoff', json('POST', { key: 'cloud:instabox:desktop:root' }))).json() as any
    expect(hoRoot).toEqual({ ok: true, url: '', title: 'Instabox 云电脑', hasDesktop: true, computerId: 'instabox' })
    const gotoRoot = await (await call('/api/browsers/input', json('POST', {
      key: 'cloud:instabox:desktop:root', mode: 'desktop', action: { type: 'goto', url: 'baidu.com' },
    }))).json() as any
    expect(gotoRoot).toEqual({ ok: true, url: 'https://baidu.com/', title: 'Opened', key: tabKey })
    const retRoot = await (await call('/api/browsers/return', json('POST', { key: 'cloud:instabox:desktop:root' }))).json() as any
    expect(retRoot).toEqual({ ok: true })

    const inpDesk = await (await call('/api/browsers/input', json('POST', {
      key: tabKey, mode: 'desktop', action: { type: 'key', key: 'Control+a' },
    }))).json() as any
    expect(inpDesk).toEqual({ ok: true })
    expect(desktopInputs).toEqual([{ type: 'key', key: 'Control+a' }])

    const ret = await (await call('/api/browsers/return', json('POST', { key: tabKey, note: '已登录完成' }))).json() as any
    expect(ret).toEqual({ ok: true })
    expect(handoffActive).toBe(false)
    expect(controls).toEqual(['takeover', 'takeover', 'handback', 'handback'])
    const msgs = rt.store.db.select().from(schema.messages).all().filter(m => m.conversationId === cnv)
    expect(msgs.at(-1)?.content).toBe('已登录完成')

    // 6. Close native desktop browser
    expect(await (await call('/api/browsers/close', json('POST', { key: tabKey }))).json()).toEqual({ ok: true })
    expect(desktopRunning).toBe(false)
    expect(browserCalls).toEqual([])
  })

  it('handles local browser keys and rejects desktop stream when computer has no desktop', async () => {
    const fakePng = Buffer.from([137, 80, 78, 71])
    ;(rt.browser as any).listPages = async () => [{ id: 'web_1', url: 'https://local.example/', title: '本地页', handoff: rt.browser.handoffs.has('web_1') }]
    ;(rt.browser as any).hasPage = (id: string) => id === 'web_1'
    ;(rt.browser as any).state = async (id: string) => (id === 'web_1' ? { url: 'https://local.example/', title: '本地页', handoff: rt.browser.handoffs.has(id) } : null)
    ;(rt.browser as any).screenshot = async () => fakePng
    ;(rt.browser as any).input = async (_id: string, a: any) => ({ url: a.url ?? 'https://local.example/', title: '本地页2' })
    let closedId = ''
    ;(rt.browser as any).closePage = async (id: string) => { closedId = id; rt.browser.handoffs.delete(id) }

    const listed = await (await call('/api/browsers')).json() as any
    expect(listed.pages).toEqual([{
      key: 'local:web_1', kind: 'local', browser: 'local', tab: 'web_1', title: '本地页', url: 'https://local.example/', handoff: false, hasDesktop: false,
    }])
    const ho = await (await call('/api/browsers/handoff', json('POST', { key: 'local:web_1' }))).json() as any
    expect(ho).toEqual({ ok: true, url: 'https://local.example/', title: '本地页', hasDesktop: false })
    expect(rt.browser.handoffs.has('web_1')).toBe(true)

    const shot = await call('/api/browsers/screenshot?key=local%3Aweb_1')
    expect(shot.status).toBe(200)
    expect(shot.headers.get('content-type')).toBe('image/png')

    const inp = await (await call('/api/browsers/input', json('POST', { key: 'local:web_1', action: { type: 'reload' } }))).json() as any
    expect(inp).toEqual({ ok: true, url: 'https://local.example/', title: '本地页2' })

    await call('/api/browsers/return', json('POST', { key: 'local:web_1' }))
    expect(rt.browser.handoffs.has('web_1')).toBe(false)

    await call('/api/browsers/close', json('POST', { key: 'local:web_1' }))
    expect(closedId).toBe('web_1')

    ;(rt.computers as any).list = () => [{
      id: 'headlessbox', title: '无桌面机', pluginId: 'x',
      capabilities: { sudo: false, docker: false, sleeps: false, dataDir: '/data', maxExecSeconds: 60 },
      status: async () => ({ state: 'ready' as const }),
      wake: async () => ({ state: 'ready' as const }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }]
    expect((await call('/api/computers/headlessbox/desktop', { method: 'POST' })).status).toBe(400)
  })
})

describe('Section 38 activity stream & step inspector (backend)', () => {
  it('1) returns real-time stepCount, currentStep, iconKind, and runningJobs for a running and completed Worker ticket on GET /api/tickets', async () => {
    const cnv = rt.engine.mainConversation()
    const trig = rt.engine.receiveMessage(cnv, '帮我编辑角色设计池并排查登录接口超时')
    rt.agents.discardPending('router')
    rt.agents.cancel('router')
    const ticket = rt.engine.startTask({ conversationId: cnv, triggerIds: [trig.triggerId], title: '排查登录接口 504 超时' })
    const sessionId = ticket.sessionId
    rt.agents.discardPending(sessionId)
    rt.agents.cancel(sessionId)

    // Mark worker session running
    rt.store.db.update(schema.sessions).set({ state: 'running', updatedAt: Date.now() }).where(schema.sessions.id as any).run()

    // Step 1: failed edit_file
    rt.agents.appendEvent(sessionId, 'message', {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_edit_1',
          toolName: 'edit_file',
          input: { path: `${ticket.directory}/memory/2026-11-18.md`, old_text: 'foo', new_text: 'bar' },
        },
      ],
    })
    rt.agents.appendEvent(sessionId, 'message', {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_edit_1',
          toolName: 'edit_file',
          output: { type: 'error-text', value: 'old_text 在文件中不存在' },
        },
      ],
    })

    // Check failed step state
    const afterStep1 = await (await call('/api/tickets')).json() as any
    const t1 = afterStep1.tickets.find((x: any) => x.id === ticket.id)
    expect(t1).toMatchObject({
      id: ticket.id,
      kind: 'ticket',
      stage: 'working',
      stepCount: 1,
      currentStep: {
        tool: 'edit_file',
        label: '编辑 memory/2026-11-18.md 失败',
        status: 'failed',
      },
      iconKind: 'error',
      runningJobs: 0,
    })

    // Step 2: succeeded edit_file
    rt.agents.appendEvent(sessionId, 'message', {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_edit_2',
          toolName: 'edit_file',
          input: { path: `${ticket.directory}/novelai-follow-image/character-design-pool.md`, old_text: 'a', new_text: 'b' },
        },
      ],
    })
    rt.agents.appendEvent(sessionId, 'message', {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_edit_2',
          toolName: 'edit_file',
          output: { type: 'text', value: '已修改 novelai-follow-image/character-design-pool.md（替换 1 处）' },
        },
      ],
    })

    // Step 3: in-flight shell command (via tool-start marker before tool-end)
    const startMarkerId = rt.agents.appendEvent(sessionId, 'marker', {
      type: 'tool-start',
      tool: 'shell',
      callId: 'call_shell_3',
      input: JSON.stringify({ command: 'curl -I https://api.nuonuo.dev/v1/auth/login' }),
    })

    const duringStep3 = await (await call('/api/tickets')).json() as any
    const t3 = duringStep3.tickets.find((x: any) => x.id === ticket.id)
    expect(t3).toMatchObject({
      id: ticket.id,
      kind: 'ticket',
      stage: 'working',
      stepCount: 3,
      currentStep: {
        tool: 'shell',
        label: '正在运行 curl -I https://api.nuonuo.dev/v1/auth/login',
        status: 'running',
      },
      iconKind: 'terminal',
      runningJobs: 0,
    })

    // Detail endpoint also exposes the in-flight tool-call in transcript
    const detailDuring = await (await call(`/api/tickets/${ticket.id}`)).json() as any
    const duringToolCalls = detailDuring.transcript.filter((i: any) => i.kind === 'tool-call')
    expect(duringToolCalls).toHaveLength(3)
    expect(duringToolCalls.at(-1)).toMatchObject({
      kind: 'tool-call',
      callId: 'call_shell_3',
      tool: 'shell',
      input: { command: 'curl -I https://api.nuonuo.dev/v1/auth/login' },
    })

    // Finish Step 3 and report task completion
    rt.agents.appendEvent(sessionId, 'marker', { type: 'tool-end', start: startMarkerId })
    rt.agents.appendEvent(sessionId, 'message', {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_shell_3',
          toolName: 'shell',
          input: { command: 'curl -I https://api.nuonuo.dev/v1/auth/login' },
        },
      ],
    })
    rt.agents.appendEvent(sessionId, 'message', {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_shell_3',
          toolName: 'shell',
          output: { type: 'text', value: '[job_1 退出码 0，用时 0.2s]\nHTTP/2 200' },
        },
      ],
    })
    rt.engine.report(ticket.id, { status: 'ready', summary: 'Updated ninth draw entry in character design pool' })
    rt.store.db.update(schema.sessions).set({ state: 'idle', updatedAt: Date.now() }).where(schema.sessions.id as any).run()

    const afterDone = await (await call('/api/tickets')).json() as any
    const tDone = afterDone.tickets.find((x: any) => x.id === ticket.id)
    expect(tDone).toMatchObject({
      id: ticket.id,
      kind: 'ticket',
      stage: 'ended',
      stepCount: 3,
      currentStep: {
        tool: 'shell',
        label: '已运行 curl -I https://api.nuonuo.dev/v1/auth/login',
        status: 'done',
      },
      iconKind: 'file',
      runningJobs: 0,
    })
  })

  it('2) exposes Router update_my_settings action as「修改助理名字与语调」in GET /api/tickets and returns full TicketDetail transcript on GET /api/tickets/act_...', async () => {
    let routerStep = 0
    const scriptedRouter = new MockLanguageModelV4({
      doStream: async o => {
        const last = lastUserText(o)
        const cnv = /conversation_id="([a-z]+_[a-z0-9]+)"/.exec(last)?.[1] ?? rt.engine.mainConversation()
        routerStep++
        if (routerStep === 1) {
          return streamOf({
            calls: [
              {
                name: 'update_my_settings',
                input: {
                  persona: { name: '千绪' },
                  mood: { tone_preset: 'warm' },
                },
              },
            ],
          })
        }
        if (routerStep === 2) {
          return streamOf({
            calls: [
              {
                name: 'reply',
                input: {
                  conversation_id: cnv,
                  text: '好呀，以后就叫我千绪，语调也换成温和啦。',
                },
              },
            ],
          })
        }
        return streamOf({ text: 'done' })
      },
      doGenerate: async o => generateOf({ text: systemText(o) || '改名语调' }),
    })

    rt.hub = new ModelHub(rt.store, rt.secrets, {
      language: () => scriptedRouter,
      embedding: () => { throw new Error('unused') },
    })
    ;(rt.agents as any).hub = rt.hub
    ;(rt.engine as any).runtime = rt.agents
    const { provider } = await (await call('/api/providers', { method: 'POST', body: JSON.stringify({ kind: 'openai', name: 'O', apiKey: 'k' }) })).json() as any
    await call('/api/roles/router', { method: 'PUT', body: JSON.stringify({ chain: [{ providerId: provider.id, model: 'm' }] }) })

    const mapper = new EventMapper()
    const sseEvents: any[] = []
    const off = rt.bus.on(ev => {
      sseEvents.push(...mapper.map(ev))
    })

    try {
      const cnv = rt.engine.mainConversation()
      const sendRes = await call(`/api/conversations/${cnv}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '把你的名字改成千绪，语调切成温和' }),
      })
      expect(sendRes.status).toBe(201)
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 30))
        await rt.agents.idle()
      }

      // Check GET /api/tickets includes the virtual ActionRun
      const listRes = await (await call('/api/tickets')).json() as any
      const actionItem = listRes.tickets.find((t: any) => t.kind === 'action')
      expect(actionItem).toBeDefined()
      expect(actionItem.id).toMatch(/^act_/)
      expect(actionItem).toMatchObject({
        kind: 'action',
        title: '修改助理名字与语调',
        stage: 'ended',
        conversationId: cnv,
        latestReport: {
          status: 'ready',
          summary: '已将名字改为「千绪」，语调切换至温和',
        },
        ended: {
          by: 'router',
          outcome: 'completed',
        },
        stepCount: 1,
        currentStep: {
          tool: 'update_my_settings',
          label: '修改助理名字与语调',
          status: 'done',
        },
        iconKind: 'check',
        runningJobs: 0,
      })

      // Also exposed in `actions` array
      expect(listRes.actions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: actionItem.id, title: '修改助理名字与语调' })]),
      )

      // Check GET /api/tickets/:id for act_... returns full TicketDetail with transcript
      const detailRes = await call(`/api/tickets/${actionItem.id}`)
      expect(detailRes.status).toBe(200)
      const detail = await detailRes.json() as any
      expect(detail).toMatchObject({
        ticket: expect.objectContaining({
          id: actionItem.id,
          kind: 'action',
          title: '修改助理名字与语调',
        }),
        running: false,
        jobs: [],
        approvals: [],
        browser: false,
        project: null,
        usage: { tokens: 0, costUsd: 0 },
        files: [],
        reports: [
          expect.objectContaining({
            ticketId: actionItem.id,
            status: 'ready',
            summary: '已将名字改为「千绪」，语调切换至温和',
          }),
        ],
      })
      const toolCall = detail.transcript.find((i: any) => i.kind === 'tool-call' && i.tool === 'update_my_settings')
      const toolResult = detail.transcript.find((i: any) => i.kind === 'tool-result' && i.tool === 'update_my_settings')
      expect(toolCall).toMatchObject({
        kind: 'tool-call',
        tool: 'update_my_settings',
        input: {
          persona: { name: '千绪' },
          mood: { tone_preset: 'warm' },
        },
      })
      expect(toolResult).toBeDefined()
      expect(toolResult.output).toContain('"ok": true')

      // Check SSE events notified the frontend about the router action
      expect(sseEvents).toEqual(
        expect.arrayContaining([
          { type: 'ticket.updated', ticketId: actionItem.id },
          { type: 'activity.updated' },
        ]),
      )

      // Unknown act_ id returns 404
      expect((await call('/api/tickets/act_nope')).status).toBe(404)
    } finally {
      off()
    }
  })
})
