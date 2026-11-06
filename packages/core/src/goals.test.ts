import { openStore, type Store } from '@super-assistant/db'
import { afterEach, describe, expect, it } from 'vitest'
import { Goals, goalsExtension } from './goals'

let store: Store
afterEach(() => store?.close())

describe('Goals', () => {
  it('tracks progress from what the assistant logs, and finishes at the target', () => {
    store = openStore(':memory:')
    let changes = 0
    const goals = new Goals(store, Date.now, () => changes++)
    const camera = goals.create({ title: '攒钱买相机', icon: 'wallet', unit: '元', current: 6100, target: 12000 })
    goals.log(camera.id, '把 ¥300 自动记进相机基金', 300)
    expect(goals.get(camera.id).current).toBe(6400)
    const books = goals.create({ title: '每月读两本书', icon: 'book', unit: '本', target: 2 })
    goals.log(books.id, '读完《置身事内》', 1)
    goals.log(books.id, '读完《枪炮、病菌与钢铁》', 1)
    expect(goals.get(books.id).status).toBe('done')
    expect(goals.list().map(g => g.title)).toEqual(['攒钱买相机'])
    expect(goals.week().map(e => e.goal)).toContain('攒钱买相机')
    expect(changes).toBeGreaterThanOrEqual(5)
  })

  it('keeps only one goal pinned', () => {
    store = openStore(':memory:')
    const goals = new Goals(store)
    const a = goals.create({ title: '睡得更早', style: 'days', target: 21 })
    const b = goals.create({ title: '每周跑三次', icon: 'run', style: 'days', target: 12 })
    goals.update(a.id, { pinned: true })
    goals.update(b.id, { pinned: true })
    expect(goals.list().filter(g => g.pinned).map(g => g.id)).toEqual([b.id])
    expect(goals.get(a.id).unit).toBe('天')
  })

  it('gives the main agent tools to set and log goals, and lists them in its prompt', async () => {
    store = openStore(':memory:')
    const goals = new Goals(store)
    const ext = goalsExtension(goals)
    const tools = ext.routerTools!() as Record<string, { execute: (input: any, opts: any) => Promise<any> }>
    const { goal } = await tools.set_goal!.execute({ title: '睡得更早', icon: 'moon', style: 'days', target: 21 }, {})
    await tools.log_goal!.execute({ goal_id: goal.id, text: '23:00 提醒你放下手机', delta: 1 }, {})
    expect(ext.routerPrompt!()).toContain('睡得更早')
    expect(ext.routerPrompt!()).toContain('第 1 / 21 天')
  })
})
