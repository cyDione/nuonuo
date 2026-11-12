import { openStore, type Store } from '@nuonuo/db'
import { Effects } from '@nuonuo/db'
import { MemorySecrets } from '@nuonuo/models'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginManager } from './plugins'
import { SourceRegistry } from './registry'

const PLUGIN = join(__dirname, '../../../examples/plugins/mood')
// A variable path keeps the type checker away from the plain-JavaScript module.
const modPath = join(PLUGIN, 'mood.mjs')
const load = async () => await import(/* @vite-ignore */ modPath) as any

let store: Store | undefined
let manager: PluginManager | undefined
afterEach(async () => { await manager?.close(); manager = undefined; store?.close(); store = undefined })

function setup(sandbox: boolean) {
  store = openStore(':memory:')
  const registry = new SourceRegistry(store, new Effects(store), new MemorySecrets())
  const dir = mkdtempSync(join(tmpdir(), 'nn-mood-'))
  manager = new PluginManager(dir, registry, store, { sandbox })
  return { dir, plugins: manager }
}

describe('心境 model', () => {
  it('drifts mood and energy back to the baseline over time, but not trust', async () => {
    const m = await load()
    const s = { ...m.initial(0), mood: -0.8, energy: 1, trust: 90 }
    const later = m.settle(s, m.MOOD_HALF_LIFE_H * 3_600_000)
    expect(later.mood).toBeCloseTo(m.BASELINE.mood + (-0.8 - m.BASELINE.mood) / 2)
    expect(later.energy).toBeCloseTo(m.BASELINE.energy + (1 - m.BASELINE.energy) / 2)
    expect(later.trust).toBe(90)
  })

  it('picks the tone from this turn\'s words, never a cold one, and keeps the reply rules', async () => {
    const m = await load()
    const s = m.initial()
    expect(m.stance(s, m.guess('烦死了，接口又报500')).id).toBe('comrade')
    expect(m.stance(s, m.guess('唉，今天好难受')).id).toBe('listen')
    expect(m.stance(s, m.guess('帮我写个部署脚本')).id).toBe('focus')
    expect(m.stance({ ...s, mood: 0.7, trust: 80 }, m.guess('今天天气不错')).id).toBe('banter')
    expect(m.stance(s, m.guess('今天天气不错')).id).toBe('partner')
    const block = m.context({ ...s, trust: 70, lastFeedback: 'negative' }, '你怎么这么笨')
    expect(block).toContain('不影响你帮忙的程度')
    expect(block).toContain('直接、友善地指出')
    expect(block).toContain('换个方式')
    expect(block).toContain('mood_sync')
    expect(block.length).toBeLessThan(600)
  })

  it('moves with the report: thanks lift mood and trust, hostility stings a little, all within bounds', async () => {
    const m = await load()
    const up = m.apply(m.initial(0), { emotion: 'happy', intensity: 1, attitude: 'grateful', feedback: 'positive' }, 0)
    expect(up.delta.mood).toBeGreaterThan(0)
    expect(up.delta.trust).toBe(3)
    let s = m.initial(0)
    for (let i = 0; i < 30; i++) s = m.apply(s, { emotion: 'angry', intensity: 1, attitude: 'hostile', feedback: 'negative' }, 0).state
    expect(s.mood).toBe(-1)
    expect(s.trust).toBe(20)
    expect(s.energy).toBeLessThanOrEqual(1)
    expect(s.history).toHaveLength(30)
    expect(s.lastFeedback).toBe('negative')
  })
})

describe.each([true, false])('心境 plugin (sandbox %s)', sandbox => {
  it('adds a <mood> block to the main agent\'s input and updates it through mood_sync', async () => {
    const { dir, plugins } = setup(sandbox)
    cpSync(PLUGIN, join(dir, 'mood'), { recursive: true })
    await plugins.setEnabled('mood', true)
    expect(plugins.list().find(p => p.id === 'mood')).toMatchObject({ loaded: true, tools: ['mood_sync', 'mood_reset'] })
    const ext = plugins.agentExtensions()
    const first = await ext.inlineContext!('烦死了，接口又报500', undefined)
    expect(first).toContain('<mood>')
    expect(first).toContain('并肩解决')
    expect(first).toContain('信任 50/100')

    const tools = ext.routerTools!() as Record<string, { execute: (args: unknown, opts: unknown) => Promise<unknown> }>
    for (let i = 0; i < 6; i++) await tools.mood_sync!.execute({ emotion: 'happy', intensity: 0.8, attitude: 'grateful', feedback: 'positive' }, { toolCallId: '', messages: [] })
    const after = await ext.inlineContext!('今天天气不错', undefined)
    expect(after).toContain('信任 68/100')
    expect(after).toContain('直接、友善地指出')
  })
})

describe('plugin inlineContext', () => {
  it('skips a plugin that answers too slowly or throws, and keeps the others', async () => {
    const { dir, plugins } = setup(false)
    const write = (id: string, body: string) => {
      mkdirSync(join(dir, id))
      writeFileSync(join(dir, id, 'package.json'), JSON.stringify({ name: id, nuonuo: { plugin: './index.mjs' } }))
      writeFileSync(join(dir, id, 'index.mjs'), `export default { id: '${id}', ${body} }`)
    }
    write('slow', `inlineContext: () => new Promise(r => setTimeout(() => r('late'), 5000))`)
    write('broken', `inlineContext: () => { throw new Error('boom') }`)
    write('fine', `inlineContext: (_ctx, input) => 'saw ' + input.text + ' in ' + input.scope`)
    for (const id of ['slow', 'broken', 'fine']) await plugins.setEnabled(id, true)
    const started = Date.now()
    expect(await plugins.agentExtensions().inlineContext!('hi', 'proj')).toBe('saw hi in proj')
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
