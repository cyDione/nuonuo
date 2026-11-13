import { openStore, type Store } from '@nuonuo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalAccess } from './access'
import { LocalApps, MacPermissionError } from './localapps'

let store: Store
let access: LocalAccess
const calls: { script: string; args: any }[] = []
const asked: any[] = []
let decision: any = { action: 'escalate', approvalId: 'apv_1', reason: '先问你' }
const executors = new Map<string, (i: any) => Promise<string>>()
const reviewer = {
  askOwner: (_t: any, _s: string, tool: string, display: string, input: any) => { asked.push({ tool, display, input }); return decision },
  audit: () => {},
  registerExecutor: (tool: string, run: any) => executors.set(tool, run),
} as any
const ticket = { id: 'tkt_1', directory: '/tmp' } as any
const run = async (script: string, args: any) => { calls.push({ script, args }); return { ok: true } }

beforeEach(() => { store = openStore(':memory:'); access = new LocalAccess(store); calls.length = 0; asked.length = 0 })
afterEach(() => store.close())
const exec = (tools: any, name: string, input: any) => tools[name].execute(input, {})

describe('LocalApps', () => {
  it('offers nothing off a Mac', () => {
    expect(new LocalApps(access, reviewer, run, 'linux').tools(ticket, 'ses')).toEqual({})
  })
  it('filters tools by each app level', () => {
    access.save({ apps: { calendar: 'read', reminders: 'ask', notes: 'off', contacts: 'read', photos: 'off' } })
    const names = Object.keys(new LocalApps(access, reviewer, run, 'darwin').tools(ticket, 'ses')).sort()
    expect(names).toEqual(['contacts_search', 'reminder_add', 'reminder_complete', 'reminders_list'])
  })
  it('asks before a change at 先问你 and runs the approved one through the executor', async () => {
    access.save({ apps: { reminders: 'ask' } as any })
    const apps = new LocalApps(access, reviewer, run, 'darwin')
    const tools = apps.tools(ticket, 'ses')
    const out = await exec(tools, 'reminder_add', { title: '交房租', due: '2026-11-12T15:00:00+08:00' })
    expect(out).toContain('需要主人批准（apv_1）')
    expect(calls).toEqual([])
    expect(asked[0]).toMatchObject({ tool: 'localapp', input: { app: 'reminders', script: 'reminderAdd', label: '改提醒事项' } })
    await executors.get('localapp')!(asked[0].input)
    expect(calls[0]!.args).toMatchObject({ title: '交房租' })
  })
  it('changes directly at 直接做 and reads without asking', async () => {
    access.save({ apps: { reminders: 'auto' } as any })
    const tools = new LocalApps(access, reviewer, run, 'darwin').tools(ticket, 'ses')
    await exec(tools, 'reminder_add', { title: '交房租' })
    await exec(tools, 'reminders_list', {})
    expect(asked).toEqual([])
    expect(calls).toHaveLength(2)
  })
  it('turns a macOS refusal into a clear permission error', async () => {
    const denied = async () => { throw new Error('execution error: Not authorized to send Apple events to Calendar. (-1743)') }
    const tools = new LocalApps(access, reviewer, denied, 'darwin').tools(ticket, 'ses')
    await expect(exec(tools, 'reminders_list', {})).rejects.toBeInstanceOf(MacPermissionError)
    await expect(new LocalApps(access, reviewer, denied, 'darwin').calendarBackend()!.list({ from: 'a', to: 'b' })).rejects.toBeInstanceOf(MacPermissionError)
  })
})
