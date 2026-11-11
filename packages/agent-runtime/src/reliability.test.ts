import { openStore, schema, type Store } from '@super-assistant/db'
import { MemorySecrets, ModelHub } from '@super-assistant/models'
import { MockLanguageModelV4 } from 'ai/test'
import { tool } from 'ai'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { Bus } from './bus'
import { AgentRuntime, StepTimeoutError, transient, type AgentDefinition } from './runtime'
import { lastUserText, streamOf, type Scripted } from './testing'

let store: Store
let runtime: AgentRuntime
afterEach(async () => { await runtime?.shutdown(); store?.close() })

/** `script` returns a scripted step, or 'hang' for a model call that never answers. */
function setup(script: (opts: any, call: number) => Scripted | 'hang', options = {}) {
  store = openStore(':memory:')
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async opts => {
      const step = script(opts, call++)
      if (step === 'hang') return { stream: new ReadableStream({ start() { /* never emits */ } }) }
      return streamOf(step)
    },
  })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  hub.saveRole('router', { chain: [{ providerId: hub.createProvider({ kind: 'openai', name: 'mock', apiKey: 'k' }).id, model: 'm' }] })
  runtime = new AgentRuntime(store, hub, new Bus(), options)
}

const def = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  role: 'test', pool: 'worker', system: () => 'sys', tools: () => ({}),
  formatInbox: items => items.map(i => i.payload.text).join('\n'), ...extra,
})
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 30)); await runtime.idle() } }

describe('runtime reliability', () => {
  it('aborts a model call that goes quiet and retries it', async () => {
    setup((_o, call) => (call === 0 ? 'hang' : { text: 'answered' }), { stepIdleMs: 80 })
    let ended: any
    runtime.register(def({ onTurnEnd: (_s, info) => { ended = info } }))
    const id = runtime.createSession('test', 'router')
    store.atomic(() => runtime.push(id, { text: 'hello' }))
    await new Promise(r => setTimeout(r, 1_900))
    await settle()
    expect(ended).toMatchObject({ lastText: 'answered' })
    const markers = runtime.events(id).filter(e => e.kind === 'marker').map(e => e.payload.type)
    expect(markers).toContain('retry')
  })

  it('does not retry a timed-out step after one of its tools already ran', () => {
    expect(transient(new StepTimeoutError(1000))).toBe(true)
    expect(transient(new StepTimeoutError(1000, true))).toBe(false)
  })

  it('keeps an input in the inbox when rendering it fails, so it is not lost', async () => {
    setup(() => ({ text: 'ok' }))
    let fail = true
    let errors = 0
    runtime.register(def({
      formatInbox: items => { if (fail) throw new Error('render failed'); return items.map(i => i.payload.text).join('\n') },
      onTurnError: () => { errors++ },
    }))
    const id = runtime.createSession('test', 'router')
    store.atomic(() => runtime.push(id, { text: 'keep me' }))
    await settle()
    expect(errors).toBe(1)
    expect(runtime.pending(id).map(i => i.payload.text)).toEqual(['keep me'])
    expect(runtime.history(id)).toHaveLength(0)
    fail = false
    runtime.wake(id)
    await settle()
    expect(runtime.pending(id)).toHaveLength(0)
    expect(String(runtime.history(id)[0]!.content)).toContain('keep me')
  })

  it('tells the session about tool calls a stop interrupted, once', async () => {
    const seen: string[] = []
    setup(opts => { seen.push(lastUserText(opts)); return { text: 'checked' } })
    runtime.register(def())
    const id = runtime.createSession('test', 'router')
    // What a crash mid-step leaves: a started call with no end and no recorded message after it.
    runtime.appendEvent(id, 'marker', { type: 'tool-start', tool: 'shell', input: '{"command":"git push"}' })
    store.atomic(() => runtime.push(id, { type: 'recovery', text: 'restarted' }))
    await settle()
    expect(seen[0]).toContain('<interrupted_calls>')
    expect(seen[0]).toContain('git push')
    expect(runtime.interruptedCalls(id)).toEqual([])
    store.atomic(() => runtime.push(id, { text: 'next' }))
    await settle()
    expect(seen[1]).not.toContain('<interrupted_calls>')
  })

  it('records tool calls as they start and end', async () => {
    setup((_o, call) => (call === 0 ? { calls: [{ name: 'poke', input: { n: 1 } }] } : { text: 'done' }))
    runtime.register(def({ tools: () => ({ poke: tool({ inputSchema: z.object({ n: z.number() }), execute: async () => 'ok' }) }) }))
    const id = runtime.createSession('test', 'router')
    store.atomic(() => runtime.push(id, { text: 'go' }))
    await settle()
    const markers = store.db.select().from(schema.sessionEvents).where(eq(schema.sessionEvents.sessionId, id)).all().filter(e => e.kind === 'marker').map(e => e.payload.type)
    expect(markers).toEqual(['tool-start', 'tool-end'])
    expect(runtime.interruptedCalls(id)).toEqual([])
  })
})
