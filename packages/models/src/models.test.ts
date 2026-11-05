import type { LanguageModelV4, LanguageModelV4Usage } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { openStore, type Store } from '@super-assistant/db'
import { generateText, streamText } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelFactory } from './factory'
import { guessModelKind, ModelHub } from './hub'
import { resolveRole, ROLE_IDS, RoleConfigSchema } from './roles'
import { FileSecrets, MemorySecrets } from './secrets'

const usage = (input: number, output: number): LanguageModelV4Usage => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
})
const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: usage(10, 5), warnings: [],
})
const overloaded = () => new APICallError({ message: 'overloaded', url: 'x', requestBodyValues: {}, statusCode: 529, isRetryable: true })
const unauthorized = () => new APICallError({ message: 'bad key', url: 'x', requestBodyValues: {}, statusCode: 401, isRetryable: false })

let store: Store
afterEach(() => store?.close())

function setup(models: Record<string, LanguageModelV4>) {
  store = openStore(':memory:')
  const secrets = new MemorySecrets()
  const seenKeys: (string | undefined)[] = []
  const factory: ModelFactory = {
    language: (_p, key, model) => { seenKeys.push(key); const m = models[model]; if (!m) throw new Error(`no mock ${model}`); return m },
    embedding: () => { throw new Error('unused') },
  }
  let clock = new Date('2026-11-04T10:00:00').getTime()
  const hub = new ModelHub(store, secrets, factory, () => clock)
  return { hub, secrets, seenKeys, advance: (ms: number) => { clock += ms } }
}

describe('resolveRole', () => {
  const cfg = (providerId: string, model: string, extra = {}) => RoleConfigSchema.parse({ chain: [{ providerId, model }], ...extra })
  it('inherits along the layer chain and keeps the asked layer limits', () => {
    const configs = { router: cfg('p', 'small', { temperature: 0.2 }), subagent: RoleConfigSchema.parse({ dailyTokenLimit: 100 }) }
    expect(resolveRole('subagent', configs)).toMatchObject({ source: 'router', config: { temperature: 0.2, dailyTokenLimit: 100 } })
    expect(resolveRole('worker', configs)?.source).toBe('router')
  })
  it('leaves optional layers off without their own model', () => {
    expect(resolveRole('filter', { router: cfg('p', 'small') })).toBeUndefined()
    expect(resolveRole('embedding', { router: cfg('p', 'small') })).toBeUndefined()
    expect(resolveRole('filter', { filter: cfg('p', 'tiny', { enabled: false }) })).toBeUndefined()
  })
})

describe('ModelHub', () => {
  it('stores keys only in the secret store and hands them to the factory', async () => {
    const { hub, secrets, seenKeys } = setup({ m: new MockLanguageModelV4({ doGenerate: textResult('hi') }) })
    const p = hub.createProvider({ kind: 'anthropic', name: 'A', apiKey: 'sk-secret-1234' })
    expect(p).toMatchObject({ hasKey: true, keyHint: '…1234' })
    expect(JSON.stringify(store.sqlite.prepare('select * from providers').all())).not.toContain('sk-secret')
    hub.saveRole('router', { chain: [{ providerId: p.id, model: 'm' }] })
    const result = await generateText({ model: hub.model('router'), prompt: 'x' })
    expect(result.text).toBe('hi')
    expect(seenKeys).toEqual(['sk-secret-1234'])
    hub.updateProvider(p.id, { apiKey: null })
    expect(secrets.get(`provider:${p.id}`)).toBeUndefined()
  })

  it('applies layer defaults and records usage', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: textResult('ok') })
    const { hub } = setup({ m: mock })
    const p = hub.createProvider({ kind: 'openai', name: 'O', apiKey: 'k' })
    hub.saveRole('worker', { chain: [{ providerId: p.id, model: 'm' }], reasoning: 'high', maxOutputTokens: 777, temperature: 0.3 })
    await generateText({ model: hub.model('worker', { ref: 'tkt_1' }), prompt: 'x' })
    expect(mock.doGenerateCalls[0]).toMatchObject({ reasoning: 'high', maxOutputTokens: 777, temperature: 0.3 })
    expect(hub.usageSince(0)).toEqual([expect.objectContaining({ role: 'worker', model: 'm', calls: 1, inputTokens: 10, outputTokens: 5 })])
  })

  it('falls back on retryable errors but not on auth errors', async () => {
    const flaky = new MockLanguageModelV4({ doGenerate: async () => { throw overloaded() } })
    const denied = new MockLanguageModelV4({ doGenerate: async () => { throw unauthorized() } })
    const good = new MockLanguageModelV4({ doGenerate: textResult('backup') })
    const { hub } = setup({ flaky, denied, good })
    const p = hub.createProvider({ kind: 'openai', name: 'O', apiKey: 'k' })
    hub.saveRole('router', { chain: [{ providerId: p.id, model: 'flaky' }, { providerId: p.id, model: 'good' }] })
    expect((await generateText({ model: hub.model('router'), prompt: 'x', maxRetries: 0 })).text).toBe('backup')
    hub.saveRole('router', { chain: [{ providerId: p.id, model: 'denied' }, { providerId: p.id, model: 'good' }] })
    await expect(generateText({ model: hub.model('router'), prompt: 'x', maxRetries: 0 })).rejects.toThrow('bad key')
    expect(hub.usageSince(0).find(r => r.model === 'flaky')).toMatchObject({ calls: 1, failures: 1 })
  })

  it('records streamed usage and enforces the daily token budget', async () => {
    const streaming = new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream([
        { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'he' }, { type: 'text-delta', id: '1', delta: 'llo' },
        { type: 'text-end', id: '1' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(60, 50) },
      ]) }),
    })
    const { hub, advance } = setup({ s: streaming })
    const p = hub.createProvider({ kind: 'openai', name: 'O', apiKey: 'k' })
    hub.saveRole('router', { chain: [{ providerId: p.id, model: 's' }], dailyTokenLimit: 100 })
    const result = streamText({ model: hub.model('router'), prompt: 'x' })
    expect(await result.text).toBe('hello')
    expect(hub.usageToday('router').tokens).toBe(110)
    await expect(generateText({ model: hub.model('router'), prompt: 'x' })).rejects.toThrow(/daily token limit/)
    advance(24 * 3600_000)
    expect(hub.usageToday('router').tokens).toBe(0)
  })

  it('drops a deleted provider from every layer chain', () => {
    const { hub } = setup({})
    const a = hub.createProvider({ kind: 'openai', name: 'A', apiKey: 'k' })
    const b = hub.createProvider({ kind: 'openai', name: 'B', apiKey: 'k' })
    hub.saveRole('router', { chain: [{ providerId: a.id, model: 'x' }, { providerId: b.id, model: 'y' }] })
    hub.deleteProvider(a.id)
    expect(hub.roleConfigs().router?.chain).toEqual([{ providerId: b.id, model: 'y' }])
    expect(() => hub.saveRole('router', { chain: [{ providerId: a.id, model: 'x' }] })).toThrow(/no provider/)
  })
})

describe('FileSecrets', () => {
  it('encrypts at rest and survives reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-secrets-'))
    new FileSecrets(dir).set('provider:x', 'sk-plaintext-value')
    expect(readFileSync(join(dir, 'secrets.enc')).toString('latin1')).not.toContain('sk-plaintext')
    const reopened = new FileSecrets(dir)
    expect(reopened.get('provider:x')).toBe('sk-plaintext-value')
    reopened.delete('provider:x')
    expect(new FileSecrets(dir).get('provider:x')).toBeUndefined()
  })
})

describe('environment providers', () => {
  it('registers env keys as read-only providers without copying them, and sets a default model once', async () => {
    store = openStore(':memory:')
    const { EnvAwareSecrets } = await import('./env')
    const env = { OPENAI_API_KEY: 'sk-env-openai-5678' }
    const inner = new MemorySecrets()
    const seen: (string | undefined)[] = []
    const hub = new ModelHub(store, new EnvAwareSecrets(inner, env), {
      language: (_p, key) => { seen.push(key); return new MockLanguageModelV4({ doGenerate: textResult('ok') }) },
      embedding: () => { throw new Error('unused') },
    })
    const [id] = hub.syncEnvProviders(env)
    expect(hub.syncEnvProviders(env)).toEqual([])
    expect(hub.listProviders()[0]).toMatchObject({ kind: 'openai', hasKey: true, keyHint: '…5678', keyEnv: 'OPENAI_API_KEY' })
    expect(JSON.stringify(store.sqlite.prepare('select * from providers').all())).not.toContain('sk-env')
    expect(() => hub.updateProvider(id!, { apiKey: 'other' })).toThrow(/环境变量/)
    expect(hub.applyDefaultModel(id!, 'test-model')).toBe(true)
    for (const role of ['router', 'worker', 'subagent', 'reviewer', 'watchdog', 'summarizer', 'vision'] as const) {
      expect(hub.resolve(role)?.config.chain[0]?.model, role).toBe('test-model')
    }
    expect(hub.resolve('filter')).toBeUndefined()
    expect(hub.applyDefaultModel(id!, 'other-model')).toBe(false)
    await generateText({ model: hub.model('router'), prompt: 'x' })
    expect(seen).toEqual(['sk-env-openai-5678'])
  })
})

describe('testModel', () => {
  it('tests embedding models through the embeddings endpoint, not chat', async () => {
    store = openStore(':memory:')
    const languageCalls: string[] = []
    const embedded: string[][] = []
    const hub = new ModelHub(store, new MemorySecrets(), {
      language: (_p, _k, model) => { languageCalls.push(model); throw new Error('chat endpoint used') },
      embedding: (_p, _k, model) => ({
        specificationVersion: 'v4', provider: 'mock', modelId: model, maxEmbeddingsPerCall: 8, supportsParallelCalls: true,
        doEmbed: async ({ values }) => { embedded.push(values); return { embeddings: values.map(() => [0.1, 0.2, 0.3]), warnings: [] } },
      }),
    })
    const p = hub.createProvider({ kind: 'openai-compatible', name: 'SF', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'k' })
    const result = await hub.testModel({ providerId: p.id, model: 'BAAI/bge-m3' }, 'embedding')
    expect(result).toMatchObject({ ok: true, text: '3 维向量' })
    expect(embedded).toEqual([['ping']])
    expect(languageCalls).toEqual([])
  })

  it('explains a missing model on the embedding layer', async () => {
    store = openStore(':memory:')
    const missing = new APICallError({ message: 'SiliconFlow: Model does not exist. Please check it carefully.', url: 'x', requestBodyValues: {}, statusCode: 400 })
    const hub = new ModelHub(store, new MemorySecrets(), {
      language: () => { throw new Error('unused') },
      embedding: (_p, _k, model) => ({
        specificationVersion: 'v4', provider: 'mock', modelId: model, maxEmbeddingsPerCall: 8, supportsParallelCalls: true,
        doEmbed: async () => { throw missing },
      }),
    })
    const p = hub.createProvider({ kind: 'openai-compatible', name: 'SF', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'k' })
    const result = await hub.testModel({ providerId: p.id, model: 'Qwen/Qwen3-8B' }, 'embedding')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/400 .*Model does not exist[\s\S]*向量层需要 embedding 模型/)
  })

  it('guesses the kind from the model id when none is given (the provider page)', async () => {
    store = openStore(':memory:')
    const used: string[] = []
    const hub = new ModelHub(store, new MemorySecrets(), {
      language: () => { used.push('language'); throw new Error('chat endpoint used') },
      embedding: (_p, _k, model) => ({
        specificationVersion: 'v4', provider: 'mock', modelId: model, maxEmbeddingsPerCall: 8, supportsParallelCalls: true,
        doEmbed: async ({ values }) => { used.push('embedding'); return { embeddings: values.map(() => [0.1, 0.2]), warnings: [] } },
      }),
    })
    const p = hub.createProvider({ kind: 'openai-compatible', name: 'SF', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'k' })
    expect(await hub.testModel({ providerId: p.id, model: 'BAAI/bge-m3' })).toMatchObject({ ok: true, text: '2 维向量' })
    expect(used).toEqual(['embedding'])
  })
})

describe('guessModelKind', () => {
  it('recognises common embedding model ids', () => {
    for (const m of ['text-embedding-3-small', 'BAAI/bge-m3', 'bge-large-zh-v1.5', 'nomic-embed-text', 'intfloat/e5-mistral-7b-instruct', 'thenlper/gte-large', 'gemini-embedding-001'])
      expect(guessModelKind(m), m).toBe('embedding')
    for (const m of ['gpt-5', 'claude-sonnet-5-5', 'Qwen/Qwen3-8B', 'gemini-3-pro', 'llama-3.3-70b'])
      expect(guessModelKind(m), m).toBe('language')
  })
})

describe('decision models (TypeSafe Jev)', () => {
  it('may only serve the review layer, and the main model is not replaced by it', () => {
    store = openStore(':memory:')
    const hub = new ModelHub(store, new MemorySecrets(), { language: () => { throw new Error('x') }, embedding: () => { throw new Error('x') } })
    const llm = hub.createProvider({ kind: 'openai', name: 'o', apiKey: 'k' })
    const jev = hub.createProvider({ kind: 'typesafe', name: 'TypeSafe', apiKey: 'k' })
    expect(() => hub.saveRole('router', { chain: [{ providerId: jev.id, model: 'jev-latest' }] })).toThrow(/决策模型，只能用于审核/)
    hub.saveRole('router', { chain: [{ providerId: llm.id, model: 'm' }] })
    expect(hub.usesDecisionModel('reviewer')).toBe(false)
    hub.saveRole('reviewer', { chain: [{ providerId: jev.id, model: 'jev-latest' }] })
    expect(hub.usesDecisionModel('reviewer')).toBe(true)
  })

  it('posts state and questions to /systemone with the key, and surfaces HTTP errors as API errors', async () => {
    const { decisionEndpoints, systemOneClient } = await import('./systemone')
    const seen: { url: string; init: RequestInit }[] = []
    const ok = systemOneClient(decisionEndpoints(null, 'typesafe'), 'sk-1', {}, (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ model: 'jev-1', answers: { d: { type: 'noul', noul: 0.9 } } }), { status: 200 })
    }) as any)
    expect(await ok({ model: 'jev-latest', state: 's', questions: { d: { type: 'noul', instructions: 'x' } } })).toMatchObject({ answers: { d: { noul: 0.9 } } })
    expect(seen[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-1')
    const busy = systemOneClient('https://example.test/v1/', 'k', {}, (async () => new Response('{"error":"overloaded"}', { status: 529 })) as any)
    const error = await busy({ model: 'jev-latest', state: 's', questions: { d: { type: 'noul' } } }).catch(e => e)
    expect(APICallError.isInstance(error) && error.statusCode === 529 && error.isRetryable).toBe(true)
  })
})

describe('Jev through a multi-provider gateway', () => {
  it('recognises Jev model names, but not the chat router', async () => {
    const { isDecisionModel } = await import('./catalog')
    for (const id of ['jev-latest', 'typesafe/jev-1.13', 'group/jev', 'JEV-preview']) expect(isDecisionModel('openai-compatible', id)).toBe(true)
    for (const id of ['typesafe/jev-router', 'deepseek-v4.1-flash', 'group/jevons-7b']) expect(isDecisionModel('openai-compatible', id)).toBe(false)
    expect(isDecisionModel('typesafe', 'anything')).toBe(true)
  })

  it('lets the review layer use a gateway\'s Jev model, and only the review layer', () => {
    store = openStore(':memory:')
    const hub = new ModelHub(store, new MemorySecrets(), { language: () => { throw new Error('x') }, embedding: () => { throw new Error('x') } })
    const gw = hub.createProvider({ kind: 'openai-compatible', name: '聚合网关', baseUrl: 'https://gw.example/v1', apiKey: 'k' })
    hub.saveRole('router', { chain: [{ providerId: gw.id, model: 'group/deepseek-v4.1-flash' }] })
    expect(() => hub.saveRole('worker', { chain: [{ providerId: gw.id, model: 'typesafe/jev-1.13' }] })).toThrow(/决策模型/)
    expect(hub.usesDecisionModel('reviewer')).toBe(false)
    hub.saveRole('reviewer', { chain: [{ providerId: gw.id, model: 'typesafe/jev-1.13' }] })
    expect(hub.usesDecisionModel('reviewer')).toBe(true)
  })

  it('finds the gateway\'s decisions endpoint and remembers it', async () => {
    const { decisionEndpoints, systemOneClient } = await import('./systemone')
    expect(decisionEndpoints('https://openrouter.ai/api/v1', 'openai-compatible')).toContain('https://openrouter.ai/api/alpha/decisions')
    expect(decisionEndpoints('https://gw.example/v1', 'openai-compatible', 'https://gw.example/custom/decide')).toEqual(['https://gw.example/custom/decide'])
    const hits: string[] = []
    const fetchImpl = (async (url: string) => {
      hits.push(url)
      return url.endsWith('/v1/decisions')
        ? new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { d: { type: 'choice', choice: 'allow', confidence: 0.9, probabilities: {} } } }), { status: 200 })
        : new Response('{"error":{"message":"Invalid URL"}}', { status: 404 })
    }) as any
    const client = systemOneClient(decisionEndpoints('https://gw2.example/v1', 'openai-compatible'), 'k', {}, fetchImpl)
    const request = { model: 'typesafe/jev-1.13', state: 's', questions: { d: { type: 'choice' as const, criteria: { allow: 'a' } } } }
    expect((await client(request)).answers.d).toMatchObject({ choice: 'allow' })
    expect(hits).toEqual(['https://gw2.example/v1/systemone', 'https://gw2.example/v1/decisions'])
    await client(request)
    expect(hits.at(-1)).toBe('https://gw2.example/v1/decisions')
    expect(hits).toHaveLength(3)
    const none = systemOneClient(['https://gw3.example/v1/systemone'], 'k', {}, (async () => new Response('nope', { status: 404 })) as any)
    await expect(none(request)).rejects.toThrow(/没有找到决策接口/)
  })

  it('offers the gateway\'s Jev on the review layer even when /models does not list it, and only there', async () => {
    store = openStore(':memory:')
    let live: string[] | Error = ['group/deepseek-v4.1-flash', 'gpt-x']
    let calls = 0
    const factory: ModelFactory = {
      language: () => { throw new Error('unused') }, embedding: () => { throw new Error('unused') },
      listModels: async () => { calls++; if (live instanceof Error) throw live; return live },
    }
    const hub = new ModelHub(store, new MemorySecrets(), factory)
    const gw = hub.createProvider({ kind: 'openai-compatible', name: '聚合网关', baseUrl: 'https://gw.example/v1', apiKey: 'k' })
    expect((await hub.modelOptions(gw.id, 'reviewer')).models).toEqual(['jev-latest', 'group/deepseek-v4.1-flash', 'gpt-x'])
    expect((await hub.modelOptions(gw.id, 'router')).models).toEqual(['group/deepseek-v4.1-flash', 'gpt-x'])
    live = ['gpt-x', 'typesafe/jev-1.13']
    expect((await hub.modelOptions(gw.id, 'reviewer')).models).toEqual(['jev-latest', 'typesafe/jev-1.13', 'gpt-x'])
    expect((await hub.modelOptions(gw.id, 'worker')).models).toEqual(['gpt-x'])
    // A failure keeps the suggestions and says why; every call asks the provider again, so a retry picks up a fixed key.
    live = new Error('401 Unauthorized')
    expect(await hub.modelOptions(gw.id, 'reviewer')).toEqual({ models: ['jev-latest'], error: '401 Unauthorized' })
    live = ['gpt-y']
    expect(await hub.modelOptions(gw.id, 'reviewer')).toEqual({ models: ['jev-latest', 'gpt-y'] })
    expect(calls).toBe(6)
    const ts = hub.createProvider({ kind: 'typesafe', name: 'TypeSafe', apiKey: 'k' })
    expect((await hub.modelOptions(ts.id, 'reviewer')).models).toEqual(['jev-latest', 'gpt-y'])
  })

  it('reads model lists in the shapes gateways send', async () => {
    const { parseModelList } = await import('./factory')
    expect(parseModelList({ object: 'list', data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] })).toEqual(['a', 'b'])
    expect(parseModelList({ models: [{ name: 'models/gemini-x' }] })).toEqual(['gemini-x'])
    expect(parseModelList([{ id: 'jev-latest' }, 'plain'])).toEqual(['jev-latest', 'plain'])
    expect(parseModelList({ success: true, data: { models: [{ model: 'm1' }] } })).toEqual(['m1'])
    expect(parseModelList({ data: ['x', null, { id: '' }] })).toEqual(['x'])
    expect(parseModelList({ error: 'nope' })).toEqual([])
  })
})
