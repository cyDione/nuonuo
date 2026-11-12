/**
 * The channel contract: every chat adapter runs the same scenarios against a fake of its app, so they behave alike
 * (who may ask, groups, /start and /new, splitting, plain-text downgrade, approvals by button and by reply).
 */
import { AgentRuntime, Bus } from '@nuonuo/agent-runtime'
import { generateOf, streamOf } from '@nuonuo/agent-runtime/src/testing'
import { Engine, registerAgents } from '@nuonuo/core'
import { Effects, openStore, schema, type Store } from '@nuonuo/db'
import { MemorySecrets, ModelHub } from '@nuonuo/models'
import { channelThread, parseChannelThread, plainText, splitText, SourceRegistry, type SourceKind } from '@nuonuo/sources'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discordKind } from './discord'
import { FakeDiscord, FakeFeishu, FakeTelegram } from './fakes'
import { encodeFrame, decodeFrame, feishuKind } from './feishu'
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
  registry = new SourceRegistry(store, effects, new MemorySecrets())
  const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'sa-ch-')), sources: registry })
  registry.engine = engine
  registerAgents(store, runtime, engine, registry.agentExtensions())
  return { engine, effects }
}
const triggers = () => store.db.select().from(schema.triggers).all()
const settle = () => new Promise(r => setTimeout(r, 30))

interface User { id: string; username?: string }
interface Reply { chat: string; text: string; buttons: string[]; id: string }
interface Driver {
  kind: SourceKind
  config: Record<string, unknown>
  owner: User
  stranger: User
  /** Chat id of the private chat with a user, and of a group. */
  dm(u: User): string
  group: string
  connect(): Promise<void>
  say(u: User, text: string, where?: { group?: boolean; mention?: boolean }): Promise<void>
  press(u: User, data: string, chat: string): Promise<void>
  replies(): Reply[]
  edits(): { id: string; text: string }[]
}

function telegramDriver(): Driver {
  const tg = new FakeTelegram()
  const owner = { id: '42', username: 'owner_me' }
  return {
    kind: telegramKind({ fetch: tg.fetch }), owner, stranger: { id: '7', username: 'stranger' },
    config: { token: tg.token, apiUrl: 'http://fake-telegram.local', allowed: ['@owner_me'] },
    dm: u => u.id, group: '-100',
    connect: async () => { await registry.pollNow('telegram') },
    say: async (u, text, where) => {
      tg.say({ id: Number(u.id), ...(u.username ? { username: u.username } : {}) }, where?.mention ? `@my_agent_bot ${text}` : text, where?.group ? { id: -100, type: 'group', title: '家' } : { id: Number(u.id), type: 'private' })
      await registry.pollNow('telegram')
    },
    press: async (u, data, chat) => { tg.press({ id: Number(u.id), ...(u.username ? { username: u.username } : {}) }, data, Number(chat)); await registry.pollNow('telegram') },
    replies: () => tg.sent.map(s => ({ chat: String(s.chat_id), text: s.text, buttons: (s.reply_markup?.inline_keyboard ?? []).flat().map(b => b.callback_data), id: String(s.message_id) })),
    edits: () => tg.edits.map(e => ({ id: String(e.message_id), text: e.text })),
  }
}

function feishuDriver(): Driver {
  const fs = new FakeFeishu()
  let seq = 1
  const deliver = async (event: unknown) => {
    const n = seq++
    fs.sockets.at(-1)!.deliver(encodeFrame({ seqId: BigInt(n), logId: 0n, service: 33, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: `e${n}` }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }], payload: new TextEncoder().encode(JSON.stringify(event)) }))
    await vi.waitFor(() => expect(fs.sockets.at(-1)!.sent.some(d => typeof d !== 'string' && decodeFrame(d).method === 1 && decodeFrame(d).seqId === BigInt(n))).toBe(true))
  }
  return {
    kind: feishuKind({ fetch: fs.fetch, socket: fs.socket }), owner: { id: 'ou_owner' }, stranger: { id: 'ou_stranger' },
    config: { appId: fs.appId, appSecret: fs.appSecret, domain: 'https://fake-feishu.local', allowed: ['ou_owner'] },
    dm: u => `oc_dm_${u.id}`, group: 'oc_group',
    connect: async () => { await vi.waitFor(() => expect(registry.list().find(s => s.id === 'feishu')!.health.status).toBe('ok')) },
    say: async (u, text, where) => deliver({
      schema: '2.0', header: { event_type: 'im.message.receive_v1' },
      event: { sender: { sender_id: { open_id: u.id }, sender_type: 'user' }, message: {
        message_id: `om_${seq}`, chat_id: where?.group ? 'oc_group' : `oc_dm_${u.id}`, chat_type: where?.group ? 'group' : 'p2p', message_type: 'text',
        content: JSON.stringify({ text: where?.mention ? `@_user_1 ${text}` : text }), create_time: String(Date.now()),
        ...(where?.mention ? { mentions: [{ key: '@_user_1', name: '糯糯', id: { open_id: fs.botId } }] } : {}) } },
    }),
    press: async (u, data, chat) => deliver({ schema: '2.0', header: { event_type: 'card.action.trigger' }, event: { operator: { open_id: u.id }, action: { value: { nuonuo: data } }, context: { open_chat_id: chat } } }),
    replies: () => fs.sent.map(s => ({ chat: s.chat ?? '', id: s.id,
      text: s.msgType === 'text' ? s.content.text : s.content.elements[0].text.content,
      buttons: s.msgType === 'interactive' ? (s.content.elements[1]?.actions ?? []).map((a: any) => a.value.nuonuo) : [] })),
    edits: () => fs.patched.map(p => ({ id: p.id, text: p.content.elements[0].text.content })),
  }
}

function discordDriver(): Driver {
  const dc = new FakeDiscord()
  let n = 1
  return {
    kind: discordKind({ fetch: dc.fetch, socket: dc.socket }), owner: { id: '42', username: 'owner' }, stranger: { id: '7', username: 'stranger' },
    config: { token: dc.token, apiUrl: 'http://fake-discord.local/api/v10', allowed: ['owner'] },
    dm: u => `${500 + Number(u.id)}`, group: '600',
    connect: async () => { await vi.waitFor(() => expect(registry.list().find(s => s.id === 'discord')!.health.status).toBe('ok')) },
    say: async (u, text, where) => {
      dc.dispatch('MESSAGE_CREATE', { id: `${n++}`, channel_id: where?.group ? '600' : `${500 + Number(u.id)}`, ...(where?.group ? { guild_id: '1' } : {}),
        author: { id: u.id, username: u.username }, content: where?.mention ? `<@${dc.botId}> ${text}` : text, mentions: where?.mention ? [{ id: dc.botId }] : [], timestamp: new Date().toISOString() })
      await settle()
    },
    press: async (u, data, chat) => {
      const before = dc.callbacks.length
      dc.dispatch('INTERACTION_CREATE', { id: `i${n++}`, token: 'tok', type: 3, channel_id: chat, data: { custom_id: data }, user: { id: u.id, username: u.username } })
      await vi.waitFor(() => expect(dc.callbacks.length).toBeGreaterThan(before))
    },
    replies: () => dc.sent.map(s => ({ chat: s.channel, text: s.content, id: s.id, buttons: (s.components ?? []).flatMap((r: any) => r.components.map((b: any) => b.custom_id)) })),
    edits: () => dc.edits.map(e => ({ id: e.id, text: e.content })),
  }
}

describe.each([['telegram', telegramDriver], ['feishu', feishuDriver], ['discord', discordDriver]] as const)('channel contract: %s', (_name, make) => {
  it('lets allowed accounts ask, ignores others, splits long replies, handles /new and answers approvals', async () => {
    const { engine, effects } = setup()
    const d = make()
    const id = d.kind.id
    const max = d.kind.capabilities!.maxLength
    registry.register(d.kind)
    await registry.save(id, { enabled: true, config: { ...d.config, approvals: true } })
    await d.connect()

    // Who may ask
    await d.say(d.owner, '帮我看看今天的天气')
    await d.say(d.stranger, '帮我删文件')
    await d.say(d.stranger, '/start')
    expect(triggers().map(t => [t.actor, (t.disposition as any).ignored ?? 'routed'])).toEqual([[d.owner.id, 'routed'], [d.stranger.id, 'not_allowed']])
    expect(d.replies().at(-1)!.text).toContain(`ID ${d.stranger.id}`)
    expect(triggers()[0]!.threadId).toBe(channelThread(id, d.dm(d.owner)))

    // Groups: only a mention addresses the assistant
    await d.say(d.owner, '大家好', { group: true })
    await d.say(d.owner, '帮我订个会议室', { group: true, mention: true })
    expect(triggers().slice(2).map(t => [(t.disposition as any).ignored ?? 'routed', t.text])).toEqual([['not_addressed', '大家好'], ['routed', expect.stringContaining('帮我订个会议室')]])

    // Replies: split under the app's limit; Markdown downgraded where the app shows plain text
    const conversationId = engine.conversationOfThread(triggers()[0]!.threadId)!
    const long = Array.from({ length: Math.ceil((max * 1.5) / 60) }, (_, i) => `第 ${i} 段：${'很长的回答'.repeat(10)}。`).join('\n\n')
    const before = d.replies().length
    engine.reply({ conversationId, text: long, replyTo: triggers()[0]!.id })
    await effects.tick()
    const parts = d.replies().slice(before)
    expect(parts.length).toBe(2)
    expect(parts.every(p => p.chat === d.dm(d.owner) && p.text.length <= max)).toBe(true)
    engine.reply({ conversationId, text: '**晴**，看 [天气](https://w.example)', replyTo: triggers()[0]!.id })
    await effects.tick()
    expect(d.replies().at(-1)!.text).toBe(d.kind.capabilities!.format === 'plain' ? '晴，看 天气 (https://w.example)' : '**晴**，看 [天气](https://w.example)')

    // /new starts a fresh conversation
    await d.say(d.owner, '/new')
    await d.say(d.owner, '换个话题')
    const fresh = triggers().at(-1)!
    expect(fresh.threadId).not.toBe(triggers()[0]!.threadId)
    expect(engine.conversationOfThread(fresh.threadId)).not.toBe(conversationId)

    // Approvals by button: only allowed accounts; the card is marked once answered
    const answers: [string, string, boolean][] = []
    registry.onApprovalAnswer = (source, approvalId, approve) => { answers.push([source, approvalId, approve]) }
    registry.send({ messageId: 'apv_1:ask', source: id, threadId: fresh.threadId, text: '需要你确认：删除 build/', approval: { id: 'apv_1', state: 'pending' } })
    await effects.tick()
    const card = d.replies().at(-1)!
    expect(card.buttons).toEqual(['nuonuo:apv:yes:apv_1', 'nuonuo:apv:no:apv_1'])
    await d.press(d.stranger, card.buttons[0]!, d.dm(d.owner))
    expect(answers).toEqual([])
    await d.press(d.owner, card.buttons[0]!, d.dm(d.owner))
    expect(answers).toEqual([[id, 'apv_1', true]])
    registry.send({ messageId: 'apv_1:approved', source: id, threadId: fresh.threadId, text: '已同意', approval: { id: 'apv_1', state: 'approved' } })
    await effects.tick()
    expect(d.edits().at(-1)).toMatchObject({ id: card.id, text: expect.stringContaining('已同意') })

    // …and by a typed answer
    registry.send({ messageId: 'apv_2:ask', source: id, threadId: fresh.threadId, text: '需要你确认：发邮件', approval: { id: 'apv_2', state: 'pending' } })
    await effects.tick()
    const count = triggers().length
    await d.say(d.owner, '拒绝')
    await vi.waitFor(() => expect(answers.at(-1)).toEqual([id, 'apv_2', false]))
    expect(triggers()).toHaveLength(count)
  })
})

describe('channel layer', () => {
  it('splits at paragraphs, keeps every character, and downgrades Markdown to plain text', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}\n\n${'c'.repeat(30)}`
    const parts = splitText(text, 70)
    expect(parts).toEqual([`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 'c'.repeat(30)])
    expect(splitText('x'.repeat(250), 100).map(p => p.length)).toEqual([100, 100, 50])
    expect(plainText('# 标题\n- **一**\n- `二`\n```js\ncode()\n```')).toBe('标题\n• 一\n• 二\ncode()')
  })

  it('round-trips thread ids, escaping colons in platform ids', () => {
    expect(channelThread('telegram', -100, 55, 0)).toBe('telegram:-100:55:0')
    expect(parseChannelThread('telegram', 'telegram:-100:55:0')).toEqual({ chat: '-100', topic: '55' })
    const t = channelThread('matrix', '!room:example.org', undefined, 7)
    expect(parseChannelThread('matrix', t)).toEqual({ chat: '!room:example.org' })
    expect(parseChannelThread('telegram', 'discord:1:0')).toBeUndefined()
  })

  it('adds the shared settings fields and reports a chat it can no longer reach as gone', async () => {
    setup()
    const dc = new FakeDiscord()
    const kind = discordKind({ fetch: dc.fetch, socket: dc.socket })
    registry.register(kind)
    expect(registry.list().find(s => s.id === 'discord')!.fields.map(f => f.key)).toEqual(['token', 'apiUrl', 'gatewayUrl', 'allowed', 'approvals'])
    const ctx = { config: { token: dc.token, apiUrl: 'http://fake-discord.local/api/v10', allowed: [], approvals: false }, state: { get: () => undefined, set: () => {} }, log: () => {}, signal: new AbortController().signal } as any
    expect(await kind.send!(ctx, { messageId: 'm', threadId: 'discord:404:0', text: 'hi' })).toBe('gone')
    expect(await kind.send!(ctx, { messageId: 'm', threadId: 'telegram:1:0', text: 'hi' })).toBe('gone')
  })
})
