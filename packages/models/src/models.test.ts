import type { LanguageModelV4, LanguageModelV4Usage } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { openStore, type Store } from '@super-agent/db'
import { generateText, streamText } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelFactory } from './factory'
import { ModelHub } from './hub'
import { resolveRole, RoleConfigSchema } from './roles'
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

describe('environment providers and presets', () => {
  it('registers env keys as read-only providers without copying them, and applies the DeepSeek preset once', async () => {
    store = openStore(':memory:')
    const { EnvAwareSecrets } = await import('./env')
    const env = { DEEPSEEK_API_KEY: 'sk-env-deepseek-5678' }
    const inner = new MemorySecrets()
    const seen: (string | undefined)[] = []
    const hub = new ModelHub(store, new EnvAwareSecrets(inner, env), {
      language: (_p, key) => { seen.push(key); return new MockLanguageModelV4({ doGenerate: textResult('ok') }) },
      embedding: () => { throw new Error('unused') },
    })
    const [id] = hub.syncEnvProviders(env)
    expect(hub.syncEnvProviders(env)).toEqual([])
    expect(hub.listProviders()[0]).toMatchObject({ kind: 'deepseek', hasKey: true, keyHint: '…5678', keyEnv: 'DEEPSEEK_API_KEY' })
    expect(JSON.stringify(store.sqlite.prepare('select * from providers').all())).not.toContain('sk-env')
    expect(() => hub.updateProvider(id!, { apiKey: 'other' })).toThrow(/环境变量/)
    expect(hub.applyPreset('deepseek', id!, { onlyIfEmpty: true })).toBe(true)
    expect(hub.roleConfigs().router).toMatchObject({ chain: [{ model: 'deepseek-flash' }], reasoning: 'high' })
    expect(hub.resolve('subagent')).toMatchObject({ source: 'worker', config: { chain: [{ model: 'deepseek-v4-pro' }] } })
    expect(hub.resolve('filter')).toBeUndefined()
    expect(hub.applyPreset('deepseek', id!, { onlyIfEmpty: true })).toBe(false)
    await generateText({ model: hub.model('router'), prompt: 'x' })
    expect(seen).toEqual(['sk-env-deepseek-5678'])
    expect(hub.getProvider(id!).options.prices?.['deepseek-flash']?.output).toBe(1.2)
  })
})

describe('resolvePresetModel', async () => {
  const { resolvePresetModel } = await import('./presets')
  it('maps preset ids onto a gateway\'s model names', () => {
    const gateway = ['group/deepseek-v4.1-flash', 'siliconflow/BAAI/bge-m3']
    expect(resolvePresetModel('deepseek-flash', gateway)).toBe('group/deepseek-v4.1-flash')
    expect(resolvePresetModel('deepseek-v4-pro', gateway)).toBe('group/deepseek-v4.1-flash')
    expect(resolvePresetModel('deepseek-v4-pro', ['deepseek-flash', 'deepseek-v4-pro'])).toBe('deepseek-v4-pro')
    expect(resolvePresetModel('deepseek-flash', undefined)).toBe('deepseek-flash')
  })
})
