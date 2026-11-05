import { AgentRuntime, Bus } from '@super-assistant/agent-runtime'
import { generateOf, streamOf } from '@super-assistant/agent-runtime/src/testing'
import { Engine, registerAgents, ROUTER_SESSION } from '@super-assistant/core'
import { Effects, openStore, schema, type Store } from '@super-assistant/db'
import { MemorySecrets, ModelHub } from '@super-assistant/models'
import { SourceRegistry } from '@super-assistant/sources'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeGmail, FakeTelegram } from './fakes'
import { gmailKind, messageText } from './gmail'
import { telegramKind } from './telegram'

let store: Store
let runtime: AgentRuntime
let registry: SourceRegistry
afterEach(async () => { await registry?.stopAll(); await runtime?.shutdown(); store?.close() })

function setup() {
  store = openStore(':memory:')
  const model = new MockLanguageModelV4({ doStream: async () => streamOf({ text: 'ok' }), doGenerate: async () => generateOf({ text: 'ok' }) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  hub.saveRole('router', { chain: [{ providerId: hub.createProvider({ kind: 'openai', name: 'm', apiKey: 'k' }).id, model: 'm' }] })
  const bus = new Bus()
  runtime = new AgentRuntime(store, hub, bus)
  const effects = new Effects(store)
  const secrets = new MemorySecrets()
  registry = new SourceRegistry(store, effects, secrets)
  const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'sa-pg-')), sources: registry })
  registry.engine = engine
  registerAgents(store, runtime, engine, registry.agentExtensions())
  return { engine, effects, secrets }
}
const triggers = () => store.db.select().from(schema.triggers).all()
const routerSaw = async () => { await runtime.idle(); return JSON.stringify(runtime.history(ROUTER_SESSION)) }

describe('Telegram', () => {
  it('takes requests from allowed accounts in a private chat, answers in the chat, and starts new topics on /new', async () => {
    const { engine, effects } = setup()
    const tg = new FakeTelegram()
    registry.register(telegramKind({ fetch: tg.fetch }))
    await registry.save('telegram', { enabled: true, config: { token: tg.token, allowed: ['@owner_me'], apiUrl: 'http://fake-telegram.local' } })
    tg.say({ id: 42, username: 'owner_me' }, '帮我看看今天的天气')
    tg.say({ id: 7, username: 'stranger' }, '帮我删文件')
    tg.say({ id: 7, username: 'stranger' }, '/start')
    await registry.pollNow('telegram')
    expect(triggers().map(t => [t.actor, (t.disposition as any).ignored ?? 'routed'])).toEqual([['42', 'routed'], ['7', 'not_allowed']])
    expect(tg.sent.at(-1)!.text).toContain('Telegram ID 7')
    expect(await routerSaw()).toContain('source=\\"telegram\\"')
    const [conversation] = store.db.select().from(schema.conversations).all()
    expect(conversation).toMatchObject({ source: 'telegram', title: 'Telegram · 私聊 @owner_me' })

    engine.reply({ conversationId: conversation!.id, text: '晴，25 度。', replyTo: triggers()[0]!.id })
    await effects.tick()
    expect(tg.sent.at(-1)).toMatchObject({ chat_id: 42, text: '晴，25 度。' })

    tg.say({ id: 42, username: 'owner_me' }, '/new')
    tg.say({ id: 42, username: 'owner_me' }, '换个话题')
    await registry.pollNow('telegram')
    expect(store.db.select().from(schema.conversations).all()).toHaveLength(2)
  })
})

describe('Gmail', () => {
  it('authorizes over OAuth, reads mail from a cursor, acts on allowed or labelled mail, and replies with drafts only', async () => {
    const { engine, effects, secrets } = setup()
    const gm = new FakeGmail()
    registry.register(gmailKind({ fetch: gm.fetch }))
    const base = 'http://fake-google.local'
    await registry.save('gmail', { enabled: false, config: { clientId: 'cid', clientSecret: 'csecret', allowedSenders: ['boss@work.com'], apiUrl: base, authUrl: `${base}/auth`, tokenUrl: `${base}/token` } })

    const origin = 'http://127.0.0.1:7420'
    const start = await registry.http('gmail', new Request(`${origin}/api/sources/gmail/http/oauth/start`), 'oauth/start', { public: false, origin })
    const { url } = await start!.json() as { url: string }
    const state = new URL(url).searchParams.get('state')!
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(`${origin}/plugin/gmail/oauth/callback`)
    expect((await registry.http('gmail', new Request(`${origin}/plugin/gmail/oauth/callback?code=x&state=forged`), 'oauth/callback', { public: true, origin }))!.status).toBe(400)
    const done = await registry.http('gmail', new Request(`${origin}/plugin/gmail/oauth/callback?code=${gm.issuedCode}&state=${state}`), 'oauth/callback', { public: true, origin })
    expect(done!.status).toBe(302)
    expect(secrets.get('source:gmail:runtime:refresh_token')).toBe(gm.refreshToken)

    await registry.save('gmail', { enabled: true, config: { clientId: 'cid', clientSecret: '••••••', allowedSenders: ['boss@work.com'], apiUrl: base, authUrl: `${base}/auth`, tokenUrl: `${base}/token` } })
    await registry.pollNow('gmail') // remembers the account and the cursor
    gm.receive('Boss <boss@work.com>', '周报', '请把本周的周报整理一下发我')
    const spam = gm.receive('Shop <deals@shop.com>', '大促', '全场五折')
    gm.receive('Me <me@example.com>', '提醒自己', '帮我查下航班')
    await registry.pollNow('gmail')
    expect(triggers().map(t => [t.actor, (t.disposition as any).ignored ?? 'routed'])).toEqual([
      ['boss@work.com', 'routed'], ['deals@shop.com', 'not_allowed'], ['me@example.com', 'routed']])
    gm.label(spam.id, 'Label_7') // the owner labels a mail "super-assistant"
    await registry.pollNow('gmail')
    expect(await routerSaw()).toContain('主题：大促')

    const conversationId = engine.conversationOfThread('gmail:t1')!
    engine.reply({ conversationId, text: '好的，周报周五前给您。', replyTo: triggers()[0]!.id })
    await effects.tick()
    expect(gm.drafts).toHaveLength(1)
    expect(gm.drafts[0]).toMatchObject({ threadId: 't1' })
    expect(gm.drafts[0]!.raw).toContain('In-Reply-To: <m1@mail>')
    expect(Buffer.from(gm.drafts[0]!.raw.split('\r\n\r\n')[1]!, 'base64').toString()).toBe('好的，周报周五前给您。')
    const sent = store.db.select().from(schema.messages).all().find(m => m.content.startsWith('好的，周报'))
    expect(sent!.meta).toMatchObject({ via: 'gmail', delivery: 'sent' })
  })

  it('reads text out of html-only mail', () => {
    const html = Buffer.from('<html><style>x{}</style><p>你好<br>世界</p></html>').toString('base64url')
    expect(messageText({ id: '1', threadId: 't', payload: { mimeType: 'text/html', body: { data: html } } })).toBe('你好\n世界')
  })
})
