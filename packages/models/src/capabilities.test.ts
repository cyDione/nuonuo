import { openStore, schema, type Store } from '@nuonuo/db'
import { generateText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { capsOf, mergeCatalogs, parseModelCatalog, type ModelInfo } from './discovery'
import type { ModelFactory } from './factory'
import { ModelHub } from './hub'
import { MemorySecrets } from './secrets'

let store: Store
afterEach(() => store?.close())

describe('model capabilities from the list', () => {
  it('reads OpenRouter context, output limit, image input and per-token prices', () => {
    const [m] = parseModelCatalog({ data: [{ id: 'x/vision-1', context_length: 131072, top_provider: { max_completion_tokens: 16384 },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0.0000025', completion: '0.00001', input_cache_read: '0.00000125' } }] })
    expect(m).toMatchObject({ id: 'x/vision-1', type: 'chat', context: 131072, maxOutput: 16384, vision: true, price: { input: 2.5, output: 10, cacheRead: 1.25 } })
  })

  it('reads Gemini limits and says text-only models cannot see images', () => {
    expect(capsOf({ name: 'models/g', inputTokenLimit: 1048576, outputTokenLimit: 65536 })).toEqual({ context: 1048576, maxOutput: 65536 })
    expect(capsOf({ id: 't', architecture: { modality: 'text->text' } })).toEqual({ vision: false })
  })

  it('leaves out what the list does not say, and ignores dynamic prices', () => {
    expect(capsOf({ id: 'plain', object: 'model' })).toEqual({})
    expect(capsOf({ id: 'auto', pricing: { prompt: '-1', completion: '-1' } })).toEqual({})
  })

  it('keeps what one list knows when merging', () => {
    const a: ModelInfo[] = [{ id: 'm', type: 'chat', created: 5 }]
    const b: ModelInfo[] = [{ id: 'm', type: 'chat', context: 32000, vision: false }]
    expect(mergeCatalogs(a, b)).toEqual([{ id: 'm', type: 'chat', created: 5, context: 32000, vision: false }])
  })
})

describe('ModelHub with listed capabilities', () => {
  function setup(list: ModelInfo[]) {
    store = openStore(':memory:')
    const seen: unknown[] = []
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } }, warnings: [] }) })
    const factory: ModelFactory = { language: () => model, embedding: () => { throw new Error('unused') }, listModels: async () => { seen.push(1); return list } }
    const hub = new ModelHub(store, new MemorySecrets(), factory)
    const p = hub.createProvider({ kind: 'openai-compatible', name: 'gw', baseUrl: 'http://gw/v1', apiKey: 'k' })
    return { hub, p, seen }
  }

  it('knows a layer\'s context window and image input once the list is fetched', async () => {
    const { hub, p } = setup([{ id: 'small', type: 'chat', context: 32768, vision: false }, { id: 'big', type: 'chat', context: 1_000_000, vision: true }])
    hub.saveRole('router', { chain: [{ providerId: p.id, model: 'big' }, { providerId: p.id, model: 'small' }] })
    expect(hub.contextWindow('router')).toBeUndefined()
    await hub.listModels(p.id)
    expect(hub.contextWindow('router')).toBe(32768)
    expect(hub.acceptsImages('router')).toBe(true)
    expect(hub.contextWindow('worker')).toBe(32768)
  })

  it('fetches the list in the background when nothing is cached', async () => {
    const { hub, p, seen } = setup([{ id: 'small', type: 'chat', context: 8000 }])
    hub.saveRole('router', { chain: [{ providerId: p.id, model: 'small' }] })
    expect(hub.contextWindow('router')).toBeUndefined()
    await new Promise(r => setTimeout(r, 10))
    expect(seen.length).toBe(1)
    expect(hub.contextWindow('router')).toBe(8000)
  })

  it('costs calls from the listed price unless the owner set one', async () => {
    const { hub, p } = setup([{ id: 'm', type: 'chat', price: { input: 3, output: 15 } }])
    hub.saveRole('router', { chain: [{ providerId: p.id, model: 'm' }] })
    await hub.listModels(p.id)
    await generateText({ model: hub.model('router'), prompt: 'hi' })
    hub.updateProvider(p.id, { options: { prices: { m: { input: 1 } } } })
    await generateText({ model: hub.model('router'), prompt: 'hi' })
    expect(store.db.select().from(schema.usageLedger).all().map(r => r.costUsd)).toEqual([3, 1])
  })
})
