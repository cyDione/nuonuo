import { AgentRuntime, Bus } from '@super-assistant/agent-runtime'
import { generateOf, lastUserText, streamOf, systemText, type Scripted } from '@super-assistant/agent-runtime/src/testing'
import { kvSet, newId, openStore, schema, type Store } from '@super-assistant/db'
import { MemorySecrets, ModelHub } from '@super-assistant/models'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chatLength, instructionsExtension, proactiveExtension, registerAgents, combineExtensions } from './agents'
import { Engine, ROUTER_SESSION } from './engine'
import { Instructions } from './instructions'
import type { IncomingTrigger } from './model'
import { fastPath, proactiveSettings, saveProactiveSettings, Screener, DEFAULT_PROACTIVE } from './proactive'

let store: Store
let runtime: AgentRuntime
afterEach(async () => { await runtime?.shutdown(); store?.close() })

const lastRole = (opts: any) => opts.prompt.at(-1)?.role as string
const attr = (text: string, name: string) => new RegExp(`${name}="([^"]+)"`).exec(text)?.[1]
const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 30)); await runtime.idle() } }

/** Behaviour of the scripted model for one test: the router, the worker, a subagent and the filter. */
type Script = { router?(last: string, opts: any): Scripted; worker?(last: string, opts: any): Scripted; subagent?(last: string): Scripted; filter?: Record<string, unknown> }
let behaviour: Script = {}
const routerCalls: any[] = []

function setup(opts: { sources?: boolean } = {}) {
  routerCalls.length = 0
  store = openStore(':memory:')
  const home = mkdtempSync(join(tmpdir(), 'sa-m5-'))
  const play = (o: any): Scripted => {
    const system = systemText(o)
    const last = lastUserText(o)
    if (system.includes('You screen events')) return { text: JSON.stringify(behaviour.filter ?? { act: false, reason: '无关' }) }
    if (system.includes("You are the owner's personal assistant")) {
      if (lastRole(o) === 'tool') return { text: 'done' }
      const step = behaviour.router?.(last, o) ?? { text: 'nothing' }
      for (const c of step.calls ?? []) routerCalls.push(c)
      return step
    }
    if (system.includes('You are a subagent')) {
      if (lastRole(o) === 'tool') return { text: 'ok' }
      return behaviour.subagent?.(last) ?? { calls: [{ name: 'finish', input: { result: '子任务结果：42' } }] }
    }
    if (lastRole(o) === 'tool' && JSON.stringify(o.prompt.at(-1).content).includes('"report"')) return { text: 'turn over' }
    return behaviour.worker?.(last, o) ?? { calls: [{ name: 'report', input: { status: 'ready', summary: 'ok' } }] }
  }
  const model = new MockLanguageModelV4({ doStream: async o => streamOf(play(o)), doGenerate: async o => generateOf(play(o)) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') } })
  const p = hub.createProvider({ kind: 'openai', name: 'mock', apiKey: 'k' })
  hub.saveRole('router', { chain: [{ providerId: p.id, model: 'm' }] })
  const bus = new Bus()
  runtime = new AgentRuntime(store, hub, bus, { maxWorkers: 3 })
  const screened: string[] = []
  const sent: { source: string; text: string }[] = []
  const engine = new Engine(store, runtime, bus, {
    home, screen: id => { screened.push(id) },
    ...(opts.sources ? { sources: { allowed: (s: string, a: string) => s === 'github' && a === 'me', hasChannel: (s: string) => s === 'github', send: (m: any) => { sent.push(m) } } } : {}),
  })
  kvSet(store, 'settings:execution', { foregroundSeconds: 0.2 })
  const instructions = new Instructions(store)
  registerAgents(store, runtime, engine, combineExtensions(instructionsExtension(instructions), proactiveExtension(store)))
  const screener = new Screener(store, hub, engine)
  const conversation = () => {
    const id = newId('cnv'); const at = Date.now()
    store.db.insert(schema.conversations).values({ id, title: '新对话', createdAt: at, updatedAt: at }).run()
    return id
  }
  return { engine, home, screened, screener, sent, conversation, instructions }
}

let n = 0
const gh = (actor: string, text: string, extra: Partial<IncomingTrigger> = {}): IncomingTrigger => ({
  id: `gh_${++n}`, source: 'github', threadId: 'github:me/repo#9', actor, human: !actor.endsWith('[bot]'), addressed: text.includes('@agent'),
  text, at: Date.now() + n, thread: { title: 'me/repo#9 登录页崩溃', url: 'https://github.com/me/repo/issues/9' }, ...extra,
})

describe('proactive intake', () => {
  it('fast path: off, internal, unwatched or ignored events are never screened', () => {
    const s = { ...DEFAULT_PROACTIVE, mode: 'auto' as const, sources: ['github'] }
    expect(fastPath({ ...s, mode: 'off' }, { source: 'github', actor: 'a', text: 'hello' })).toBe('proactive_off')
    expect(fastPath(s, { source: 'cron', actor: 'owner', text: 'x y' })).toBe('internal')
    expect(fastPath(s, { source: 'telegram', actor: 'a', text: 'hello' })).toBe('source_not_watched')
    expect(fastPath(s, { source: 'github', actor: 'dependabot[bot]', text: 'bump' })).toBe('actor_ignored')
    expect(fastPath(s, { source: 'github', actor: 'alice', text: '登录页崩溃了' })).toBeUndefined()
  })

  it('observe mode records what it would do; auto mode works silently and the router tells the owner only via the web', async () => {
    const { engine, screened, screener, sent } = setup({ sources: true })
    // Off: unaddressed events are only stored.
    engine.receive(gh('alice', '登录页点提交就崩溃，必现'))
    expect(screened).toHaveLength(0)

    saveProactiveSettings(store, { mode: 'observe' })
    const observed = gh('alice', '登录页点提交就崩溃，必现')
    engine.receive(observed)
    expect(screened).toEqual([observed.id])
    behaviour = { filter: { act: true, reason: '能复现的 bug，策略说先复现', title: '复现登录崩溃', goal: '复现并定位' } }
    await screener.screen(observed.id)
    expect(engine.tickets()).toHaveLength(0)
    const d = store.db.select().from(schema.triggers).all().find(t => t.id === observed.id)!.disposition as any
    expect(d.proactive).toMatchObject({ act: true, mode: 'observe', title: '复现登录崩溃' })

    saveProactiveSettings(store, { mode: 'auto' })
    behaviour = {
      filter: { act: true, reason: '能复现的 bug', title: '复现登录崩溃', goal: '复现并定位' },
      worker: (last, o) => {
        expect(systemText(o)).toContain('Silent work')
        expect(last).toContain('mode="silent"')
        return { calls: [{ name: 'report', input: { status: 'ready', summary: '复现了：表单为空时 submit 抛错。修复补丁在 fix.patch。' } }] }
      },
      router: last => last.startsWith('<proactive') ? { calls: [{ name: 'start_silent_task', input: { trigger_id: attr(last, 'trigger_id'), title: attr(last, 'suggested_title') ?? '看看' } }] }
        : last.includes('proactive="true"')
        ? { calls: [{ name: 'reply', input: { ticket_id: attr(last, 'ticket_id'), text: '我注意到登录页崩溃，已经在本地复现，修复方案也准备好了，要我提 PR 吗？' } }] }
        : { text: 'nothing' },
    }
    const auto = gh('alice', '还是崩溃')
    engine.receive(auto)
    // Nothing visible until the router decides.
    expect(store.db.select().from(schema.conversations).all()).toHaveLength(0)
    await screener.screen(auto.id)
    await settle()
    const [ticket] = engine.tickets()
    expect(ticket!.mandate).toMatchObject({ by: 'policy', strength: 'proactive' })
    expect(ticket!.ended?.outcome).toBe('completed')
    // What it noticed on its own is told in the main conversation (Muse), not in a mirror of the GitHub thread.
    const msgs = store.db.select().from(schema.messages).all().filter(m => m.role === 'assistant')
    expect(msgs[0]!.conversationId).toBe(engine.mainConversation())
    expect(msgs).toHaveLength(1)
    expect((msgs[0]!.meta as any).result.summary).toContain('复现了')
    // Silent work never goes out to GitHub on its own.
    expect(sent).toHaveLength(0)
  })

  it('a dropped silent task bothers nobody', async () => {
    const { engine, screener } = setup({ sources: true })
    saveProactiveSettings(store, { mode: 'auto' })
    behaviour = {
      filter: { act: true, reason: '可能是 bug', title: '看看' },
      worker: () => ({ calls: [{ name: 'report', input: { status: 'dropped', summary: '复现不了' } }] }),
      router: last => last.startsWith('<proactive') ? { calls: [{ name: 'start_silent_task', input: { trigger_id: attr(last, 'trigger_id'), title: attr(last, 'suggested_title') ?? '看看' } }] }
        : ({ text: 'nothing' }),
    }
    const t = gh('bob', '偶尔会白屏？')
    engine.receive(t)
    await screener.screen(t.id)
    await settle()
    expect(engine.tickets()[0]!.ended?.outcome).toBe('dropped')
    expect(store.db.select().from(schema.messages).all()).toHaveLength(0)
    expect(routerCalls.filter(c => c.name === 'reply')).toHaveLength(0)
    expect(routerCalls.filter(c => c.name === 'start_silent_task')).toHaveLength(1)
  })
})

describe('proactive routing', () => {
  it('the router can still decline an event the filter picked; it cannot start silent work on anything else', async () => {
    const { engine, screener } = setup({ sources: true })
    saveProactiveSettings(store, { mode: 'auto' })
    const picked = gh('carol', '这个 API 好像慢了')
    const other = gh('dave', '随便聊聊')
    behaviour = {
      filter: { act: true, reason: '可能是性能问题' },
      router: last => last.startsWith('<proactive')
        ? { calls: [{ name: 'start_silent_task', input: { trigger_id: other.id, title: 'x' } }, { name: 'ignore', input: { trigger_ids: [attr(last, 'trigger_id')], reason: '已经有人在看' } }] }
        : { text: 'nothing' },
    }
    engine.receive(picked)
    engine.receive(other)
    await screener.screen(picked.id)
    await settle()
    expect(engine.tickets()).toHaveLength(0)
    const d = store.db.select().from(schema.triggers).all().find(t => t.id === picked.id)!.disposition as any
    expect(d).toMatchObject({ ignored: 'router', reason: '已经有人在看', proactive: { act: true } })
  })
})

describe('proactive policy (what the article\'s critics asked for)', () => {
  it('records the policy version, keeps to the budget, and stops silent work when turned off', async () => {
    const { engine } = setup({ sources: true })
    const v = saveProactiveSettings(store, { mode: 'auto', budget: { concurrent: 1, daily: 5 } })
    behaviour = { worker: () => ({ text: 'thinking' }), router: () => ({ text: 'x' }) }
    const a = gh('alice', '崩溃了'); const b = gh('bob', '也崩溃了')
    engine.receive(a); engine.receive(b)
    for (const t of [a, b]) engine.proactiveDecision(t.id, { act: true, reason: '可能是 bug' }, 'observe')
    const first = engine.startProactive(a.id, { title: '看看', reason: 'r' })
    expect(first.mandate).toMatchObject({ policy: v.version, by: 'policy' })
    expect(() => engine.startProactive(b.id, { title: '看看', reason: 'r' })).toThrow(/预算/)
    // The owner's own "去做" is not limited by the budget.
    expect(engine.startProactive(b.id, { title: '看看', reason: 'r', byOwner: true }).mandate).toMatchObject({ by: 'owner' })
    expect(engine.revokeProactive('主动处理已关闭')).toEqual([first.id])
    expect(engine.ticket(first.id).ended).toMatchObject({ outcome: 'stopped', by: 'system' })
  })

  it('turns "not useful" feedback into a line of the strategy, as a new version', () => {
    const { engine } = setup({ sources: true })
    saveProactiveSettings(store, { mode: 'observe' })
    const t = gh('bot-ish', '依赖更新提醒')
    engine.receive(t)
    engine.proactiveDecision(t.id, { act: true, reason: '可能需要升级', title: '依赖更新' }, 'observe')
    const before = proactiveSettings(store).version
    engine.proactiveFeedback(t.id, false)
    const after = proactiveSettings(store)
    expect(after.version).toBe(before + 1)
    expect(after.strategy).toContain('不用管这类事：「依赖更新」')
    expect(engine.attentionStats()).toMatchObject({ picked: 1, useless: 1 })
  })

  it('tells a worker about other open work on its thread', async () => {
    const { engine } = setup({ sources: true })
    let assignment = ''
    behaviour = { worker: (last, o) => { if (last.includes('<assignment')) assignment += last; return lastRole(o) === 'tool' ? { text: 'x' } : { calls: [{ name: 'report', input: { status: 'progress', summary: 'wip' } }] } } }
    const a = gh('me', '@agent 修按钮'); const b = gh('me', '@agent 顺便改文案')
    engine.receive(a); engine.receive(b)
    const first = engine.startTask({ triggerIds: [a.id], title: '修按钮' })
    engine.startTask({ triggerIds: [b.id], title: '改文案' })
    await settle()
    expect(assignment).toContain(`other open work on this thread`)
    expect(assignment).toContain(first.id)
  })
})

describe('conversation voice', () => {
  it('counts words for CJK and Latin text', () => {
    expect(chatLength('hello world')).toBe(2)
    expect(chatLength('你好世界')).toBe(3)
    expect(chatLength('查到了：SQLite WAL 模式读写可以并发')).toBeGreaterThan(5)
  })

  it('rejects a chat reply over the length limit, so the router has to say it shorter', async () => {
    const { engine, conversation } = setup()
    const cnv = conversation()
    const long = '很长的回复'.repeat(80)
    let attempts = 0
    behaviour = { router: () => { attempts++; return { calls: [{ name: 'reply', input: { conversation_id: cnv, text: long } }] } } }
    engine.receiveMessage(cnv, '介绍一下')
    await settle()
    expect(attempts).toBeGreaterThan(0)
    expect(store.db.select().from(schema.messages).all().filter(m => m.role === 'assistant')).toHaveLength(0)
    const events = runtime.events(ROUTER_SESSION).map(e => JSON.stringify(e.payload))
    expect(events.some(e => e.includes('Not sent'))).toBe(true)
  })

  it('attaches delivered files and the full result to the message about the work', async () => {
    const { engine, conversation } = setup()
    const cnv = conversation()
    behaviour = {
      router: last => last.startsWith('<message')
        ? { calls: [{ name: 'start_task', input: { conversation_id: cnv, trigger_ids: [attr(last, 'trigger_id')], title: '写报告', ack: '好，我来写。' } }] }
        : last.startsWith('<report') ? { calls: [{ name: 'reply', input: { ticket_id: attr(last, 'ticket_id'), text: '写好了，见附件。' } }] } : { text: 'x' },
      worker: (last, o) => lastRole(o) === 'tool'
        ? { calls: [{ name: 'report', input: { status: 'ready', summary: '报告写好了，共三节。', files: ['report.md', '../escape.txt', 'missing.md'] } }] }
        : { calls: [{ name: 'write_file', input: { path: 'report.md', content: '# 报告\n' } }] },
    }
    engine.receiveMessage(cnv, '写一份报告')
    await settle()
    const [ticket] = engine.tickets()
    expect(engine.artifacts({ ticketId: ticket!.id }).map(a => a.path)).toEqual(['report.md'])
    const msgs = store.db.select().from(schema.messages).all().filter(m => m.role === 'assistant').map(m => ({ text: m.content, result: (m.meta as any).result }))
    expect(msgs.map(m => m.text)).toEqual(['好，我来写。', '写好了，见附件。'])
    expect(msgs[1]!.result.files.map((f: any) => f.name)).toEqual(['report.md'])
    expect(store.db.select().from(schema.messages).all().some(m => m.role === 'event')).toBe(false)
  })
})

describe('unsent text', () => {
  it('reminds the router once when it answered in plain text, so the answer is sent', async () => {
    const { engine, conversation } = setup()
    const cnv = conversation()
    behaviour = { router: last => last.includes('<unsent') ? { calls: [{ name: 'reply', input: { conversation_id: cnv, text: '你好！我在。' } }] } : { text: '你好！我在。' } }
    engine.receiveMessage(cnv, '在吗')
    await settle()
    const sent = store.db.select().from(schema.messages).all().filter(m => m.role === 'assistant').map(m => m.content)
    expect(sent).toEqual(['你好！我在。'])
  })
})

describe('subagents', () => {
  it('a worker starts a subagent, ends its turn, and is woken with the result', async () => {
    const { engine, conversation } = setup()
    const cnv = conversation()
    let sawResult = ''
    behaviour = {
      router: last => last.startsWith('<message') ? { calls: [{ name: 'start_task', input: { conversation_id: cnv, trigger_ids: [attr(last, 'trigger_id')], title: '并行调研' } }] } : { text: 'x' },
      worker: (last, o) => {
        if (last.includes('<subagent_result')) { sawResult = last; return { calls: [{ name: 'report', input: { status: 'ready', summary: '合并了子任务结果' } }] } }
        if (lastRole(o) === 'tool') return { calls: [{ name: 'report', input: { status: 'progress', summary: '等子任务' } }] }
        return { calls: [{ name: 'subagent_start', input: { job: '算一下 6×7' } }] }
      },
    }
    engine.receiveMessage(cnv, '并行调研一下')
    await settle()
    await settle()
    expect(sawResult).toContain('子任务结果：42')
    const [ticket] = engine.tickets()
    expect(ticket!.ended?.outcome).toBe('completed')
    expect(runtime.children(ticket!.sessionId)).toHaveLength(1)
  })
})

describe('instructions and recall', () => {
  it('keeps versions, restores them, and puts them in every prompt', async () => {
    const { instructions, engine, conversation } = setup()
    expect(instructions.prompt()).toBe('')
    instructions.update({ communication: '- 结论先说' }, 'owner')
    instructions.update({ scope: '- 不要合并 PR' }, 'owner')
    expect(instructions.current().version).toBe(2)
    expect(instructions.prompt()).toContain('不要合并 PR')
    instructions.restore(1, 'owner')
    expect(instructions.current()).toMatchObject({ version: 3, sections: { scope: '', communication: '- 结论先说' } })
    let system = ''
    const cnv = conversation()
    behaviour = { router: (_l, o) => { system = systemText(o); return { calls: [{ name: 'update_instructions', input: { section: 'delivery', mode: 'append', text: '附上测试结果' } }, { name: 'reply', input: { conversation_id: cnv, text: '好，记住了。' } }] } } }
    engine.receiveMessage(cnv, '以后交付都附上测试结果')
    await settle()
    expect(system).toContain('结论先说')
    expect(instructions.current()).toMatchObject({ version: 4, by: 'router', sections: { delivery: '- 附上测试结果' } })
  })

  it('follows the chain: thread → work → session', async () => {
    const { engine } = setup({ sources: true })
    const t = gh('me', '@agent 修一下')
    engine.receive(t)
    const ticket = engine.startTask({ triggerIds: [t.id], title: '修复' })
    await settle()
    const thread = runtime.recall('github:me/repo#9')
    expect(thread).toContain(ticket.id)
    expect(thread).toContain(`session=${ticket.sessionId}`)
    expect(thread).toContain(t.id)
    expect(runtime.recall(ticket.sessionId)).toContain('<session')
  })
})
