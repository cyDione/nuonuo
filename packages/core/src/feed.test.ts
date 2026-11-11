import { openStore, type Store } from '@nuonuo/db'
import { afterEach, describe, expect, it } from 'vitest'
import { Feed, feedExtension } from './feed'

let store: Store
afterEach(() => store?.close())

describe('Feed', () => {
  it('keeps what changed for two weeks, newest first, until the owner puts it away', () => {
    store = openStore(':memory:')
    let t = Date.UTC(2026, 10, 1), changes = 0
    const feed = new Feed(store, () => t, () => changes++)
    const old = feed.post({ title: '路由器有新固件', icon: 'wifi' })
    t += 15 * 86_400_000
    const price = feed.post({ title: 'XM6 降到 ¥1,999', icon: 'tag', card: { value: 1999, was: 2299, unit: '¥', series: [2299, 2199, 1999] }, action: { label: '去下单', say: '下单 XM6' } })
    t += 1000
    const reply = feed.post({ title: 'Lin 回了你的周报', text: '「挺好，周五见」', icon: 'mail' })
    expect(feed.list().map(i => i.id)).toEqual([reply.id, price.id])
    expect(feed.list().map(i => i.id)).not.toContain(old.id)
    expect(feed.get(price.id).card).toMatchObject({ value: 1999, was: 2299 })
    expect(feed.unseen()).toBe(2)
    feed.seeAll()
    expect(feed.unseen()).toBe(0)
    feed.dismiss(price.id)
    expect(feed.list().map(i => i.id)).toEqual([reply.id])
    expect(changes).toBe(5)
  })

  it('gives every agent post_update', async () => {
    store = openStore(':memory:')
    const feed = new Feed(store)
    const ext = feedExtension(feed)
    const tools = ext.workerTools!({ id: 'tkt_1' } as never, {} as never)
    await (tools.post_update as any).execute({ title: '去京都的机票便宜了 ¥180', icon: 'plane' }, {})
    expect(feed.list()[0]).toMatchObject({ title: '去京都的机票便宜了 ¥180', ticketId: 'tkt_1' })
    expect(Object.keys(ext.routerTools!())).toEqual(['post_update'])
  })
})
