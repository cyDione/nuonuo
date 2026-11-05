import { generateOf, systemText } from '@super-assistant/agent-runtime/src/testing'
import { openStore, type Store } from '@super-assistant/db'
import { MemorySecrets, ModelHub, type RoleConfig } from '@super-assistant/models'
import { APICallError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { generateStructured, jsonCandidates, StructuredCallError } from './structured'

const Verdict = z.object({ decision: z.enum(['allow', 'block', 'ask_owner']), reason: z.string() })
const request = { system: 'You review one action.', prompt: 'git push origin main', schema: Verdict,
  fields: '- decision: "allow" | "block" | "ask_owner"\n- reason: one sentence', example: { decision: 'ask_owner' as const, reason: '需要确认' } }

let store: Store
afterEach(() => store?.close())

type Call = { model: string; options: any }
/** A hub whose models answer by id; `reply` gets the model id and returns text or throws. */
function hubWith(reply: (model: string, options: any) => string | { text: string; finish?: 'stop' | 'length' }, roles: Record<string, Partial<RoleConfig>> = { router: {} }) {
  store = openStore(':memory:')
  const calls: Call[] = []
  const hub = new ModelHub(store, new MemorySecrets(), {
    language: (_p, _k, id) => new MockLanguageModelV4({ doGenerate: async options => {
      calls.push({ model: id, options })
      const r = reply(id, options)
      const { text, finish } = typeof r === 'string' ? { text: r, finish: 'stop' as const } : r
      return { ...generateOf({ text }), finishReason: { unified: finish ?? 'stop', raw: undefined } }
    } }),
    embedding: () => { throw new Error('x') },
  })
  const providerId = hub.createProvider({ kind: 'openai', name: 'p', apiKey: 'k' }).id
  for (const [role, config] of Object.entries(roles)) hub.saveRole(role as any, { chain: [{ providerId, model: `${role}-model` }], ...config })
  return { hub, calls }
}

describe('jsonCandidates', () => {
  it('finds the object behind reasoning blocks, fences and prose', () => {
    expect(jsonCandidates('<think>maybe {"decision":"block"}</think>\n{"decision":"allow","reason":"ok"}')).toEqual([{ decision: 'allow', reason: 'ok' }, { decision: 'allow', reason: 'ok' }])
    expect(jsonCandidates('结论如下：\n```json\n{"decision": "ask_owner", "reason": "含 } 的说明"}\n```\n以上。')).toContainEqual({ decision: 'ask_owner', reason: '含 } 的说明' })
    expect(jsonCandidates('我认为应该放行。')).toEqual([])
  })
})

describe('generateStructured', () => {
  it('spells out the format, sends a JSON response format, and reads a fenced reply', async () => {
    const { hub, calls } = hubWith(() => '好的，审核结论：\n```json\n{"decision":"allow","reason":"推送任务分支"}\n```')
    expect(await generateStructured(hub, 'reviewer', request)).toEqual({ decision: 'allow', reason: '推送任务分支' })
    const { options } = calls[0]!
    expect(systemText(options)).toContain('## Output format')
    expect(systemText(options)).toContain('- decision: "allow" | "block" | "ask_owner"')
    expect(systemText(options)).toContain('{"decision":"ask_owner","reason":"需要确认"}')
    expect(options.responseFormat).toMatchObject({ type: 'json' })
  })

  it('uses the review layer\'s own model, and the main model only when the review layer has none', async () => {
    const reply = () => '{"decision":"block","reason":"x"}'
    const own = hubWith(reply, { router: {}, reviewer: {} })
    await generateStructured(own.hub, 'reviewer', request)
    expect(own.calls.map(c => c.model)).toEqual(['reviewer-model'])
    store.close()
    const inherited = hubWith(reply, { router: {} })
    await generateStructured(inherited.hub, 'reviewer', request)
    expect(inherited.calls.map(c => c.model)).toEqual(['router-model'])
  })

  it('lowers inherited heavy reasoning and caps output, but keeps what the layer sets itself', async () => {
    const reply = () => '{"decision":"allow","reason":"x"}'
    const inherited = hubWith(reply, { router: { reasoning: 'high' } })
    await generateStructured(inherited.hub, 'reviewer', { ...request, maxOutputTokens: 2_048 })
    expect(inherited.calls[0]!.options).toMatchObject({ reasoning: 'low', maxOutputTokens: 2_048 })
    store.close()
    const own = hubWith(reply, { router: { reasoning: 'high' }, reviewer: { reasoning: 'medium', maxOutputTokens: 9_000 } })
    await generateStructured(own.hub, 'reviewer', request)
    expect(own.calls[0]!.options).toMatchObject({ reasoning: 'medium', maxOutputTokens: 9_000 })
  })

  it('asks again without response_format when the endpoint rejects it', async () => {
    const { hub, calls } = hubWith((_m, options) => {
      if (options.responseFormat) throw new APICallError({ message: 'response_format is not supported', url: 'x', requestBodyValues: {}, statusCode: 400, isRetryable: false })
      return 'Answer: {"decision":"block","reason":"不符合请求"}'
    })
    expect(await generateStructured(hub, 'reviewer', request)).toEqual({ decision: 'block', reason: '不符合请求' })
    expect(calls).toHaveLength(2)
  })

  it('tells an unreadable or cut-off reply apart from a missing model', async () => {
    const prose = hubWith(() => '这个操作看起来没问题，可以放行。')
    await expect(generateStructured(prose.hub, 'reviewer', request)).rejects.toMatchObject({ kind: 'parse', message: expect.stringContaining('审核模型有回复，但不是约定格式的 JSON（回复开头：“这个操作看起来没问题') })
    store.close()
    const cut = hubWith(() => ({ text: '{"decision":"allow","rea', finish: 'length' }))
    await expect(generateStructured(cut.hub, 'reviewer', request)).rejects.toMatchObject({ kind: 'truncated' })
    store.close()
    const none = hubWith(() => 'unused', {})
    const error = await generateStructured(none.hub, 'reviewer', request).catch(e => e)
    expect(error).toBeInstanceOf(StructuredCallError)
    expect(error).toMatchObject({ kind: 'no_model', message: '没有配置审核模型，它默认继承的「主 Agent」层也没有' })
  })

  it('reports a failed call as a failed call', async () => {
    const { hub } = hubWith(() => { throw new APICallError({ message: 'Unauthorized', url: 'x', requestBodyValues: {}, statusCode: 401, isRetryable: false }) })
    await expect(generateStructured(hub, 'reviewer', request)).rejects.toMatchObject({ kind: 'call', message: expect.stringContaining('调用审核模型失败：401 Unauthorized') })
  })
})
