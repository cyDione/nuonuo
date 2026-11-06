import { generateOf, lastUserText } from '@super-assistant/agent-runtime/src/testing'
import { openStore, type Store } from '@super-assistant/db'
import { MemorySecrets, ModelHub } from '@super-assistant/models'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { Ideas } from './ideas'

let store: Store
afterEach(() => store?.close())

const ANSWER = { cards: [
  { kind: 'trip', label: '京都 · 11.28 出发', text: '带爸妈的话，第 2 天换成岚山小火车，少走 6 公里。', action: '排进行程', say: '把第 2 天换成岚山小火车', tone: 'coral' },
  { kind: 'work', label: '周报', text: '要不要我每周五 15:00 先起个草？', action: '好啊', say: '每周五 15:00 帮我起周报草稿', tone: 'lilac' },
], more: [{ text: '把耳机对比发给 Lin', say: '把耳机对比表发给 Lin' }] }

function setup(at: Date) {
  store = openStore(':memory:')
  const prompts: string[] = []
  const hub = new ModelHub(store, new MemorySecrets(), {
    language: () => new MockLanguageModelV4({ doGenerate: async o => { prompts.push(lastUserText(o)); return generateOf({ text: JSON.stringify(ANSWER) }) } }),
    embedding: () => { throw new Error('x') },
  })
  const providerId = hub.createProvider({ kind: 'openai', name: 'p', apiKey: 'k' }).id
  hub.saveRole('router', { chain: [{ providerId, model: 'm' }] })
  let now = at.getTime()
  const ideas = new Ideas(store, hub, () => '## Recent conversations\n京都行程', () => now)
  return { ideas, prompts, tick: (ms: number) => { now += ms } }
}

describe('Ideas', () => {
  it('thinks up a batch each morning, and none when turned off', async () => {
    const { ideas, tick } = setup(new Date(2026, 10, 6, 6, 30))
    expect(ideas.due()).toBe(false) // before 7:00
    tick(60 * 60_000)
    expect(ideas.due()).toBe(true)
    const batch = await ideas.refresh()
    expect(batch.cards.map(c => c.label)).toEqual(['京都 · 11.28 出发', '周报'])
    expect(ideas.due()).toBe(false)
    tick(24 * 3_600_000)
    expect(ideas.due()).toBe(true)
    ideas.saveSettings({ cadence: 'weekly' })
    expect(ideas.due()).toBe(false)
    ideas.saveSettings({ cadence: 'off' })
    tick(8 * 24 * 3_600_000)
    expect(ideas.due()).toBe(false)
  })

  it('suggests less of what the owner keeps putting away', async () => {
    const { ideas, prompts } = setup(new Date(2026, 10, 6, 9))
    let batch = await ideas.refresh()
    ideas.dismiss(batch.cards[1]!.id)
    batch = await ideas.refresh()
    ideas.dismiss(batch.cards[1]!.id)
    expect(ideas.putAway()).toEqual({ work: 2 })
    expect(ideas.take(batch.cards[0]!.id)).toMatchObject({ say: '把第 2 天换成岚山小火车', done: true })
    await ideas.refresh()
    expect(prompts.at(-1)).toContain('work (put away 2 times this month)')
  })
})
