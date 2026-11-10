import { Bus } from '@super-assistant/agent-runtime'
import { Feed, type Ideas, type Reviewer } from '@super-assistant/core'
import { newId, openStore, schema, type Store } from '@super-assistant/db'
import { afterEach, describe, expect, it } from 'vitest'
import { clearChats, exportAll, privacySettings, pruneChats, savePrivacySettings } from './data'
import { allowed, DEFAULT_NOTIFY, isQuiet, type Notice, Notices, saveNotifySettings } from './notices'

let store: Store
afterEach(() => store?.close())

const at = (h: number, m = 0) => new Date(2026, 10, 10, h, m)

describe('notification settings', () => {
  it('quiet hours run over midnight, and only what waits for an OK gets through them', () => {
    const q = { on: true, from: '23:00', to: '08:00' }
    expect(isQuiet(q, at(23, 30))).toBe(true)
    expect(isQuiet(q, at(7, 59))).toBe(true)
    expect(isQuiet(q, at(8))).toBe(false)
    expect(isQuiet({ ...q, from: '13:00', to: '14:00' }, at(13, 30))).toBe(true)
    expect(isQuiet({ ...q, on: false }, at(23, 30))).toBe(false)
    const s = { ...DEFAULT_NOTIFY, quiet: q }
    expect(allowed(s, 'feed', at(2))).toBe(false)
    expect(allowed(s, 'approval', at(2))).toBe(true)
    expect(allowed({ ...DEFAULT_NOTIFY, feed: false }, 'feed', at(12))).toBe(false)
    expect(allowed({ ...DEFAULT_NOTIFY, banner: false }, 'message', at(12))).toBe(false)
    expect(allowed({ ...DEFAULT_NOTIFY, banner: false }, 'approval', at(12))).toBe(true)
  })

  it('turns new 动态 into notices by kind, once, and leaves out what is switched off', () => {
    store = openStore(':memory:')
    const bus = new Bus()
    const sent: Notice[] = []
    bus.on(e => { if (e.type === 'notice') sent.push(e as unknown as Notice) })
    let now = at(12).getTime()
    const feed = new Feed(store, () => now, () => bus.emit({ type: 'feed.updated' }))
    const ideas = { batch: () => null } as unknown as Ideas
    const reviewer = { pending: () => [] } as unknown as Reviewer
    new Notices(store, bus, { feed, ideas, reviewer, ticketConversation: () => null }, () => now).register()
    now += 1_000
    feed.post({ title: '机票便宜了 ¥180', card: { value: 1999, was: 2179, unit: '¥' } })
    expect(sent.map(n => [n.kind, n.title, n.hash])).toEqual([['price', '机票便宜了 ¥180', '/activity']])
    saveNotifySettings(store, { feed: false })
    now += 1_000
    feed.post({ title: 'issue 有新回复' })
    expect(sent).toHaveLength(1)
    bus.emit({ type: 'feed.updated' })
    expect(sent).toHaveLength(1)
  })
})

describe('data and privacy', () => {
  const chat = (id: string, createdAt: number, source = 'webchat') => {
    store.db.insert(schema.conversations).values({ id, title: id, source, createdAt, updatedAt: createdAt }).run()
    store.db.insert(schema.messages).values({ id: newId('msg'), conversationId: id, role: 'user', content: `hi ${id}`, createdAt }).run()
  }

  it('prunes chats past the kept period, keeping the main chat and chats with open work', () => {
    store = openStore(':memory:')
    const now = Date.now(), old = now - 100 * 86_400_000
    chat('main', old); chat('side-old', old); chat('side-busy', old); chat('side-new', now)
    expect(pruneChats(store, 'main', () => false, now)).toBe(0)
    savePrivacySettings(store, { keep: '90' })
    expect(privacySettings(store).keep).toBe('90')
    expect(pruneChats(store, 'main', id => id === 'side-busy', now)).toBe(3)
    const left = (store.sqlite.prepare('SELECT id FROM conversations ORDER BY id').all() as { id: string }[]).map(r => r.id)
    expect(left).toEqual(['main', 'side-busy', 'side-new'])
  })

  it('exports rows without embeddings, and clearing chats empties the main chat and drops side chats only', () => {
    store = openStore(':memory:')
    chat('main', 1); chat('side', 2); chat('gh', 3, 'github')
    const out = exportAll(store, { app: 'x' }) as { messages: unknown[]; conversations: unknown[]; app: string }
    expect(out.app).toBe('x')
    expect(out.messages).toHaveLength(3)
    expect(clearChats(store, ['main'])).toBe(3)
    const left = (store.sqlite.prepare('SELECT id FROM conversations ORDER BY id').all() as { id: string }[]).map(r => r.id)
    expect(left).toEqual(['gh', 'main'])
  })
})
