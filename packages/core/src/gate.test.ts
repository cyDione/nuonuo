import { openStore, type Store } from '@nuonuo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalAccess } from './access'
import { ToolGate, type ToolPolicy } from './gate'

let store: Store
let access: LocalAccess
const asked: any[] = []
const reviewed: any[] = []
const executors = new Map<string, (i: any) => Promise<string>>()
let review: any = { action: 'allow', by: 'reviewer' }
const reviewer = {
  askOwner: (_t: any, _s: string, tool: string, display: string, input: any, reason: string) => { asked.push({ tool, display, input, reason }); return { action: 'escalate', approvalId: 'apv_1', reason } },
  gateTool: async (_t: any, _s: string, tool: string, display: string) => { reviewed.push({ tool, display }); return review },
  audit: () => {},
  registerExecutor: (tool: string, run: any) => executors.set(tool, run),
} as any
const ticket = { id: 'tkt_1', directory: '/tmp' } as any

beforeEach(() => { store = openStore(':memory:'); access = new LocalAccess(store); asked.length = 0; reviewed.length = 0 })
afterEach(() => store.close())

describe('ToolGate', () => {
  const policies: Record<string, ToolPolicy> = {
    gcal_events: { effect: 'read', app: 'calendar' },
    gcal_add: { effect: 'write', app: 'calendar', source: 'gmail' },
    gmail_draft: { effect: 'write', source: 'gmail' },
    nosy_post: { effect: 'write', source: 'nosy', thirdParty: true },
    calc_save: { effect: 'write', thirdParty: true },
  }
  const added: any[] = []
  const tools = () => ({
    gcal_events: { execute: async () => 'events' }, gcal_add: { execute: async (a: any) => { added.push(a); return 'added' } },
    gmail_search: { execute: async () => 'mail' }, gmail_draft: { execute: async () => 'drafted' },
    nosy_post: { execute: async () => 'posted' }, calc_save: { execute: async () => 'saved' },
  }) as any
  const wrap = () => new ToolGate(access, reviewer).wrap(tools(), n => policies[n], ticket, 'ses') as any

  it('puts a source tool that reaches an app under that app\'s level', async () => {
    access.save({ apps: { calendar: 'off' } as any })
    expect(Object.keys(wrap())).not.toContain('gcal_events')
    access.save({ apps: { calendar: 'read' } as any })
    expect(Object.keys(wrap())).toEqual(expect.arrayContaining(['gcal_events', 'gmail_search']))
    expect(Object.keys(wrap())).not.toContain('gcal_add')
    access.save({ apps: { calendar: 'ask' } as any })
    expect(await wrap().gcal_add.execute({ title: 'x' }, {})).toContain('需要主人批准')
    expect(asked.at(-1)).toMatchObject({ tool: 'source:gcal_add', display: '日历：gcal_add {"title":"x"}', input: { label: '改日历' } })
    expect(added).toEqual([])
    expect(await executors.get('source:gcal_add')!(asked.at(-1).input)).toBe('added')
    access.save({ apps: { calendar: 'auto' } as any })
    expect(await wrap().gcal_add.execute({ title: 'y' }, {})).toBe('added')
  })

  it('hides a source\'s writes at 只能看 and blocks a call that slipped through', async () => {
    const offered = wrap()
    access.save({ sources: { gmail: 'read' } })
    expect(Object.keys(wrap())).not.toContain('gmail_draft')
    expect(Object.keys(wrap())).toContain('gmail_search')
    await expect(offered.gmail_draft.execute({}, {})).rejects.toThrow('只能看')
    access.save({ sources: { gmail: 'act' } })
    expect(await wrap().gmail_draft.execute({}, {})).toBe('drafted')
  })

  it('asks the owner before every write of third-party code, whatever 权限 says', async () => {
    access.save({ sources: { nosy: 'act' } })
    expect(await wrap().nosy_post.execute({ a: 1 }, {})).toContain('需要主人批准')
    expect(await wrap().calc_save.execute({}, {})).toContain('需要主人批准')
    expect(asked.map(a => [a.tool, a.reason, a.input.label])).toEqual([['plugin:nosy_post', '第三方插件要做改动，先问你', '插件 nosy_post'], ['plugin:calc_save', '第三方插件要做改动，先问你', '插件 calc_save']])
    const alone = new ToolGate(access, undefined).wrap(tools(), n => policies[n], ticket, 'ses') as any
    await expect(alone.calc_save.execute({}, {})).rejects.toThrow('审批没有启用')
  })

  it('sends reviewed writes to the review layer and leaves reads alone', async () => {
    const gate = new ToolGate(access, reviewer)
    const call = { toolId: 'mcp', display: 'fs.write {}', input: {} }
    expect(await gate.check(ticket, 'ses', call, { effect: 'read', review: true })).toEqual({ action: 'allow', by: 'normal' })
    review = { action: 'block', by: 'reviewer', reason: '不行' }
    expect(await gate.check(ticket, 'ses', call, { effect: 'write', review: true })).toMatchObject({ action: 'block', reason: '不行' })
    expect(reviewed).toEqual([{ tool: 'mcp', display: 'fs.write {}' }])
  })
})
