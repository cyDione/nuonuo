import { AgentRuntime, Bus } from '@super-agent/agent-runtime'
import { generateOf, lastUserText, streamOf, systemText, type Scripted } from '@super-agent/agent-runtime/src/testing'
import { kvSet, newId, openStore, schema, type Store } from '@super-agent/db'
import { MemorySecrets, ModelHub } from '@super-agent/models'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAgents } from './agents'
import { Engine, ROUTER_SESSION } from './engine'

let store: Store
let runtime: AgentRuntime
afterEach(async () => { await runtime?.shutdown(); store?.close() })

const lastRole = (opts: any) => opts.prompt.at(-1)?.role as string
const ids = (text: string, attr: string) => [...text.matchAll(new RegExp(`${attr}="([a-z]+_[a-z0-9]+)"`, 'g'))].map(m => m[1]!)

/** A scripted model playing both roles, reacting to what it is sent. */
function script(opts: any): Scripted {
  const system = systemText(opts)
  const last = lastUserText(opts)
  if (system.includes('main agent ("router")')) {
    if (lastRole(opts) === 'tool') return { text: 'done' }
    const calls: Scripted['calls'] = []
    for (const block of last.split('\n\n')) {
      const [cnv] = ids(block, 'conversation_id')
      if (block.startsWith('<message') || block.startsWith('<handback')) {
        const [trg] = ids(block, 'trigger_id')
        const text = block.split('\ntext:\n')[1]?.split('\n</')[0] ?? ''
        if (text.startsWith('你好')) calls.push({ name: 'reply', input: { conversation_id: cnv, text: '你好！' } })
        else calls.push({ name: 'start_task', input: { conversation_id: cnv, trigger_ids: [trg], title: text.slice(0, 10), ack: `好的，开始：${text.slice(0, 10)}` } })
      }
      if (block.startsWith('<report')) calls.push({ name: 'reply', input: { conversation_id: cnv, text: `结果：${block.split('\n')[1]}` } })
    }
    return calls.length ? { calls } : { text: 'nothing to do' }
  }
  // worker
  if (lastRole(opts) === 'tool') {
    const lastTool = JSON.stringify(opts.prompt.at(-1).content)
    if (lastTool.includes('"report"') || lastTool.includes('handback')) return { text: 'turn over' }
    if (lastTool.includes('已转入后台')) return { calls: [{ name: 'report', input: { status: 'progress', summary: '命令在后台运行' } }] }
    if (last.includes('问我')) return { calls: [{ name: 'report', input: { status: 'waiting', summary: '需要确认', human_action: { question: '用 A 还是 B？', options: ['A', 'B'] } } }] }
    return { calls: [{ name: 'report', input: { status: 'ready', summary: `完成：${last.includes('<owner_message') ? '按新要求更新' : '已写入 out.txt'}` } }] }
  }
  if (last.includes('<owner_message') && last.includes('无关')) return { calls: [{ name: 'handback', input: { trigger_id: ids(last, 'trigger_id')[0], reason: '和本任务无关' } }] }
  if (last.includes('慢任务')) return { calls: [{ name: 'shell', input: { command: 'sleep 5' } }] }
  return { calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'hello' } }] }
}

async function setup() {
  store = openStore(':memory:')
  const home = mkdtempSync(join(tmpdir(), 'sa-core-'))
  const model = new MockLanguageModelV4({ doStream: async o => streamOf(script(o)), doGenerate: async o => generateOf(script(o)) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  const p = hub.createProvider({ kind: 'openai', name: 'mock', apiKey: 'k' })
  hub.saveRole('router', { chain: [{ providerId: p.id, model: 'm' }] })
  const bus = new Bus()
  runtime = new AgentRuntime(store, hub, bus, { maxWorkers: 3 })
  const engine = new Engine(store, runtime, bus, { home })
  kvSet(store, 'settings:execution', { foregroundSeconds: 0.2 })
  registerAgents(store, runtime, engine)
  const conversation = (title = '新对话') => {
    const id = newId('cnv'); const at = Date.now()
    store.db.insert(schema.conversations).values({ id, title, createdAt: at, updatedAt: at }).run()
    return id
  }
  return { engine, conversation, home }
}

const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 30)); await runtime.idle() } }
const messages = (cnv: string) => store.db.select().from(schema.messages).all().filter(m => m.conversationId === cnv)

describe('router + workers', () => {
  it('answers small talk directly and turns three requests into three parallel tasks that report back', async () => {
    const { engine, conversation } = await setup()
    const cnv = conversation()
    engine.receiveMessage(cnv, '你好')
    engine.receiveMessage(cnv, '整理周报')
    engine.receiveMessage(cnv, '查一下天气')
    engine.receiveMessage(cnv, '写个脚本')
    await settle()
    const tickets = engine.tickets()
    expect(tickets).toHaveLength(3)
    expect(tickets.every(t => t.ended?.outcome === 'completed')).toBe(true)
    expect(readFileSync(join(tickets[0]!.directory, 'out.txt'), 'utf8')).toBe('hello')
    const texts = messages(cnv).filter(m => m.role === 'assistant').map(m => m.content)
    expect(texts).toContain('你好！')
    expect(texts.filter(t => t.startsWith('好的，开始'))).toHaveLength(3)
    expect(texts.filter(t => t.startsWith('结果：'))).toHaveLength(3)
    expect(messages(cnv).filter(m => m.role === 'event')).toHaveLength(3)
  })

  it('sends a message in a single-task conversation straight to its worker; the router only gets a quiet follow-up', async () => {
    const { engine, conversation } = await setup()
    const cnv = conversation()
    engine.receiveMessage(cnv, '慢任务：跑一个长命令')
    await settle()
    const [ticket] = engine.tickets()
    expect(engine.stage(ticket!)).toBe('idle')
    const routed = engine.receiveMessage(cnv, '另外把输出也存一下')
    expect(routed.deliveredTo).toEqual([ticket!.id])
    // The follow-up waits quietly in the router's inbox; it does not wake the router.
    expect(runtime.isRunning(ROUTER_SESSION)).toBe(false)
    expect(runtime.pending(ROUTER_SESSION).map(i => i.payload.type)).toEqual(['followup'])
    await settle()
    const workerSaw = runtime.history(ticket!.sessionId).map(m => JSON.stringify(m.content)).join('')
    expect(workerSaw).toContain('另外把输出也存一下')
    // The worker's ready report woke the router, which took the follow-up along with it.
    expect(engine.ticket(ticket!.id).ended?.outcome).toBe('completed')
    expect(runtime.pending(ROUTER_SESSION)).toEqual([])
  })

  it('hands an unrelated message back to the router, which starts a new task for it', async () => {
    const { engine, conversation } = await setup()
    const cnv = conversation()
    engine.receiveMessage(cnv, '慢任务：编译项目')
    await settle()
    engine.receiveMessage(cnv, '无关的事：订个机票')
    await settle()
    const titles = engine.tickets().map(t => t.title)
    expect(titles).toContain('无关的事：订个机票'.slice(0, 10))
  })

  it('turns a worker question into attention that the owner answers in the conversation', async () => {
    const { engine, conversation } = await setup()
    const cnv = conversation()
    engine.receiveMessage(cnv, '先问我再做')
    await settle()
    let [ticket] = engine.tickets()
    expect(engine.stage(ticket!)).toBe('person/answer')
    expect(ticket!.attention).toMatchObject({ question: '用 A 还是 B？' })
    engine.receiveMessage(cnv, '用 A', { replyTo: ticket!.id })
    ;[ticket] = engine.tickets()
    expect(ticket!.attention).toBeNull()
    await settle()
    expect(engine.tickets()[0]!.ended?.outcome).toBe('completed')
  })

  it('stops a running task: the turn and its jobs are cancelled and later messages go to the router', async () => {
    const { engine, conversation } = await setup()
    const cnv = conversation()
    engine.receiveMessage(cnv, '慢任务：跑测试')
    await new Promise(r => setTimeout(r, 150))
    const [ticket] = engine.tickets()
    engine.stopTask(ticket!.id, 'person', '不需要了')
    await settle()
    const stopped = engine.ticket(ticket!.id)
    expect(stopped.ended).toMatchObject({ by: 'person', outcome: 'stopped' })
    expect(runtime.jobs.running(ticket!.sessionId)).toEqual([])
    expect(engine.receiveMessage(cnv, '新的请求').deliveredTo).toEqual([])
    expect(() => engine.receiveMessage(cnv, 'x', { replyTo: ticket!.id })).toThrow(/已被你停止/)
  })
})

describe('full duplex', () => {
  it('moves a foreground command to the background when the owner writes, and kills jobs when the task ends', async () => {
    const { engine, conversation } = await setup()
    kvSet(store, 'settings:execution', { foregroundSeconds: 30 })
    const cnv = conversation()
    engine.receiveMessage(cnv, '慢任务：长时间编译')
    await new Promise(r => setTimeout(r, 200))
    const [ticket] = engine.tickets()
    expect(runtime.isRunning(ticket!.sessionId)).toBe(true)
    const started = Date.now()
    engine.receiveMessage(cnv, '顺便记一下日志')
    await settle()
    // Answered long before the 30 s foreground window or the 5 s command.
    expect(Date.now() - started).toBeLessThan(3_000)
    const done = engine.ticket(ticket!.id)
    expect(done.ended?.outcome).toBe('completed')
    // The background `sleep 5` was killed when the task ended, so it never wakes the worker again.
    await new Promise(r => setTimeout(r, 100))
    expect(runtime.jobs.running(ticket!.sessionId)).toEqual([])
  })
})
