import { afterEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from './database'
import { Effects, Later } from './effects'
import { kvGet, kvSet } from './kv'

let store: Store
afterEach(() => store?.close())

function setup() {
  store = openStore(':memory:')
  let clock = 1_000
  const effects = new Effects(store, () => clock)
  return { effects, advance: (ms: number) => { clock += ms } }
}

describe('Effects', () => {
  it('runs a queued row once and deletes it', async () => {
    const { effects } = setup()
    const seen: unknown[] = []
    effects.handle('reply', async (p: { text: string }) => { seen.push(p.text) })
    store.atomic(() => effects.enqueue('reply', 'k1', { text: 'hi' }))
    await effects.tick()
    await effects.tick()
    expect(seen).toEqual(['hi'])
    expect(effects.health()).toEqual([])
  })

  it('replaces the payload of a waiting row with the same key', async () => {
    const { effects } = setup()
    const seen: string[] = []
    effects.handle('reply', async (p: { text: string }) => { seen.push(p.text) })
    effects.enqueue('reply', 'k', { text: 'a' })
    effects.enqueue('reply', 'k', { text: 'b' })
    await effects.tick()
    expect(seen).toEqual(['b'])
  })

  it('does not run work enqueued inside a rolled-back transaction', async () => {
    const { effects } = setup()
    const seen: string[] = []
    effects.handle('reply', async (p: { text: string }) => { seen.push(p.text) })
    expect(() => store.atomic(() => { effects.enqueue('reply', 'k', { text: 'x' }); throw new Error('boom') })).toThrow('boom')
    await effects.tick()
    expect(seen).toEqual([])
  })

  it('backs off exponentially and reports failing after three attempts', async () => {
    const { effects, advance } = setup()
    let calls = 0
    effects.handle('send', async () => { calls++; throw new Error('down') }, { baseDelayMs: 100, maxDelayMs: 1_000 })
    effects.enqueue('send', 'k', {})
    await effects.tick() // attempt 1 -> due +100
    await effects.tick()
    expect(calls).toBe(1)
    advance(100); await effects.tick() // attempt 2 -> due +200
    advance(199); await effects.tick()
    expect(calls).toBe(2)
    advance(1); await effects.tick() // attempt 3
    expect(calls).toBe(3)
    expect(effects.health()).toEqual([{ kind: 'send', pending: 1, failing: 1, lastError: 'down' }])
  })

  it('defers on Later without counting a failure', async () => {
    const { effects, advance } = setup()
    let calls = 0
    effects.handle('launch', async () => { calls++; if (calls === 1) throw new Later(50) })
    effects.enqueue('launch', 'k', {})
    await effects.tick()
    expect(effects.health()[0]).toMatchObject({ pending: 1, failing: 0 })
    advance(50); await effects.tick()
    expect(calls).toBe(2)
    expect(effects.health()).toEqual([])
  })
})

describe('kv and migrations', () => {
  it('round-trips json values and reopens idempotently', () => {
    store = openStore(':memory:')
    kvSet(store, 'a', { x: 1 })
    expect(kvGet(store, 'a')).toEqual({ x: 1 })
    expect(store.sqlite.pragma("user_version", { simple: true })).toBe(5)
  })
})
