import { openStore, type Store } from '@super-agent/db'
import { MemorySecrets, ModelHub } from '@super-agent/models'
import { MockLanguageModelV4 } from 'ai/test'
import { tool } from 'ai'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { Bus } from './bus'
import { workerEnv } from './env'
import { AgentRuntime, type AgentDefinition } from './runtime'
import { generateOf, lastUserText, streamOf, type Scripted } from './testing'
import { fsTools, resolveInside } from './tools/fs'
import { shellTools } from './tools/shell'

let store: Store
let runtime: AgentRuntime
afterEach(async () => { await runtime?.shutdown(); store?.close() })

function setup(script: (opts: any, call: number) => Scripted | Promise<Scripted>, options = {}) {
  store = openStore(':memory:')
  let call = 0
  const model = new MockLanguageModelV4({ doStream: async opts => streamOf(await script(opts, call++)), doGenerate: async opts => generateOf(await script(opts, call++)) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  const p = hub.createProvider({ kind: 'openai', name: 'mock', apiKey: 'k' })
  hub.saveRole('router', { chain: [{ providerId: p.id, model: 'm' }] })
  runtime = new AgentRuntime(store, hub, new Bus(), options)
  return { model, hub }
}

const def = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  role: 'test', pool: 'worker', system: () => 'sys', tools: () => ({}),
  formatInbox: items => items.map(i => i.payload.text).join('\n'), ...extra,
})

describe('AgentRuntime', () => {
  it('injects inbox items that arrive mid-turn before the next step', async () => {
    const seen: string[] = []
    setup((opts, call) => {
      seen.push(lastUserText(opts))
      return call === 0 ? { calls: [{ name: 'poke', input: {} }] } : { text: 'done' }
    })
    let sessionId = ''
    runtime.register(def({ tools: () => ({ poke: tool({ inputSchema: z.object({}), execute: async () => { runtime.push(sessionId, { text: 'second message' }); return 'ok' } }) }) }))
    sessionId = runtime.createSession('test', 'router')
    let ended: any
    runtime.register(def({
      tools: () => ({ poke: tool({ inputSchema: z.object({}), execute: async () => { store.atomic(() => runtime.push(sessionId, { text: 'second message' })); return 'ok' } }) }),
      onTurnEnd: (_s, info) => { ended = info },
    }))
    store.atomic(() => runtime.push(sessionId, { text: 'first message' }))
    await new Promise(r => setTimeout(r, 20)); await runtime.idle()
    expect(seen).toEqual(['first message', 'second message'])
    expect(ended).toMatchObject({ steps: 2, lastText: 'done' })
    const roles = runtime.history(sessionId).map(m => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
  })

  it('moves slow commands to the background and wakes the session when they finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-ws-'))
    const prompts: string[] = []
    setup((opts, call) => {
      prompts.push(lastUserText(opts))
      if (call === 0) return { calls: [{ name: 'shell', input: { command: 'sleep 0.4; echo finished-ok' } }] }
      return { text: `step ${call}` }
    })
    runtime.register(def({ tools: ctx => shellTools(runtime.jobs, runtime.blobs, { sessionId: ctx.session.id, cwd: dir, env: workerEnv(), foregroundMs: 100, timeoutMs: 10_000, blocked: ['sudo'], signal: ctx.signal }) }))
    const id = runtime.createSession('test', 'router')
    store.atomic(() => runtime.push(id, { text: 'go' }))
    await new Promise(r => setTimeout(r, 20)); await runtime.idle()
    const toolResult = runtime.history(id).find(m => m.role === 'tool') as any
    expect(JSON.stringify(toolResult.content)).toContain('已转入后台')
    await new Promise(r => setTimeout(r, 700)); await runtime.idle()
    expect(prompts.length).toBe(3)
  }, 10_000)

  it('blocks a forbidden program however it is spelled, and starts a command in the background on request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-ws-'))
    setup(() => ({ text: 'x' }))
    const tools = shellTools(runtime.jobs, runtime.blobs, { sessionId: 's', cwd: dir, env: workerEnv(), foregroundMs: 5_000, timeoutMs: 10_000, blocked: ['sudo'], signal: new AbortController().signal })
    for (const cmd of ['/usr/bin/sudo ls', 'FOO=1 sudo ls', 'env sudo ls', 'echo hi && nohup sudo ls'])
      await expect((tools.shell as any).execute({ command: cmd }, {}), cmd).rejects.toThrow(/sudo/)
    const started = Date.now()
    const out = await (tools.shell as any).execute({ command: 'sleep 1; echo done', background: true }, {})
    expect(Date.now() - started).toBeLessThan(800)
    expect(out).toContain('已转入后台')
    runtime.jobs.stopAll('s')
  })

  it('retries a step whose response broke off mid-stream, without recording the broken attempt', async () => {
    let broke = false
    setup(() => {
      if (!broke) { broke = true; throw Object.assign(new Error('Failed to process successful response'), { statusCode: 200 }) }
      return { text: 'ok after retry' }
    })
    const ends: string[] = []
    runtime.register(def({ onTurnEnd: (_s, info) => ends.push(info.lastText) }))
    const id = runtime.createSession('test', 'router')
    store.atomic(() => runtime.push(id, { text: 'go' }))
    await new Promise(r => setTimeout(r, 2_000)); await runtime.idle()
    expect(ends).toEqual(['ok after retry'])
    expect(runtime.events(id).filter(e => e.kind === 'marker').map(e => e.payload.type)).toEqual(['retry'])
    expect(runtime.history(id).filter(m => m.role === 'assistant')).toHaveLength(1)
  }, 10_000)

  it('keeps one extra worker slot for a person and queues other work', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setup(async () => { await gate; return { text: 'ok' } }, { maxWorkers: 1 })
    runtime.register(def())
    const [a, b, c] = [runtime.createSession('test', 'router'), runtime.createSession('test', 'router'), runtime.createSession('test', 'router')]
    store.atomic(() => runtime.push(a, { text: 'a' }))
    await new Promise(r => setTimeout(r, 10))
    store.atomic(() => runtime.push(b, { text: 'b' }))
    store.atomic(() => runtime.push(c, { text: 'c' }, { human: true }))
    await new Promise(r => setTimeout(r, 10))
    expect([runtime.isRunning(a), runtime.isRunning(b), runtime.isRunning(c)]).toEqual([true, false, true])
    expect(runtime.session(b)!.state).toBe('queued')
    release()
    await new Promise(r => setTimeout(r, 30)); await runtime.idle()
    expect(runtime.history(b).at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('compacts long histories at a user-message boundary', async () => {
    setup((opts) => {
      if (lastUserText(opts).includes('压缩成一份')) return { text: '摘要：做过 A 和 B' }
      return { text: 'reply', inputTokens: 500 }
    }, { compactAtTokens: 100, keepRecent: 2 })
    runtime.register(def())
    const id = runtime.createSession('test', 'router')
    for (const t of ['one', 'two', 'three']) { store.atomic(() => runtime.push(id, { text: t })); await new Promise(r => setTimeout(r, 20)); await runtime.idle() }
    const history = runtime.history(id)
    expect(history[0]).toMatchObject({ role: 'user' })
    expect(String(history[0]!.content)).toContain('摘要：做过 A 和 B')
    expect(history.slice(1).map(m => m.role)[0]).toBe('user')
  })
})

describe('workspace safety', () => {
  it('confines file tools to the workspace, including through symlinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-ws-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    symlinkSync('/etc', join(dir, 'link'))
    expect(resolveInside(dir, 'a.txt')).toMatch(/a\.txt$/)
    expect(() => resolveInside(dir, '../outside')).toThrow(/不在工作目录内/)
    expect(() => resolveInside(dir, '/etc/passwd')).toThrow(/不在工作目录内/)
    expect(() => resolveInside(dir, 'link/passwd')).toThrow(/不在工作目录内/)
    expect(Object.keys(fsTools(dir, null as any))).toEqual(['read_file', 'write_file', 'edit_file', 'list_dir'])
  })
  it('strips credentials from the worker environment', () => {
    const env = workerEnv({ X: '1' }, { PATH: '/bin', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', HOME: '/h' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', X: '1', SUPERAGENT_WORKER: '1' })
  })
})
