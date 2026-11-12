import type { LanguageModelV4, LanguageModelV4Usage } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { openStore, type Store } from '@nuonuo/db'
import { generateText, streamText } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelFactory } from './factory'
import { guessModelKind, ModelHub } from './hub'
import { resolveRole, ROLE_IDS, RoleConfigSchema } from './roles'
import { FileSecrets, KeychainMigratingSecrets, KeychainSecrets, MemorySecrets, openSecretStore } from './secrets'

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

describe('keychain names', () => {
  it('moves a key saved under the old service name (super-assistant) to nuonuo on first read', () => {
    const items = new Map([['super-assistant/provider:a', 'sk-a']])
    class Entry {
      constructor(private service: string, private account: string) {}
      private get key() { return `${this.service}/${this.account}` }
      getPassword() { return items.get(this.key) }
      setPassword(v: string) { items.set(this.key, v) }
      deletePassword() { items.delete(this.key) }
    }
    const store = new KeychainSecrets(Entry)
    expect(store.get('provider:a')).toBe('sk-a')
    expect([...items]).toEqual([['nuonuo/provider:a', 'sk-a']])
    expect(store.get('provider:b')).toBeUndefined()
  })
})

describe('macOS secrets', () => {
  it('uses the encrypted file and moves a Keychain key into it on first read, touching the Keychain once', () => {
    const items = new Map([['provider:old', 'sk-old']])
    let reads = 0
    class Entry {
      constructor(private service: string, private account: string) {}
      getPassword() { reads++; return items.get(this.account) }
      setPassword(v: string) { items.set(this.account, v) }
      deletePassword() { items.delete(this.account) }
    }
    const dir = mkdtempSync(join(tmpdir(), 'sa-secrets-'))
    const store = new KeychainMigratingSecrets(new FileSecrets(dir), new KeychainSecrets(Entry))
    expect(store.get('provider:old')).toBe('sk-old')
    expect(store.get('provider:old')).toBe('sk-old')
    expect(store.get('provider:none')).toBeUndefined()
    expect(store.get('provider:none')).toBeUndefined()
    // provider:none is looked up under the new and the old (super-assistant) Keychain name, once.
    expect(reads).toBe(3)
    store.set('provider:new', 'sk-new')
    expect(items.has('provider:new')).toBe(false)
    expect(new FileSecrets(dir).get('provider:old')).toBe('sk-old')
    expect(new KeychainMigratingSecrets(new FileSecrets(dir), new KeychainSecrets(Entry)).get('provider:old')).toBe('sk-old')
    expect(reads).toBe(3)
  })

  it('defaults to the file store on macOS unless the keychain is asked for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-secrets-'))
    const { store } = await openSecretStore(dir, undefined, 'darwin')
    expect(store.backend).toBe('file')
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

  it('adds a missing /v1 to the base URL and explains a 401 from a gateway\'s web page', async () => {
    const { decisionEndpoints, systemOneClient } = await import('./systemone')
    expect(decisionEndpoints('https://magpie.example', 'typesafe')).toEqual(['https://magpie.example/v1/systemone'])
    expect(decisionEndpoints('https://magpie.example/', 'openai-compatible')[0]).toBe('https://magpie.example/v1/systemone')
    expect(decisionEndpoints('https://magpie.example/v1/systemone', 'typesafe')).toEqual(['https://magpie.example/v1/systemone'])
    expect(decisionEndpoints('https://api.typesafe.ai/v1', 'typesafe')).toEqual(['https://api.typesafe.ai/v1/systemone'])
    const request = { model: 'jev-latest', state: 's', questions: { d: { type: 'noul' as const } } }
    const page = systemOneClient(['https://gw4.example/systemone'], 'k', {}, (async () => new Response('open the link magpie web printed', { status: 401, statusText: 'Unauthorized' })) as any)
    await expect(page(request)).rejects.toThrow(/Base URL 可能指向了网页.*\/v1/)
    const badKey = systemOneClient(['https://gw5.example/v1/systemone'], 'k', {}, (async () => new Response('{"error":{"message":"not an enabled key"}}', { status: 401, statusText: 'Unauthorized' })) as any)
    await expect(badKey(request)).rejects.toThrow(/检查 API Key/)
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
    expect((await hub.modelOptions(gw.id, 'reviewer')).models).toEqual(['jev-latest', 'gpt-x', 'group/deepseek-v4.1-flash'])
    expect((await hub.modelOptions(gw.id, 'router')).models).toEqual(['gpt-x', 'group/deepseek-v4.1-flash'])
    live = ['gpt-x', 'typesafe/jev-1.13']
    // The gateway names its own Jev, so the generic suggestion is not added beside it.
    expect((await hub.modelOptions(gw.id, 'reviewer')).models).toEqual(['typesafe/jev-1.13', 'gpt-x'])
    expect((await hub.modelOptions(gw.id, 'worker')).models).toEqual(['gpt-x'])
    // A failure falls back to the last list the provider gave and says why; every call asks the provider again, so a retry
    // picks up a fixed key.
    live = new Error('401 Unauthorized')
    const failed = await hub.modelOptions(gw.id, 'reviewer')
    expect(failed).toMatchObject({ models: ['typesafe/jev-1.13', 'gpt-x'], error: '401 Unauthorized' })
    expect(failed.cachedAt).toBeTypeOf('number')
    live = ['gpt-y']
    expect(await hub.modelOptions(gw.id, 'reviewer')).toMatchObject({ models: ['jev-latest', 'gpt-y'] })
    expect(calls).toBe(6)
    const ts = hub.createProvider({ kind: 'typesafe', name: 'TypeSafe', apiKey: 'k' })
    expect((await hub.modelOptions(ts.id, 'reviewer')).models).toEqual(['jev-latest', 'gpt-y'])
  })

  it('lists live models newest first and never offers a hard-coded model id beside them', async () => {
    store = openStore(':memory:')
    const { parseModelCatalog } = await import('./discovery')
    // Anthropic dates models with ISO `created_at`, OpenAI-style lists with `created` in seconds.
    const anthropic = parseModelCatalog({ data: [{ id: 'claude-old', created_at: '2025-01-01T00:00:00Z' }, { id: 'claude-new', created_at: '2026-10-01T00:00:00Z' }] }, 'anthropic')
    expect(anthropic.map(m => m.id)).toEqual(['claude-new', 'claude-old'])
    expect(parseModelCatalog({ data: [{ id: 'a', created: 1_700_000_000 }, { id: 'b', created: 1_790_000_000 }, { id: 'c' }] }).map(m => m.id)).toEqual(['b', 'a', 'c'])
    const factory: ModelFactory = { language: () => { throw new Error('unused') }, embedding: () => { throw new Error('unused') }, listModels: async () => anthropic }
    const hub = new ModelHub(store, new MemorySecrets(), factory)
    const p = hub.createProvider({ kind: 'anthropic', name: 'Anthropic', apiKey: 'k' })
    expect((await hub.modelOptions(p.id, 'router')).models).toEqual(['claude-new', 'claude-old'])
  })

  it('starts a new install on a model picked from the live list, and only when no layer is set', async () => {
    store = openStore(':memory:')
    const { pickDefaultModel } = await import('./discovery')
    const t = (id: string, created?: number, type: 'chat' | 'embedding' = 'chat') => ({ id, type, ...(created ? { created } : {}) })
    expect(pickDefaultModel([t('gpt-a', 1), t('gpt-b-realtime', 9), t('gpt-b-mini', 8), t('gpt-b', 7), t('text-embedding-z', 10, 'embedding')])).toBe('gpt-b')
    expect(pickDefaultModel([t('gemini-2.5-pro'), t('gemini-10-pro'), t('gemini-10-flash-lite'), t('gemini-11-pro-preview')])).toBe('gemini-10-pro')
    expect(pickDefaultModel([t('llama-3.3-70b'), t('qwen3-8b')])).toBe('llama-3.3-70b')
    expect(pickDefaultModel([t('bge-m3', undefined, 'embedding')])).toBeUndefined()
    let live: { id: string; type: 'chat'; created: number }[] | Error = [t('m-old', 1) as any, t('m-new', 2) as any]
    const factory: ModelFactory = { language: () => { throw new Error('unused') }, embedding: () => { throw new Error('unused') },
      listModels: async () => { if (live instanceof Error) throw live; return live } }
    const hub = new ModelHub(store, new MemorySecrets(), factory)
    const p = hub.createProvider({ kind: 'openai', name: 'OpenAI', apiKey: 'k' })
    expect(await hub.applyLiveDefault(p.id)).toBe('m-new')
    expect(hub.resolve('worker')?.config.chain[0]).toEqual({ providerId: p.id, model: 'm-new' })
    live = [t('m-newer', 3) as any]
    expect(await hub.applyLiveDefault(p.id)).toBeUndefined()
    expect(hub.resolve('router')?.config.chain[0]?.model).toBe('m-new')
    const ts = hub.createProvider({ kind: 'typesafe', name: 'TypeSafe', apiKey: 'k' })
    hub.saveRole('router', { enabled: true, chain: [] })
    expect(await hub.applyLiveDefault(ts.id)).toBeUndefined()
  })

  it('lists every model of an aggregation gateway with its type, and puts the layer\'s kind first', async () => {
    store = openStore(':memory:')
    const live = [{ id: 'group/deepseek-v4.1-flash', type: 'chat' as const }, { id: 'siliconflow/BAAI/bge-m3', type: 'embedding' as const },
      { id: 'siliconflow/BAAI/bge-reranker-v2-m3', type: 'rerank' as const }, { id: 'typesafe/jev-latest', type: 'decision' as const }]
    const factory: ModelFactory = { language: () => { throw new Error('unused') }, embedding: () => { throw new Error('unused') }, listModels: async () => live }
    const hub = new ModelHub(store, new MemorySecrets(), factory)
    const gw = hub.createProvider({ kind: 'openai-compatible', name: '聚合网关', baseUrl: 'https://gw.example/v1', apiKey: 'k' })
    const all = await hub.modelOptions(gw.id)
    expect(all.models).toEqual(['group/deepseek-v4.1-flash', 'siliconflow/BAAI/bge-m3', 'siliconflow/BAAI/bge-reranker-v2-m3', 'typesafe/jev-latest'])
    expect(all.types).toMatchObject({ 'siliconflow/BAAI/bge-m3': 'embedding', 'typesafe/jev-latest': 'decision', 'group/deepseek-v4.1-flash': 'chat' })
    expect((await hub.modelOptions(gw.id, 'embedding')).models).toEqual(['siliconflow/BAAI/bge-m3', 'group/deepseek-v4.1-flash', 'siliconflow/BAAI/bge-reranker-v2-m3'])
    expect((await hub.modelOptions(gw.id, 'reviewer')).models[0]).toBe('typesafe/jev-latest')
    expect((await hub.modelOptions(gw.id, 'router')).models[0]).toBe('group/deepseek-v4.1-flash')
  })

  it('finds embedding models OpenRouter keeps off /models, and the Jev a gateway serves on its decision endpoint', async () => {
    const { listProviderModels } = await import('./factory')
    const hits: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      hits.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'openai/gpt-x', architecture: { modality: 'text->text', output_modalities: ['text'] } }] })
      if (url.endsWith('/embeddings/models')) return Response.json({ data: [{ id: 'cohere/embed-5-fast', architecture: { modality: 'text+image->embeddings', output_modalities: ['embeddings'] } }, { id: 'qwen/qwen3-emb-8b' }] })
      if (url.endsWith('/v1/systemone')) return Response.json({ error: { message: 'magpie knows no Jev model "?"; name the provider before it, like typesafe/jev-latest' } }, { status: 404 })
      return Response.json({ error: { message: 'not found' } }, { status: 404 })
    }) as typeof fetch
    const p = { id: 'p', kind: 'openai-compatible' as const, name: 'gw', baseUrl: 'https://gw.example/v1', secretRef: null, options: {} }
    expect(await listProviderModels(p, 'k', fetchImpl)).toEqual([
      { id: 'cohere/embed-5-fast', type: 'embedding', vision: true }, { id: 'openai/gpt-x', type: 'chat', vision: false },
      { id: 'qwen/qwen3-emb-8b', type: 'embedding' }, { id: 'typesafe/jev-latest', type: 'decision' }])
    expect(hits).toContain('POST https://gw.example/v1/systemone')
    // No decision endpoint and no embeddings list: just /models, and a failed /models still fails.
    const plain = (async (url: string) => url.endsWith('/v1/models') ? Response.json({ data: [{ id: 'm' }] }) : new Response('<html>', { status: 404 })) as typeof fetch
    expect(await listProviderModels(p, 'k', plain)).toEqual([{ id: 'm', type: 'chat' }])
    await expect(listProviderModels(p, 'k', (async () => new Response('', { status: 401, statusText: 'Unauthorized' })) as typeof fetch)).rejects.toThrow('401')
  })

  it('types models from list metadata and from their ids', async () => {
    const { parseModelCatalog, typeFromId, jevIdsIn } = await import('./discovery')
    expect(parseModelCatalog({ data: [
      { id: 'a', type: 'embedding' }, { id: 'b', sub_type: 'reranker' }, { id: 'c', type: 'model', native_endpoints: ['/v1/chat/completions'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }, { id: 'siliconflow/BAAI/bge-m3', type: 'model' },
    ] })).toEqual([{ id: 'a', type: 'embedding' }, { id: 'b', type: 'rerank' }, { id: 'c', type: 'chat' },
      { id: 'siliconflow/BAAI/bge-m3', type: 'embedding' }, { id: 'text-embedding-004', type: 'embedding' }])
    expect(['gpt-6', 'deepseek-v4.1-flash', 'claude-sonnet-5-5', 'jev-router'].map(m => typeFromId(m))).toEqual(['chat', 'chat', 'chat', 'chat'])
    expect(['BAAI/bge-reranker-v2-m3', 'jev-latest', 'whisper-1', 'dall-e-3', 'sora-2'].map(m => typeFromId(m))).toEqual(['rerank', 'decision', 'audio', 'image', 'video'])
    expect(jevIdsIn('name the provider before it, like typesafe/jev-latest.')).toEqual(['typesafe/jev-latest'])
    expect(jevIdsIn('unknown model gpt-x')).toEqual([])
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
