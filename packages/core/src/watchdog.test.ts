import { AgentRuntime, Bus } from '@super-agent/agent-runtime'
import { generateOf, lastUserText, streamOf, systemText, type Scripted } from '@super-agent/agent-runtime/src/testing'
import { newId, openStore, schema, type Store } from '@super-agent/db'
import { MemorySecrets, ModelHub } from '@super-agent/models'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAgents } from './agents'
import { Engine } from './engine'
import { Watchdog, WATCHDOG_SESSION } from './watchdog'

let store: Store
let runtime: AgentRuntime
afterEach(async () => { await runtime?.shutdown(); store?.close() })

function setup() {
  store = openStore(':memory:')
  const script = (opts: any): Scripted => {
    const system = systemText(opts)
    if (system.includes('You are the watchdog')) {
      if (opts.prompt.at(-1).role === 'tool') return { text: 'done' }
      const last = lastUserText(opts)
      const ticket = /ticket_id="(tkt_\w+)"/.exec(last)?.[1]
      if (last.includes('kind="loop"')) return { calls: [{ name: 'nudge_task', input: { ticket_id: ticket, text: '你在重复同一个命令，停下来汇报卡在哪里' } }] }
      if (last.includes('<owner_message')) return { calls: [{ name: 'notify_owner', input: { text: '目前没有卡住的任务。' } }] }
      return { text: 'nothing to do' }
    }
    if (system.includes('main agent ("router")')) return { text: 'ok' }
    return { text: 'idle' }
  }
  const model = new MockLanguageModelV4({ doStream: async o => streamOf(script(o)), doGenerate: async o => generateOf(script(o)) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  hub.saveRole('router', { chain: [{ providerId: hub.createProvider({ kind: 'openai', name: 'm', apiKey: 'k' }).id, model: 'm' }] })
  const bus = new Bus()
  runtime = new AgentRuntime(store, hub, bus)
  const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'sa-wd-')) })
  registerAgents(store, runtime, engine)
  let now = Date.now()
  const watchdog = new Watchdog(store, runtime, engine, { now: () => now, repeats: 3 })
  watchdog.register()
  const cnv = newId('cnv')
  store.db.insert(schema.conversations).values({ id: cnv, title: 't', createdAt: now, updatedAt: now }).run()
  const { triggerId } = engine.receiveMessage(cnv, '做点事')
  const ticket = engine.startTask({ triggerIds: [triggerId], title: '做点事' })
  return { engine, watchdog, ticket, advance: (ms: number) => { now += ms } }
}
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 40)); await runtime.idle() } }

describe('Watchdog', () => {
  it('spots a loop of identical calls, nudges the worker, and does not repeat itself within the quiet window', async () => {
    const { watchdog, ticket } = setup()
    await settle()
    for (let i = 0; i < 3; i++) {
      runtime.appendEvent(ticket.sessionId, 'message', { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'shell', input: { command: 'npm test' } }] })
      runtime.appendEvent(ticket.sessionId, 'message', { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'shell', output: { type: 'text', value: 'fail' } }] })
    }
    expect(watchdog.tick().map(f => f.kind)).toEqual(['loop'])
    await settle()
    expect(JSON.stringify(runtime.history(ticket.sessionId))).toContain('你在重复同一个命令')
    expect(watchdog.probe()).toEqual([])
  })

  it('flags a task that promised to continue but has nothing that will wake it', async () => {
    const { engine, watchdog, ticket, advance } = setup()
    await settle()
    engine.report(ticket.id, { status: 'progress', summary: '稍后继续' })
    await settle()
    expect(watchdog.probe()).toEqual([])
    advance(31 * 60_000)
    expect(watchdog.probe()).toEqual([expect.objectContaining({ kind: 'stalled', ticketId: ticket.id })])
  })

  it('talks with the owner in its own conversation instead of the router', async () => {
    const { engine, watchdog } = setup()
    await settle()
    const cnv = watchdog.conversation()
    expect(watchdog.conversation()).toBe(cnv)
    engine.receiveMessage(cnv, '有任务卡住吗？')
    await settle()
    const messages = store.db.select().from(schema.messages).all().filter(m => m.conversationId === cnv)
    expect(messages.map(m => [m.role, m.content])).toEqual([['user', '有任务卡住吗？'], ['assistant', '目前没有卡住的任务。']])
    expect(runtime.history(WATCHDOG_SESSION).length).toBeGreaterThan(0)
  })
})
