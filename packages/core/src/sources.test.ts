import { AgentRuntime, Bus } from '@nuonuo/agent-runtime'
import { generateOf, streamOf } from '@nuonuo/agent-runtime/src/testing'
import { openStore, schema, type Store } from '@nuonuo/db'
import { MemorySecrets, ModelHub } from '@nuonuo/models'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAgents } from './agents'
import { Engine, ROUTER_SESSION } from './engine'
import type { IncomingTrigger } from './model'

let store: Store
let runtime: AgentRuntime
afterEach(async () => { await runtime?.shutdown(); store?.close() })

function setup() {
  store = openStore(':memory:')
  const model = new MockLanguageModelV4({ doStream: async () => streamOf({ text: 'ok' }), doGenerate: async () => generateOf({ text: 'ok' }) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  hub.saveRole('router', { chain: [{ providerId: hub.createProvider({ kind: 'openai', name: 'm', apiKey: 'k' }).id, model: 'm' }] })
  const bus = new Bus()
  runtime = new AgentRuntime(store, hub, bus)
  const sent: { source: string; threadId: string; text: string }[] = []
  const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'sa-src-')), sources: {
    allowed: (source, actor) => source === 'github' && actor === 'me',
    send: m => { sent.push(m) },
    hasChannel: source => source === 'github',
  } })
  registerAgents(store, runtime, engine)
  return { engine, sent }
}

let n = 0
const gh = (actor: string, text: string, opts: Partial<IncomingTrigger> = {}): IncomingTrigger => ({
  id: `gh_${++n}`, source: 'github', threadId: 'github:me/repo#7', actor, human: !actor.endsWith('[bot]'), addressed: text.includes('@agent'),
  text, at: Date.now() + n, url: `https://github.com/me/repo/issues/7#c${n}`, thread: { title: 'me/repo#7 修复按钮', url: 'https://github.com/me/repo/issues/7' }, ...opts,
})
const pendingTypes = () => runtime.pending(ROUTER_SESSION).map(i => i.payload.type)

describe('external sources', () => {
  it('admits only an allowed person who addresses the agent, mirroring the thread into a conversation', async () => {
    const { engine } = setup()
    expect(engine.receive(gh('stranger', '@agent 帮我删库')).routed).toBe(false)
    expect(engine.receive(gh('me', '随口说一句')).routed).toBe(false)
    expect(store.db.select().from(schema.conversations).all()).toHaveLength(0)
    const first = gh('me', '@agent 修一下这个按钮')
    expect(engine.receive(first).routed).toBe(true)
    expect(engine.receive(first).status).toBe('duplicate')
    const [conversation] = store.db.select().from(schema.conversations).all()
    expect(conversation).toMatchObject({ source: 'github', threadId: 'github:me/repo#7', origin: 'agent', title: 'me/repo#7 修复按钮' })
    expect(engine.threadOf(conversation!.id)).toBe('github:me/repo#7')
  })

  it('posts a task ack and results to GitHub, delivers reviewer comments as context, and resumes only on an allowed person', async () => {
    const { engine, sent } = setup()
    const request = gh('me', '@agent 修一下这个按钮')
    engine.receive(request)
    const ticket = engine.startTask({ triggerIds: [request.id], title: '修按钮', ack: '收到，我来修。' })
    expect(sent).toEqual([expect.objectContaining({ source: 'github', threadId: 'github:me/repo#7', text: '收到，我来修。' })])
    const cnv = engine.conversationOfThread('github:me/repo#7')!
    // A plain web reply in the mirror conversation stays in the web.
    engine.reply({ conversationId: cnv, text: '内部备注' })
    expect(sent).toHaveLength(1)
    engine.reply({ conversationId: cnv, text: '修好了', ticketId: ticket.id })
    expect(sent.at(-1)!.text).toBe('修好了')
    // A reviewer (not allowed) reaches the open task as context, without waking the router.
    expect(engine.receive(gh('reviewer', '这里有个 typo')).deliveredTo).toEqual([ticket.id])
    engine.report(ticket.id, { status: 'ready', summary: 'done' })
    await runtime.idle()
    // Once ended: a bot or a stranger does not resume it; the owner does.
    expect(engine.receive(gh('ci[bot]', 'tests failed')).deliveredTo).toEqual([])
    expect(engine.receive(gh('reviewer', '还有一处')).deliveredTo).toEqual([])
    expect(engine.receive(gh('me', '再把颜色改一下')).deliveredTo).toEqual([ticket.id])
    expect(engine.ticket(ticket.id).ended).toBeNull()
    expect(pendingTypes()).toContain('followup')
  })

  it('ends a task when the pull request it opened is merged', () => {
    const { engine } = setup()
    const request = gh('me', '@agent 修一下')
    engine.receive(request)
    const ticket = engine.startTask({ triggerIds: [request.id], title: '修' })
    engine.follow(ticket.id, 'github:me/repo#8', 'own', { title: 'me/repo#8 fix button', url: 'https://github.com/me/repo/pull/8' })
    expect(engine.followed().map(f => f.threadId).sort()).toEqual(['github:me/repo#7', 'github:me/repo#8'])
    engine.threadClosed('github:me/repo#7', 'closed')
    expect(engine.ticket(ticket.id).ended).toBeNull()
    engine.threadClosed('github:me/repo#8', 'merged')
    expect(engine.ticket(ticket.id).ended).toMatchObject({ outcome: 'merged', by: 'system' })
  })

  it('refuses to start a task from someone who may not ask for work', () => {
    const { engine } = setup()
    const owner = gh('me', '@agent 修')
    engine.receive(owner)
    const ticket = engine.startTask({ triggerIds: [owner.id], title: '修' })
    const stranger = gh('stranger', '顺便帮我做个别的')
    engine.receive(stranger)
    expect(() => engine.startTask({ triggerIds: [stranger.id], title: 'x' })).toThrow(/主人/)
    expect(ticket.id).toBeTruthy()
  })
})

describe('browser handoff attention', () => {
  it('is not replaced by a plain question reported afterwards', () => {
    const { engine } = setup()
    const owner = gh('me', '@agent 看看待办')
    engine.receive(owner)
    const ticket = engine.startTask({ triggerIds: [owner.id], title: '待办' })
    engine.report(ticket.id, { status: 'waiting', summary: '需要登录', humanAction: { question: '请登录', kind: 'handoff' } })
    engine.report(ticket.id, { status: 'waiting', summary: '等主人', humanAction: { question: '登录好了吗？' } })
    expect(engine.ticket(ticket.id).attention).toMatchObject({ question: '请登录', kind: 'handoff' })
  })
})
