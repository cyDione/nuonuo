import { Effects, openStore, type Store } from '@nuonuo/db'
import { MemorySecrets } from '@nuonuo/models'
import { PluginManager, SourceRegistry } from '@nuonuo/sources'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addDiary, applyReport, applyStop, BASELINE, describeTone, diaryOf, GRUDGE_HALF_LIFE_H, guessOwner, hadHeatedTurn, initialMood, isHeatedTurn, MOOD_HALF_LIFE_H, moodContext, moodEnabled, moodPlugin, moodSummary, moodView, normalizeTone, PATIENCE_HALF_LIFE_H, pinDiary, recordMoodStop, removeDiary, resetMood, setMindConfig, setMoodEnabled, setMoodTone, setMoodValues, settleMood, stanceFor, UNDERTONE_HALF_LIFE_H } from './mood'

describe('心境 model', () => {
  it('drifts mood and energy back to the baseline over time, but not trust', () => {
    const s = { ...initialMood(0), mood: -0.8, energy: 1, trust: 90 }
    const later = settleMood(s, MOOD_HALF_LIFE_H * 3_600_000)
    expect(later.mood).toBeCloseTo(BASELINE.mood + (-0.8 - BASELINE.mood) / 2)
    expect(later.energy).toBeCloseTo(BASELINE.energy + (1 - BASELINE.energy) / 2)
    expect(later.trust).toBe(90)
    const p = settleMood({ ...initialMood(0), patience: 0 }, PATIENCE_HALF_LIFE_H * 3_600_000)
    expect(p.patience).toBeCloseTo(BASELINE.patience / 2)
  })

  it('turns cool once patience runs out after being snapped at, and the sensitivities scale how much it moves', () => {
    let s = initialMood(0)
    for (let i = 0; i < 4; i++) s = applyReport(s, { emotion: 'angry', intensity: 1, attitude: 'hostile', feedback: 'negative' }, 0).state
    expect(s.patience).toBeLessThan(35)
    expect(stanceFor(s, guessOwner('帮我写个部署脚本')).id).toBe('cool')
    expect(moodContext(s, '帮我写个部署脚本')).toContain('不讨好地道歉')
    expect(moodContext({ ...s, trust: 90 }, 'x')).not.toContain('直接、友善地指出')
    const soft = applyReport(initialMood(0), { emotion: 'neutral', intensity: 0, attitude: 'hostile', feedback: 'neutral' }, 0, { up: 1, down: 0.4 })
    const hard = applyReport(initialMood(0), { emotion: 'neutral', intensity: 0, attitude: 'hostile', feedback: 'neutral' }, 0, { up: 1, down: 1.6 })
    expect(hard.delta.patience).toBe(soft.delta.patience * 4)
    expect(applyReport(initialMood(0), { emotion: 'neutral', intensity: 0, attitude: 'grateful', feedback: 'neutral' }, 0, { up: 9, down: 1 }).delta.trust).toBe(5)
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

  it('holds grudges across a two-layer mood: one compliment after hostility recovers less and stays guarded until it fades', () => {
    const freshPraise = applyReport(initialMood(0), { emotion: 'happy', intensity: 0.8, attitude: 'grateful', feedback: 'positive' }, 0)
    let hurt = initialMood(0)
    hurt = applyReport(hurt, { emotion: 'angry', intensity: 0.9, attitude: 'hostile', feedback: 'negative' }, 0).state
    hurt = applyReport(hurt, { emotion: 'angry', intensity: 0.9, attitude: 'hostile', feedback: 'negative' }, 0).state
    expect(hurt.grudge).toBeGreaterThan(0.6)
    expect(hurt.undertone).toBeLessThan(BASELINE.mood)

    // One sudden compliment is dampened by the grudge (stays cool at first; a second compliment leaves cool into 防备克制, still not partner).
    const firstPraise = applyReport(hurt, { emotion: 'happy', intensity: 0.8, attitude: 'grateful', feedback: 'positive' }, 0)
    expect(firstPraise.delta.mood).toBeLessThan(freshPraise.delta.mood * 0.65)
    expect(stanceFor(firstPraise.state, guessOwner('今天天气不错')).id).toBe('cool')
    const secondPraise = applyReport(firstPraise.state, { emotion: 'happy', intensity: 0.5, attitude: 'respectful', feedback: 'positive' }, 0)
    expect(secondPraise.state.mood).toBeGreaterThan(-0.3)
    expect(stanceFor(secondPraise.state, guessOwner('今天天气不错')).id).toBe('guarded')
    expect(moodContext(secondPraise.state, '今天天气不错')).toContain('防备克制')
    expect(moodContext(secondPraise.state, '今天天气不错')).toContain('积了点怨气')

    // Fast mood settles toward the lowered undertone over MOOD_HALF_LIFE_H, while grudge and undertone fade much slower.
    const sixHours = settleMood(hurt, MOOD_HALF_LIFE_H * 3_600_000)
    expect(sixHours.undertone).toBeLessThan(0.1)
    expect(sixHours.grudge).toBeGreaterThan(0.35)
    const twoDays = settleMood(hurt, Math.max(GRUDGE_HALF_LIFE_H * 3, UNDERTONE_HALF_LIFE_H) * 3_600_000)
    expect(twoDays.grudge).toBeLessThan(0.2)
    expect(stanceFor(twoDays, guessOwner('今天天气不错')).id).toBe('partner')
  })

  it('treats stopping mid-flight as a faint signal and detects heated turns for memory gating', () => {
    const once = applyStop(initialMood(0), 0, { down: 1 }, '停下「查机票」')
    expect(once.mood).toBeCloseTo(BASELINE.mood - 0.03)
    expect(once.patience).toBe(BASELINE.patience - 2)
    expect(once.trust).toBe(BASELINE.trust)
    expect(once.grudge).toBeCloseTo(0.03)
    expect(stanceFor(once).id).toBe('partner')
    expect(once.history.at(-1)).toMatchObject({ attitude: 'stopped', note: '停下「查机票」' })

    expect(isHeatedTurn({ emotion: 'angry', intensity: 0.85, attitude: 'casual' })).toBe(true)
    expect(isHeatedTurn({ emotion: 'neutral', intensity: 0.5, attitude: 'hostile' })).toBe(true)
    expect(isHeatedTurn({ emotion: 'happy', intensity: 0.9, attitude: 'grateful' })).toBe(false)
    expect(isHeatedTurn({ emotion: 'anxious', intensity: 0.3, attitude: 'respectful' })).toBe(false)
  })
})

describe('心境 built in', () => {
  let store: Store | undefined
  afterEach(() => { store?.close(); store = undefined })

  it('is on by default, stays silent when switched off, adds its block and takes mood_sync; reset starts over', async () => {
    store = openStore(':memory:')
    const plugins = new PluginManager(mkdtempSync(join(tmpdir(), 'nn-mood-')), new SourceRegistry(store, new Effects(store), new MemorySecrets()), store, { sandbox: false })
    plugins.registerBuiltIn(moodPlugin)
    expect(plugins.list().find(p => p.id === 'mood')).toMatchObject({ builtIn: true })
    const ext = plugins.agentExtensions()
    const state = plugins.stateOf('mood')
    expect(moodEnabled(state)).toBe(true)
    expect(moodView(state).enabled).toBe(true)
    expect(Object.keys(ext.routerTools!())).toEqual(['mood_sync'])

    setMoodEnabled(state, false)
    expect(moodEnabled(state)).toBe(false)
    expect(await ext.inlineContext!('烦死了，接口又报500', undefined)).toBe('')
    expect(Object.keys(ext.routerTools!())).toEqual([])

    setMoodEnabled(state, true)
    const first = await ext.inlineContext!('烦死了，接口又报500', undefined)
    expect(first).toContain('战友破局')
    expect(first).toContain('信任 50/100')
    const tools = ext.routerTools!() as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>
    for (let i = 0; i < 6; i++) await tools.mood_sync!.execute({ emotion: 'happy', intensity: 0.8, attitude: 'grateful', feedback: 'positive' }, { toolCallId: '', messages: [] })
    expect(moodView(state)).toMatchObject({ enabled: true, trust: 68 })
    expect(moodView(state).history).toHaveLength(6)
    expect(moodView(state).history[0]!.note).toBe('烦死了，接口又报500')
    expect(await ext.inlineContext!('今天天气不错', undefined)).toContain('直接、友善地指出')

    setMoodValues(state, { mood: -0.9, patience: 10 })
    expect(moodView(state).stance.id).toBe('cool')
    resetMood(state)
    expect(moodView(state)).toMatchObject({ enabled: true, mood: BASELINE.mood, patience: BASELINE.patience, trust: 68 })
    expect(moodView(state).history).toHaveLength(6)
    expect(moodView(state).stance.id).toBe('partner')
    setMoodEnabled(state, false)
    recordMoodStop(state, '不该记')
    expect(moodView(state).history).toHaveLength(6)
    setMoodEnabled(state, true)
    recordMoodStop(state, '停下「部署」', 10_000)
    expect(moodView(state).history).toHaveLength(7)
    expect(hadHeatedTurn(state, 0, 20_000)).toBe(false)
    await tools.mood_sync!.execute({ emotion: 'angry', intensity: 0.9, attitude: 'hostile', feedback: 'negative' }, { toolCallId: '', messages: [] })
    expect(hadHeatedTurn(state, Date.now() - 1_000)).toBe(true)
    resetMood(state)
    expect(moodView(state).stance.id).toBe('partner')
    setMoodEnabled(state, false)
    expect(await ext.inlineContext!('今天天气不错', undefined)).toBe('')
  })

  it('keeps a few diary lines a day, shows them only when feelings come up, and lets the owner pin or delete them', async () => {
    store = openStore(':memory:')
    const plugins = new PluginManager(mkdtempSync(join(tmpdir(), 'nn-mood-')), new SourceRegistry(store, new Effects(store), new MemorySecrets()), store, { sandbox: false })
    plugins.registerBuiltIn(moodPlugin)
    const ext = plugins.agentExtensions()
    const state = plugins.stateOf('mood')
    const tools = ext.routerTools!() as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>
    const sync = (diary?: string) => tools.mood_sync!.execute({ emotion: 'happy', intensity: 0.5, attitude: 'grateful', feedback: 'positive', ...(diary ? { diary } : {}) }, { toolCallId: '', messages: [] })
    expect(await sync('他终于修完了那个 bug，还说了谢谢。')).toMatchObject({ diary: 'kept' })
    await sync(); await sync('第二条'); await sync('第三条')
    expect(await sync('第四条')).not.toHaveProperty('diary')
    expect(diaryOf(state).map(d => d.text)).toEqual(['第三条', '第二条', '他终于修完了那个 bug，还说了谢谢。'])
    expect(await ext.inlineContext!('帮我写个部署脚本', undefined)).not.toContain('日记')
    const id = diaryOf(state)[2]!.id
    pinDiary(state, id, true)
    removeDiary(state, diaryOf(state)[0]!.id)
    const block = await ext.inlineContext!('唉，今天好累', undefined)
    expect(block).toContain('你自己的日记')
    expect(block).toContain('他终于修完了那个 bug')
    setMindConfig(state, { diary: false, up: 7 })
    expect(moodView(state).config).toEqual({ up: 2.5, down: 1, diary: false })
    expect(await sync('不该记')).not.toHaveProperty('diary')
    expect(await ext.inlineContext!('唉，今天好累', undefined)).not.toContain('你自己的日记')
    expect(addDiary(state, '  ', 0)).toBe(false)
  })

  it('persists 2D neutral tone pad coordinates, snaps near-origin to (0,0), maps all four corners and injects dynamic bubble exemplars', async () => {
    store = openStore(':memory:')
    const plugins = new PluginManager(mkdtempSync(join(tmpdir(), 'nn-mood-')), new SourceRegistry(store, new Effects(store), new MemorySecrets()), store, { sandbox: false })
    plugins.registerBuiltIn(moodPlugin)
    const ext = plugins.agentExtensions()
    const state = plugins.stateOf('mood')

    // Default origin is 自然 (0, 0)
    expect(moodView(state).tone).toEqual({ x: 0, y: 0, id: 'natural', label: '自然', strength: 0 })
    expect(normalizeTone({ x: 0.03, y: -0.04 })).toEqual({ x: 0, y: 0 })
    expect(describeTone({ x: 0.04, y: 0.03 })).toMatchObject({ x: 0, y: 0, id: 'natural', label: '自然', strength: 0 })

    // Four corners: 左上 (-1, +1) 温和, 右上 (+1, +1) 风趣, 左下 (-1, -1) 沉静, 右下 (+1, -1) 犀利
    setMoodTone(state, { x: -0.8, y: 0.6 })
    expect(moodView(state).tone).toEqual({ x: -0.8, y: 0.6, id: 'warm', label: '温和', strength: 100 })
    expect(await ext.inlineContext!('烦死了，又报错了', undefined)).toContain('["先别急，歇口气", "剩下的交给我收尾就行"]')

    setMoodTone(state, { x: 0.8, y: 0.6 })
    expect(moodView(state).tone).toEqual({ x: 0.8, y: 0.6, id: 'witty', label: '风趣', strength: 100 })
    expect(await ext.inlineContext!('今天好累', undefined)).toContain('["看出来了，今天脑细胞已经打卡下班了", "发过来吧，最后这点我替你收了"]')

    setMoodTone(state, { x: -0.8, y: -0.6 })
    expect(moodView(state).tone).toEqual({ x: -0.8, y: -0.6, id: 'calm', label: '沉静', strength: 100 })
    expect(await ext.inlineContext!('在吗', undefined)).toContain('["嗯，先放着吧", "我在，有急事替你盯着"]')

    setMoodTone(state, { x: 0.8, y: -0.6 })
    expect(moodView(state).tone).toEqual({ x: 0.8, y: -0.6, id: 'sharp', label: '犀利', strength: 100 })
    expect(await ext.inlineContext!('接口报错 500', undefined)).toContain('["这报错写得挺直白，配置漏了一行", "交给我改吧，两分钟的事"]')

    // Even when dynamic mood shifts are disabled, off-center tone pad still injects <mood> tone guidance
    setMoodEnabled(state, false)
    const toneOnly = await ext.inlineContext!('帮我看看配置', undefined)
    expect(toneOnly).toContain('<mood>')
    expect(toneOnly).toContain('犀利')
    expect(toneOnly).toContain('["这报错写得挺直白，配置漏了一行", "交给我改吧，两分钟的事"]')

    // Snapping back to origin (< 0.06) returns to 自然 and stays silent when mood is disabled
    setMoodTone(state, { x: 0.02, y: -0.03 })
    expect(moodView(state).tone).toEqual({ x: 0, y: 0, id: 'natural', label: '自然', strength: 0 })
    expect(await ext.inlineContext!('帮我看看配置', undefined)).toBe('')
  })
})
