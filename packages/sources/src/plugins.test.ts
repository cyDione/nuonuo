import { AgentRuntime, Bus } from '@super-agent/agent-runtime'
import { generateOf, streamOf } from '@super-agent/agent-runtime/src/testing'
import { Engine, registerAgents, ROUTER_SESSION } from '@super-agent/core'
import { Effects, kvGet, openStore, schema, type Store } from '@super-agent/db'
import { MemorySecrets, ModelHub } from '@super-agent/models'
import { MockLanguageModelV4 } from 'ai/test'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PluginManager } from './plugins'
import { SECRET_SET, SourceRegistry } from './registry'

let store: Store
let runtime: AgentRuntime
let registry: SourceRegistry
let server: Server | undefined
afterEach(async () => { server?.close(); server = undefined; await registry?.stopAll(); await runtime?.shutdown(); store?.close() })

function setup() {
  store = openStore(':memory:')
  const model = new MockLanguageModelV4({ doStream: async () => streamOf({ text: 'ok' }), doGenerate: async () => generateOf({ text: 'ok' }) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  hub.saveRole('router', { chain: [{ providerId: hub.createProvider({ kind: 'openai', name: 'm', apiKey: 'k' }).id, model: 'm' }] })
  const bus = new Bus()
  runtime = new AgentRuntime(store, hub, bus)
  const secrets = new MemorySecrets()
  registry = new SourceRegistry(store, new Effects(store), secrets)
  const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'sa-pl-')), sources: registry })
  registry.engine = engine
  registerAgents(store, runtime, engine, registry.agentExtensions())
  const dir = mkdtempSync(join(tmpdir(), 'sa-plugins-'))
  return { engine, secrets, dir, plugins: new PluginManager(dir, registry, store) }
}

async function feed(): Promise<{ url: string; items: { id: string; title: string }[] }> {
  const items: { id: string; title: string }[] = [{ id: 'a1', title: '旧文章' }]
  server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(
    `<rss><channel>${items.map(i => `<item><guid>${i.id}</guid><title>${i.title}</title><link>https://blog.example/${i.id}</link><description>d</description></item>`).join('')}</channel></rss>`))
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}/feed`, items }
}

describe('PluginManager', () => {
  it('lists a plugin without running it, loads it on enable, and runs its source', async () => {
    const { plugins, dir } = setup()
    cpSync(join(__dirname, '../../../examples/plugins/rss-watch'), join(dir, 'rss-watch'), { recursive: true })
    expect(plugins.list()).toEqual([expect.objectContaining({ id: 'rss-watch', name: 'RSS 订阅', enabled: false, loaded: false, sources: [] })])
    expect(registry.has('rss')).toBe(false)

    await plugins.setEnabled('rss-watch', true)
    expect(plugins.list()[0]).toMatchObject({ enabled: true, loaded: true, sources: ['rss'] })
    const { url, items } = await feed()
    await registry.save('rss', { enabled: true, config: { feeds: [url], keywords: ['agent'], mode: 'notify', pollMinutes: 60 } })
    await registry.pollNow('rss') // first run only remembers what exists
    items.push({ id: 'b2', title: 'Agent 系统设计' }, { id: 'c3', title: '无关文章' })
    await registry.pollNow('rss')
    const notices = store.db.select().from(schema.messages).all().filter(m => m.role === 'assistant')
    expect(notices.map(m => m.content)).toEqual(['**Agent 系统设计**\nhttps://blog.example/b2'])
    expect(store.db.select().from(schema.conversations).all()[0]).toMatchObject({ title: '📰 RSS 订阅', origin: 'agent' })

    await registry.save('rss', { enabled: true, config: { feeds: [url], keywords: [], mode: 'agent', pollMinutes: 60 } })
    items.push({ id: 'd4', title: '新文章' })
    await registry.pollNow('rss')
    await runtime.idle()
    expect(JSON.stringify(runtime.history(ROUTER_SESSION))).toContain('订阅源有新文章「新文章」')

    await plugins.setEnabled('rss-watch', false)
    expect(registry.has('rss')).toBe(false)
  })

  it('keeps a broken plugin\'s error to itself and refuses taken source ids', async () => {
    const { plugins, dir } = setup()
    const write = (name: string, code: string) => {
      mkdirSync(join(dir, name))
      writeFileSync(join(dir, name, 'package.json'), JSON.stringify({ name, superagent: { plugin: './index.mjs' } }))
      writeFileSync(join(dir, name, 'index.mjs'), code)
    }
    write('broken', 'throw new Error("boom")')
    write('copycat', `export default ({ z }) => ({ id: 'copycat', sources: [{ id: 'github', title: 'x', description: '', schema: z.object({}), fields: [], start() {} }] })`)
    registry.register({ id: 'github', title: 'g', description: '', schema: z.object({}), fields: [], start() {} })
    await expect(plugins.setEnabled('broken', true)).rejects.toThrow('boom')
    await expect(plugins.setEnabled('copycat', true)).rejects.toThrow(/已被占用/)
    expect(plugins.list().map(p => [p.id, p.loaded, p.error])).toEqual([['broken', false, 'boom'], ['copycat', false, '来源 id "github" 已被占用']])
  })
})

describe('secret fields', () => {
  it('live in the secret store, reach the source, and are masked in the settings view', async () => {
    const { secrets } = setup()
    let seen = ''
    registry.register({ id: 'demo', title: 'demo', description: '', fields: [{ key: 'token', type: 'secret', label: 'Token' }],
      schema: z.object({ token: z.string().default(''), chat: z.string().default('') }), start(ctx) { seen = ctx.config.token } })
    await registry.save('demo', { enabled: true, config: { token: 'bot-123:abc', chat: '42' } })
    expect(seen).toBe('bot-123:abc')
    expect(JSON.stringify(kvGet(store, 'source:demo'))).not.toContain('bot-123')
    expect(secrets.get('source:demo:token')).toBe('bot-123:abc')
    expect(registry.list().find(s => s.id === 'demo')!.config).toEqual({ token: SECRET_SET, chat: '42' })
    await registry.save('demo', { enabled: true, config: { token: SECRET_SET, chat: '43' } })
    expect(seen).toBe('bot-123:abc')
    await registry.save('demo', { enabled: false, config: { token: '', chat: '43' } })
    expect(secrets.get('source:demo:token')).toBeUndefined()
  })
})
