import { AgentRuntime, Bus, workerEnv } from '@super-assistant/agent-runtime'
import { generateOf, lastUserText, streamOf, systemText, type Scripted } from '@super-assistant/agent-runtime/src/testing'
import { kvSet, newId, openStore, schema, type Store } from '@super-assistant/db'
import { MemorySecrets, ModelHub } from '@super-assistant/models'
import { MockLanguageModelV4 } from 'ai/test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAgents } from './agents'
import { Engine } from './engine'
import { classifyShell, Reviewer } from './review'

describe('classifyShell', () => {
  it.each([
    ['ls -la && cat README.md', 'normal'],
    ['git commit -am wip && git push origin super-assistant/x', 'external'],
    ['gh pr create --fill', 'external'],
    ['curl -X POST https://example.com -d @data.json', 'external'],
    ['curl https://example.com', 'normal'],
    ['git push --force origin main', 'destructive'],
    ['gh pr merge 12 --squash', 'destructive'],
    ['rm -rf ~/Documents', 'destructive'],
    ['rm -rf ./build', 'normal'],
  ])('%s → %s', (command, risk) => {
    expect(classifyShell(command).risk).toBe(risk)
  })
})

let store: Store
let runtime: AgentRuntime
let jevRequests: any[] = []
afterEach(async () => { await runtime?.shutdown(); store?.close(); jevRequests = [] })

/** Worker wants `git push`; the reviewer's verdict is scripted per test. */
function setup(verdict: () => Scripted, jev?: (request: any) => any) {
  store = openStore(':memory:')
  const script = (opts: any): Scripted => {
    const system = systemText(opts)
    if (system.includes('You review one action')) return verdict()
    if (system.includes("You are the owner's personal assistant")) return { text: 'ok' }
    const last = opts.prompt.at(-1)
    if (last.role === 'tool') return JSON.stringify(last.content).includes('"report"') ? { text: 'end' } : { calls: [{ name: 'report', input: { status: 'progress', summary: JSON.stringify(last.content).slice(0, 300) } }] }
    if (lastUserText(opts).includes('<job_finished')) return { calls: [{ name: 'report', input: { status: 'ready', summary: 'pushed' } }] }
    if (lastUserText(opts).includes('<approval')) return { calls: [{ name: 'report', input: { status: 'progress', summary: 'approval noted' } }] }
    return { calls: [{ name: 'shell', input: { command: 'touch pushed.txt && git push origin feature' } }] }
  }
  const model = new MockLanguageModelV4({ doStream: async o => streamOf(script(o)), doGenerate: async o => generateOf(script(o)) })
  const hub = new ModelHub(store, new MemorySecrets(), { language: () => model, embedding: () => { throw new Error('x') },
    systemOne: () => async request => { jevRequests.push(request); return { model: 'jev-1', answers: { decision: jev!(request) }, usage: { input_tokens: 120, output_tokens: 0 } } } })
  hub.saveRole('router', { chain: [{ providerId: hub.createProvider({ kind: 'openai', name: 'm', apiKey: 'k' }).id, model: 'm' }] })
  if (jev) hub.saveRole('reviewer', { chain: [{ providerId: hub.createProvider({ kind: 'typesafe', name: 'TypeSafe', apiKey: 'k' }).id, model: 'jev-latest' }] })
  const bus = new Bus()
  runtime = new AgentRuntime(store, hub, bus)
  const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'sa-rv-')) })
  const reviewer = new Reviewer(store, hub, engine, runtime, bus)
  reviewer.envFor = () => workerEnv()
  registerAgents(store, runtime, engine, { gateShell: (t, s, c, cwd) => reviewer.gateShell(t, s, c, cwd) })
  const id = newId('cnv')
  store.db.insert(schema.conversations).values({ id, title: 't', createdAt: Date.now(), updatedAt: Date.now() }).run()
  const { triggerId } = engine.receiveMessage(id, '推送我的分支')
  return { engine, reviewer, triggerId, start: () => engine.startTask({ triggerIds: [triggerId], title: '推送' }) }
}
const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 40)); await runtime.idle() } }
const audit = () => store.db.select().from(schema.auditLog).all().map(a => [a.actor, a.decision])

describe('Reviewer', () => {
  it('lets the reviewer model allow an external command, and audits it', async () => {
    const { engine, start } = setup(() => ({ text: JSON.stringify({ decision: 'allow', reason: '推送任务分支，符合请求' }) }))
    const ticket = start()
    await settle()
    expect(existsSync(join(ticket.directory, 'pushed.txt'))).toBe(true)
    expect(audit()).toEqual([['reviewer', 'allow']])
    expect(engine.stage(engine.ticket(ticket.id))).not.toBe('person/approve')
  })

  it('reads a verdict wrapped in prose and a code fence', async () => {
    const { start } = setup(() => ({ text: '审核结论：\n```json\n{"decision":"allow","reason":"推送任务分支"}\n```' }))
    const ticket = start()
    await settle()
    expect(existsSync(join(ticket.directory, 'pushed.txt'))).toBe(true)
    expect(audit()).toEqual([['reviewer', 'allow']])
  })

  it('says the reply was unreadable, not that no review model is configured', async () => {
    const { reviewer, start } = setup(() => ({ text: '我觉得可以放行。' }))
    start()
    await settle()
    const [approval] = reviewer.pending()
    expect(approval!.reason).toContain('审核模型有回复，但不是约定格式的 JSON')
    expect(approval!.reason).not.toContain('不可用')
  })

  it('uses a decision model (Jev) on the review layer instead of the main model', async () => {
    const llm = () => { throw new Error('the main model must not review') }
    const { start } = setup(llm, () => ({ type: 'choice', choice: 'allow', confidence: 0.93, probabilities: { allow: 0.93, block: 0.02, ask_owner: 0.05 } }))
    const ticket = start()
    await settle()
    expect(existsSync(join(ticket.directory, 'pushed.txt'))).toBe(true)
    expect(jevRequests[0]).toMatchObject({ model: 'jev-latest', questions: { decision: { type: 'choice', criteria: { allow: expect.any(String), block: expect.any(String), ask_owner: expect.any(String) } } } })
    expect(jevRequests[0].state).toContain('git push origin feature')
    expect(store.db.select().from(schema.auditLog).all().map(a => a.reason)).toEqual(['判断符合主人的请求和规则（Jev，置信度 0.93）'])
    expect(store.db.select().from(schema.usageLedger).all().filter(r => r.role === 'reviewer')).toEqual([expect.objectContaining({ role: 'reviewer', model: 'jev-latest', inputTokens: 120, ok: true })])
  })

  it('asks the owner when Jev is not confident', async () => {
    const { reviewer, start } = setup(() => ({ text: 'unused' }), () => ({ type: 'choice', choice: 'allow', confidence: 0.55, probabilities: { allow: 0.55, block: 0.1, ask_owner: 0.35 } }))
    start()
    await settle()
    expect(reviewer.pending()[0]!.reason).toContain('Jev 倾向放行，但置信度只有 0.55，转给你决定')
  })

  it('blocks on the reviewer\'s word and tells the worker why', async () => {
    const { start } = setup(() => ({ text: JSON.stringify({ decision: 'block', reason: '主人没有要求推送' }) }))
    const ticket = start()
    await settle()
    expect(existsSync(join(ticket.directory, 'pushed.txt'))).toBe(false)
    expect(JSON.stringify(runtime.history(ticket.sessionId))).toContain('审核拦截了这条命令：主人没有要求推送')
  })

  it('escalates to the owner without blocking the worker, then runs the command on approval', async () => {
    const { engine, reviewer, start } = setup(() => ({ text: JSON.stringify({ decision: 'ask_owner', reason: '推送到远程，需要确认' }) }))
    const ticket = start()
    await settle()
    expect(existsSync(join(ticket.directory, 'pushed.txt'))).toBe(false)
    expect(engine.stage(engine.ticket(ticket.id))).toBe('person/approve')
    const [approval] = reviewer.pending()
    expect(approval).toMatchObject({ ticketId: ticket.id, risk: 'external', reason: '推送到远程，需要确认' })
    reviewer.decide(approval!.id, true)
    await new Promise(r => setTimeout(r, 300))
    await settle()
    expect(existsSync(join(ticket.directory, 'pushed.txt'))).toBe(true)
    expect(engine.ticket(ticket.id).ended?.outcome).toBe('completed')
    expect(audit()).toEqual([['reviewer', 'escalate'], ['owner', 'allow']])
  })

  it('blocks any command that reads credentials, whatever the settings', async () => {
    const { engine, reviewer, start } = setup(() => ({ text: JSON.stringify({ decision: 'allow', reason: 'ok' }) }))
    kvSet(store, 'settings:review', { threshold: 'off', allow: ['.*'] })
    const ticket = start()
    await settle()
    const t = engine.ticket(ticket.id)
    for (const cmd of ['cat ~/.git-credentials | sed s/=.*//', 'ls -la ~/.ssh', 'gh auth token', 'cat /home/me/.config/gh/hosts.yml', 'git credential fill', 'cat ~/.aws/credentials'])
      expect(await reviewer.gateShell(t, ticket.sessionId, cmd, t.directory), cmd).toMatchObject({ action: 'block', by: 'rule' })
    expect(await reviewer.gateShell(t, ticket.sessionId, 'ls -la && cat README.md', t.directory)).toMatchObject({ action: 'allow' })
    engine.stopTask(ticket.id, 'person')
  })

  it('never asks the owner during silent work: the step is blocked instead', async () => {
    const { engine, reviewer, triggerId } = setup(() => ({ text: JSON.stringify({ decision: 'ask_owner', reason: '要推送' }) }))
    const ticket = engine.startProactive(triggerId, { title: '悄悄看看', reason: '策略' })
    await settle()
    expect(reviewer.pending()).toHaveLength(0)
    expect(JSON.stringify(runtime.history(ticket.sessionId))).toContain('不能做需要主人批准的操作')
    engine.stopTask(ticket.id, 'person')
  })

  it('applies deny rules and the "ask" mode without calling the model', async () => {
    let calls = 0
    const { engine, reviewer, start } = setup(() => { calls++; return { text: '{}' } })
    kvSet(store, 'settings:review', { mode: 'ask', deny: ['--force'] })
    const ticket = start()
    await settle()
    expect(reviewer.pending()).toHaveLength(1)
    expect(calls).toBe(0)
    expect(await reviewer.gateShell(engine.ticket(ticket.id), ticket.sessionId, 'git push --force', ticket.directory)).toMatchObject({ action: 'block', by: 'rule' })
    reviewer.decide(reviewer.pending()[0]!.id, false, '先别推')
    await settle()
    expect(JSON.stringify(runtime.history(ticket.sessionId))).toContain('主人拒绝了')
    engine.stopTask(ticket.id, 'person')
    expect(store.db.select().from(schema.approvals).all().every(a => a.status !== 'pending')).toBe(true)
  })
})

describe('destructive actions', () => {
  it('go straight to the owner by default, without the model', async () => {
    let calls = 0
    const { engine, reviewer, start } = setup(() => { calls++; return { text: JSON.stringify({ decision: 'allow', reason: 'x' }) } })
    const ticket = start()
    await settle()
    const before = calls
    const decision = await reviewer.gateShell(engine.ticket(ticket.id), ticket.sessionId, 'git push --force origin HEAD:main', ticket.directory)
    expect(decision).toMatchObject({ action: 'escalate' })
    expect(calls).toBe(before)
  })
})

describe('external tool calls', () => {
  it('escalate under "ask" and run through the registered executor once approved', async () => {
    const { engine, reviewer, start } = setup(() => ({ text: '{}' }))
    const ticket = start()
    await settle()
    kvSet(store, 'settings:review', { mode: 'ask' })
    const calls: unknown[] = []
    reviewer.registerExecutor('mcp', async input => { calls.push(input); return 'sent' })
    const decision = await reviewer.gateTool(engine.ticket(ticket.id), ticket.sessionId, 'mcp', 'mail.send {"to":"a@b.c"}', { server: 'mail', tool: 'send', args: { to: 'a@b.c' } })
    expect(decision).toMatchObject({ action: 'escalate' })
    reviewer.decide((decision as { approvalId: string }).approvalId, true)
    await new Promise(r => setTimeout(r, 50))
    await settle()
    expect(calls).toEqual([expect.objectContaining({ server: 'mail', tool: 'send', args: { to: 'a@b.c' } })])
    expect(JSON.stringify(runtime.history(ticket.sessionId))).toContain('批准后已执行 mail.send')
  })
})
