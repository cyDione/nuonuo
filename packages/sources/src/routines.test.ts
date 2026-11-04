import { openStore, schema, type Store } from '@super-agent/db'
import { afterEach, describe, expect, it } from 'vitest'
import { cronMatches, lastRunBetween, nextRun, parseCron } from './cron'
import { Routines } from './routines'

const at = (s: string) => new Date(s)

describe('cron', () => {
  it('parses lists, ranges, steps and Sunday as 0 or 7', () => {
    const c = parseCron('*/15 9-17 * * 1-5')
    expect(cronMatches(c, at('2026-11-04T09:30:00'))).toBe(true) // Wednesday
    expect(cronMatches(c, at('2026-11-04T09:31:00'))).toBe(false)
    expect(cronMatches(c, at('2026-11-08T09:30:00'))).toBe(false) // Sunday
    expect(cronMatches(parseCron('0 8 * * 7'), at('2026-11-08T08:00:00'))).toBe(true)
    expect(() => parseCron('61 * * * *')).toThrow(/超出范围/)
    expect(() => parseCron('0 9 * *')).toThrow(/5 个字段/)
  })
  it('finds the next and the last run', () => {
    const c = parseCron('0 9 * * *')
    expect(nextRun(c, at('2026-11-04T09:00:00'))!.toISOString()).toBe(at('2026-11-05T09:00:00').toISOString())
    expect(lastRunBetween(c, at('2026-11-04T08:00:00').getTime(), at('2026-11-04T10:00:00').getTime())!.getHours()).toBe(9)
    expect(lastRunBetween(c, at('2026-11-04T09:30:00').getTime(), at('2026-11-04T10:00:00').getTime())).toBeUndefined()
  })
})

let store: Store
afterEach(() => store?.close())

describe('Routines', () => {
  it('fires once per due time, catches up after sleep within 12 h, and skips older misses', () => {
    store = openStore(':memory:')
    const routines = new Routines(store)
    const r = routines.create({ name: '简报', schedule: '0 9 * * *', prompt: '总结昨天' })
    const t0 = at('2026-11-04T08:59:00').getTime()
    store.db.update(schema.routines).set({ lastFiredAt: t0 }).where(undefined as any).run()
    const fired: string[] = []
    const fire = (x: { name: string }, when: Date) => fired.push(`${x.name}@${when.getHours()}:${when.getMinutes()}`)
    expect(routines.tick(fire, at('2026-11-04T08:59:30').getTime())).toHaveLength(0)
    expect(routines.tick(fire, at('2026-11-04T09:00:10').getTime())).toHaveLength(1)
    expect(routines.tick(fire, at('2026-11-04T09:05:00').getTime())).toHaveLength(0)
    // The laptop slept from 08:00 to 15:00 the next day: one catch-up run.
    expect(routines.tick(fire, at('2026-11-05T15:00:00').getTime())).toHaveLength(1)
    // Asleep for two days: the 9:00 run is more than 12 h old, so nothing fires late.
    expect(routines.tick(fire, at('2026-11-07T23:00:00').getTime())).toHaveLength(0)
    expect(fired).toEqual(['简报@9:0', '简报@9:0'])
    routines.update(r.id, { enabled: false })
    expect(routines.list()[0]!.next).toBeNull()
  })
})
