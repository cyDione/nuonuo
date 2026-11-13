import { openStore, type Store } from '@nuonuo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalAccess } from './access'
import { calendarTools, registerCalendarExecutor, type CalendarBackend, type NewCalendarEvent } from './calendar'
import { ToolGate } from './gate'

let store: Store
let access: LocalAccess
const asked: any[] = []
const executors = new Map<string, (i: any) => Promise<string>>()
const reviewer = {
  askOwner: (_t: any, _s: string, tool: string, display: string, input: any) => { asked.push({ tool, display, input }); return { action: 'escalate', approvalId: 'apv_1', reason: '先问你' } },
  audit: () => {},
  registerExecutor: (tool: string, run: any) => executors.set(tool, run),
} as any
const ticket = { id: 'tkt_1', directory: '/tmp' } as any

beforeEach(() => { store = openStore(':memory:'); access = new LocalAccess(store); asked.length = 0 })
afterEach(() => store.close())

function backends() {
  const added: Record<string, NewCalendarEvent[]> = { mac: [], gmail: [] }
  const list: CalendarBackend[] = [
    { id: 'mac', label: 'Mac 日历', list: async () => [{ id: 'm1', title: '牙医', start: '2026-11-12T15:00:00+08:00', end: '2026-11-12T16:00:00+08:00' }], add: async e => { added.mac!.push(e); return { id: 'm2', calendar: '家庭' } } },
    { id: 'gmail', label: 'Google 日历', list: async () => [{ id: 'g1', title: '周会', start: '2026-11-12T10:00:00+08:00', end: '2026-11-12T11:00:00+08:00' }], add: async e => { added.gmail!.push(e); return { id: 'g2', url: 'https://calendar.google.com/e/g2' } } },
    { id: 'shared', label: '共享日历', list: async () => { throw new Error('断网') } },
  ]
  return { list, added }
}
const tools = (b: CalendarBackend[]) => calendarTools(b, new ToolGate(access, reviewer), ticket, 'ses') as any

describe('calendar capability', () => {
  it('lists every backend\'s events in one sorted list, and says which ones could not be reached', async () => {
    const { list } = backends()
    const out = await tools(list).calendar_events.execute({ from: '2026-11-12T00:00:00+08:00', to: '2026-11-13T00:00:00+08:00' }, {})
    expect(out.events.map((e: any) => [e.backend, e.title])).toEqual([['gmail', '周会'], ['mac', '牙医']])
    expect(out.unavailable).toEqual(['共享日历：断网'])
  })

  it('follows the 日历 level for every backend', async () => {
    const { list } = backends()
    access.save({ apps: { calendar: 'off' } as any })
    expect(tools(list)).toEqual({})
    access.save({ apps: { calendar: 'read' } as any })
    expect(Object.keys(tools(list))).toEqual(['calendar_events'])
    access.save({ apps: { calendar: 'auto' } as any })
    expect(Object.keys(tools(list))).toEqual(['calendar_events', 'calendar_add'])
  })

  it('asks which backend when several can take the event, asks the owner at 先问你, and adds once approved', async () => {
    const { list, added } = backends()
    registerCalendarExecutor(reviewer, () => list)
    access.save({ apps: { calendar: 'ask' } as any })
    const event = { title: '体检', start: '2026-11-14T09:00:00+08:00', end: '2026-11-14T10:00:00+08:00' }
    await expect(tools(list).calendar_add.execute(event, {})).rejects.toThrow('backend')
    expect(await tools(list).calendar_add.execute({ ...event, backend: 'gmail' }, {})).toContain('需要主人批准')
    expect(asked[0]).toMatchObject({ tool: 'calendar', display: '在Google 日历里加「体检」2026-11-14T09:00:00+08:00 – 2026-11-14T10:00:00+08:00', input: { backend: 'gmail', label: '改日历' } })
    expect(added.gmail).toEqual([])
    expect(await executors.get('calendar')!(asked[0].input)).toBe('已加到Google 日历：体检（g2） https://calendar.google.com/e/g2')
    access.save({ apps: { calendar: 'auto' } as any })
    expect(await tools([list[0]!]).calendar_add.execute(event, {})).toBe('已加到Mac 日历「家庭」：体检（m2）')
    expect(added.mac).toEqual([{ ...event, allDay: false }])
  })
})
