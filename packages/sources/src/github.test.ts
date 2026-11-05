import { AgentRuntime, Bus } from '@super-assistant/agent-runtime'
import { generateOf, streamOf } from '@super-assistant/agent-runtime/src/testing'
import { Engine, registerAgents, ROUTER_SESSION } from '@super-assistant/core'
import { Effects, openStore, schema, type Store } from '@super-assistant/db'
import { MemorySecrets, ModelHub } from '@super-assistant/models'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeGithub } from './fake-github'
import { githubKind, MARKER } from './github'
import { SourceRegistry } from './registry'

let store: Store
let runtime: AgentRuntime
let registry: SourceRegistry
afterEach(async () => { await registry?.stopAll(); await runtime?.shutdown(); store?.close() })

async function setup() {
  store = openStore(':memory:')
  const model = new MockLanguageModelV4({ doStream: async () => streamOf({ text: 'ok' }), doGenerate: async () => generateOf({ text: 'ok' }) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  hub.saveRole('router', { chain: [{ providerId: hub.createProvider({ kind: 'openai', name: 'm', apiKey: 'k' }).id, model: 'm' }] })
  const bus = new Bus()
  runtime = new AgentRuntime(store, hub, bus)
  const effects = new Effects(store)
  registry = new SourceRegistry(store, effects)
  const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'sa-gh-')), sources: registry })
  registry.engine = engine
  registerAgents(store, runtime, engine, registry.agentExtensions())
  const gh = new FakeGithub('me')
  registry.register(githubKind({ fetch: gh.fetch, token: async () => 'test-token' }))
  await registry.save('github', { enabled: true, config: { repos: ['me/app'], allowed: ['friend'], apiUrl: gh.base, pollSeconds: 3600 } })
  await new Promise(r => setTimeout(r, 50)) // first poll sets the cursor
  return { engine, gh, effects }
}

describe('GitHub source', () => {
  it('turns an allowed mention into a request, ignores others and its own comments, and replies on the issue', async () => {
    const { engine, gh, effects } = await setup()
    const n = gh.openIssue('me/app', 'stranger', '按钮颜色不对', '')
    gh.comment('me/app', n, 'stranger', '@agent 帮我修')
    gh.comment('me/app', n, 'me', `@agent 之前的回复 ${MARKER}`)
    gh.comment('me/app', n, 'friend', '@agent 请修一下这个按钮')
    await registry.pollNow('github')
    const triggers = store.db.select().from(schema.triggers).all()
    expect(triggers.map(t => [t.actor, (t.disposition as any).ignored ?? 'routed'])).toEqual([
      ['stranger', 'not_allowed'], ['stranger', 'not_allowed'], ['friend', 'routed']])
    const [conversation] = store.db.select().from(schema.conversations).all()
    expect(conversation).toMatchObject({ source: 'github', threadId: `github:me/app#${n}`, title: `me/app#${n} 按钮颜色不对` })
    await runtime.idle()
    const routerSaw = JSON.stringify(runtime.history(ROUTER_SESSION))
    expect(routerSaw).toContain('source=\\"github\\" from=\\"friend\\"')
    expect(routerSaw).not.toContain('帮我修')
    // Polling again creates nothing new.
    await registry.pollNow('github')
    expect(store.db.select().from(schema.triggers).all()).toHaveLength(3)

    const request = triggers.at(-1)!
    const ticket = engine.startTask({ triggerIds: [request.id], title: '修按钮', ack: '收到，我来修。' })
    await effects.tick()
    const posted = gh.comments.at(-1)!
    expect(posted.body).toContain('收到，我来修。')
    expect(posted.body).toContain(MARKER)
    const ack = store.db.select().from(schema.messages).all().find(m => m.content === '收到，我来修。')!
    expect(ack.meta).toMatchObject({ via: 'github', delivery: 'sent' })
    // Our own comment is not read back as a trigger.
    await registry.pollNow('github')
    expect(store.db.select().from(schema.triggers).all()).toHaveLength(3)
    expect(ticket.title).toBe('修按钮')
  })

  it('follows the task\'s pull request: review comments and CI reach the worker, and the merge ends the task', async () => {
    const { engine, gh } = await setup()
    const issue = gh.openIssue('me/app', 'me', '加个暗色模式 @agent')
    await registry.pollNow('github')
    const [request] = store.db.select().from(schema.triggers).all()
    const ticket = engine.startTask({ triggerIds: [request!.id], title: '暗色模式' })
    await runtime.idle()
    const pr = gh.openIssue('me/app', 'me', 'feat: dark mode', `fixes #${issue} ${MARKER}`, { head: `super-assistant/${ticket.name}` })
    engine.follow(ticket.id, `github:me/app#${pr}`, 'own', { title: `me/app#${pr} feat: dark mode` })
    gh.comment('me/app', pr, 'reviewer', '变量名不清楚', { path: 'src/theme.ts', line: 12 })
    gh.review('me/app', pr, 'reviewer', 'CHANGES_REQUESTED', '请补测试')
    gh.checks.set(FakeGithub.sha(`super-assistant/${ticket.name}`), [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }])
    await registry.pollNow('github')
    const delivered = store.db.select().from(schema.triggers).all().filter(t => ((t.disposition as any).deliveredTo ?? []).includes(ticket.id))
    expect(delivered.map(t => (t.meta as any).kind).sort()).toEqual(['ci', 'review', 'review-comment'])
    expect(delivered.find(t => (t.meta as any).kind === 'ci')!.text).toContain('test: failure')
    expect(delivered.find(t => (t.meta as any).kind === 'review-comment')!.text).toContain('src/theme.ts:12')
    gh.merge('me/app', pr)
    await registry.pollNow('github')
    expect(engine.ticket(ticket.id).ended).toMatchObject({ outcome: 'merged' })
  })
})

describe('GitHub authorization', () => {
  it('signs in with the OAuth device flow, uses that token, and disconnects', async () => {
    store = openStore(':memory:')
    const secrets = new MemorySecrets()
    registry = new SourceRegistry(store, new Effects(store), secrets)
    registry.engine = { followed: () => [], receive: () => {} } as unknown as Engine
    const gh = new FakeGithub('me')
    registry.register(githubKind({ fetch: gh.fetch, token: async () => undefined }))
    await registry.save('github', { enabled: false, config: { repos: ['me/app'], apiUrl: gh.base, oauthUrl: gh.base, clientId: gh.device.clientId } })
    const info = () => registry.list().find(s => s.id === 'github')!
    expect(info()).toMatchObject({ authorized: false, actions: [{ id: 'authorize' }] })

    const http = (path: string) => registry.http('github', new Request(`http://127.0.0.1:7420/api/sources/github/http/${path}`, { method: 'POST' }), path, { public: false, origin: 'http://127.0.0.1:7420' })
    expect(await registry.http('github', new Request('http://127.0.0.1:7420/plugin/github/oauth/device'), 'oauth/device', { public: true, origin: '' })).toBeUndefined()
    const { device } = await (await http('oauth/device'))!.json() as { device: { userCode: string; verificationUri: string; poll: string } }
    expect(device).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', poll: 'oauth/status' })
    const status = async () => (await (await http('oauth/status'))!.json()) as { status: string; login?: string }
    expect((await status()).status).toBe('pending')
    gh.approve()
    await expect.poll(async () => (await status()).status).toBe('done')
    expect(await status()).toMatchObject({ login: 'me' })
    expect(secrets.get('source:github:runtime:token')).toBe('oauth-token-1')
    expect(info()).toMatchObject({ authorized: true, facts: { 账号: 'me', 授权: 'OAuth 授权' } })
    expect(info().actions.map(a => a.id)).toEqual(['reauthorize', 'disconnect'])

    await registry.save('github', { enabled: true, config: { ...info().config } })
    await registry.pollNow('github')
    expect(gh.lastAuth).toBe('Bearer oauth-token-1')

    await http('oauth/disconnect')
    expect(secrets.get('source:github:runtime:token')).toBeUndefined()
    expect(info().authorized).toBe(false)
    await expect(registry.pollNow('github')).rejects.toThrow('还没有授权 GitHub')
  })

  it('explains a missing client ID', async () => {
    store = openStore(':memory:')
    registry = new SourceRegistry(store, new Effects(store), new MemorySecrets())
    registry.register(githubKind({ token: async () => undefined }))
    const res = await registry.http('github', new Request('http://x/'), 'oauth/device', { public: false, origin: '' })
    expect(res!.status).toBe(400)
    expect(((await res!.json()) as { error: string }).error).toContain('Client ID')
  })
})
