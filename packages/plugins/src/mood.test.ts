import { Effects, openStore, type Store } from '@nuonuo/db'
import { MemorySecrets } from '@nuonuo/models'
import { PluginManager, SourceRegistry } from '@nuonuo/sources'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyReport, BASELINE, guessOwner, initialMood, MOOD_HALF_LIFE_H, moodContext, moodPlugin, moodSummary, moodView, resetMood, setMoodEnabled, settleMood, stanceFor } from './mood'

describe('心境 model', () => {
  it('drifts mood and energy back to the baseline over time, but not trust', () => {
    const s = { ...initialMood(0), mood: -0.8, energy: 1, trust: 90 }
    const later = settleMood(s, MOOD_HALF_LIFE_H * 3_600_000)
    expect(later.mood).toBeCloseTo(BASELINE.mood + (-0.8 - BASELINE.mood) / 2)
    expect(later.energy).toBeCloseTo(BASELINE.energy + (1 - BASELINE.energy) / 2)
    expect(later.trust).toBe(90)
  })

  it('picks the tone from this turn\'s words, never a cold one, and keeps the reply rules', () => {
    const s = initialMood()
    expect(stanceFor(s, guessOwner('烦死了，接口又报500')).id).toBe('comrade')
    expect(stanceFor(s, guessOwner('唉，今天好累')).id).toBe('listen')
    expect(stanceFor(s, guessOwner('帮我写个部署脚本')).id).toBe('focus')
    expect(stanceFor({ ...s, mood: 0.7, trust: 80 }, guessOwner('今天天气不错')).id).toBe('banter')
    expect(stanceFor(s, guessOwner('今天天气不错')).id).toBe('partner')
    const block = moodContext({ ...s, trust: 70, lastFeedback: 'negative' }, '你怎么这么笨')
    expect(block).toContain('不影响你帮忙的程度')
    expect(block).toContain('直接、友善地指出')
    expect(block).toContain('换个方式')
    expect(block).toContain('mood_sync')
    expect(block.length).toBeLessThan(600)
  })

  it('moves with the report: thanks lift mood and trust, hostility stings a little, all within bounds', () => {
    const up = applyReport(initialMood(0), { emotion: 'happy', intensity: 1, attitude: 'grateful', feedback: 'positive' }, 0)
    expect(up.delta.mood).toBeGreaterThan(0)
    expect(up.delta.trust).toBe(3)
    let s = initialMood(0)
    for (let i = 0; i < 60; i++) s = applyReport(s, { emotion: 'angry', intensity: 1, attitude: 'hostile', feedback: 'negative' }, 0).state
    expect(s.mood).toBe(-1)
    expect(s.trust).toBe(0)
    expect(s.energy).toBeLessThanOrEqual(1)
    expect(s.history).toHaveLength(50)
    expect(moodSummary(s)).toBe('低落，有精神')
    expect(moodSummary(initialMood())).toBe('心情不错，平稳')
  })
})

describe('心境 built in', () => {
  let store: Store | undefined
  afterEach(() => { store?.close(); store = undefined })

  it('stays silent until switched on, then adds its block and takes mood_sync; reset starts over', async () => {
    store = openStore(':memory:')
    const plugins = new PluginManager(mkdtempSync(join(tmpdir(), 'nn-mood-')), new SourceRegistry(store, new Effects(store), new MemorySecrets()), store, { sandbox: false })
    plugins.registerBuiltIn(moodPlugin)
    expect(plugins.list().find(p => p.id === 'mood')).toMatchObject({ builtIn: true })
    const ext = plugins.agentExtensions()
    const state = plugins.stateOf('mood')
    expect(await ext.inlineContext!('烦死了，接口又报500', undefined)).toBe('')
    expect(Object.keys(ext.routerTools!())).toEqual([])

    setMoodEnabled(state, true)
    const first = await ext.inlineContext!('烦死了，接口又报500', undefined)
    expect(first).toContain('并肩解决')
    expect(first).toContain('信任 50/100')
    const tools = ext.routerTools!() as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>
    for (let i = 0; i < 6; i++) await tools.mood_sync!.execute({ emotion: 'happy', intensity: 0.8, attitude: 'grateful', feedback: 'positive' }, { toolCallId: '', messages: [] })
    expect(moodView(state)).toMatchObject({ enabled: true, trust: 68 })
    expect(moodView(state).history).toHaveLength(6)
    expect(await ext.inlineContext!('今天天气不错', undefined)).toContain('直接、友善地指出')

    resetMood(state)
    expect(moodView(state)).toMatchObject({ enabled: true, trust: 50, history: [] })
    setMoodEnabled(state, false)
    expect(await ext.inlineContext!('今天天气不错', undefined)).toBe('')
  })
})
