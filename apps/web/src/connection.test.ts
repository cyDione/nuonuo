import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Message } from './api'
import { pendingReplyPollInterval, upsertConversationMessage } from './live'

class FakeStorage implements Storage {
  private map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string) { return this.map.get(key) ?? null }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) { this.map.set(key, String(value)) }
}

/** Realistic async in-memory BroadcastChannel bus simulating multi-tab IPC delivery. */
class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>()
  onmessage: ((ev: MessageEvent) => void) | null = null
  closed = false

  constructor(readonly name: string) {
    let set = FakeBroadcastChannel.channels.get(name)
    if (!set) { set = new Set(); FakeBroadcastChannel.channels.set(name, set) }
    set.add(this)
  }

  postMessage(data: unknown) {
    if (this.closed) return
    const peers = FakeBroadcastChannel.channels.get(this.name)
    if (!peers) return
    const payload = structuredClone(data)
    for (const peer of peers) {
      if (peer === this || peer.closed) continue
      setTimeout(() => {
        if (!peer.closed) peer.onmessage?.({ data: structuredClone(payload) } as MessageEvent)
      }, 2)
    }
  }

  close() {
    this.closed = true
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }

  static reset() {
    for (const set of FakeBroadcastChannel.channels.values()) {
      for (const ch of set) ch.closed = true
    }
    FakeBroadcastChannel.channels.clear()
  }
}

/** Realistic FIFO async exclusive LockManager matching `navigator.locks.request`. */
function createFakeLocks() {
  const queues = new Map<string, Promise<unknown>>()
  return {
    request<T>(name: string, callback: () => Promise<T> | T): Promise<T> {
      const prev = queues.get(name) ?? Promise.resolve()
      const next = prev.catch(() => {}).then(() => callback())
      const tail = next.then(() => undefined, () => undefined)
      queues.set(name, tail)
      return next
    },
  }
}

/** Strict single-use rotating auth server mirroring `AuthService` replay detection & accessVersion bumps. */
function createStrictRotatingServer() {
  let activeRefresh = 'nnr_initial'
  const retiredRefreshes = new Set<string>()
  let accessVersion = 0
  let minValidAccessVersion = 1
  let revoked = false
  let refreshCalls = 0
  let replayRevocations = 0
  const messageStatuses: number[] = []

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    if (url.endsWith('/v1/auth/methods')) {
      return new Response(JSON.stringify({
        protocol: '2.0',
        server: { name: 'nuonuo', version: '0.3.12' },
        webUi: true,
        methods: { pairing: true, password: false, passkey: false },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (url.endsWith('/v1/auth/refresh')) {
      refreshCalls++
      // Capture the shared browser cookie as it existed when the request left the tab.
      const sentCookie = activeRefresh
      await new Promise(r => setTimeout(r, 15))
      if (revoked || retiredRefreshes.has(sentCookie) || sentCookie !== activeRefresh) {
        revoked = true
        replayRevocations++
        return new Response(JSON.stringify({ error: { code: 'token_reused', message: '检测到旧刷新令牌被重放' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      retiredRefreshes.add(sentCookie)
      accessVersion++
      minValidAccessVersion = accessVersion
      activeRefresh = `nnr_v${accessVersion}`
      const now = Date.now()
      return new Response(JSON.stringify({
        protocol: '2.0',
        accessToken: `nna_v${accessVersion}`,
        expiresIn: 900,
        expiresAt: now + 900_000,
        refreshToken: activeRefresh,
        refreshExpiresAt: now + 30 * 86_400_000,
        device: { id: 'dev_1', name: 'Web', kind: 'web', scopes: ['chat', 'admin'] },
        session: { id: 'asess_1', familyId: 'afam_1' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (url.endsWith('/v1/auth/logout')) {
      revoked = true
      return new Response(null, { status: 204 })
    }

    if (url.endsWith('/v1/messages')) {
      const authHeader = new Headers(init?.headers).get('authorization') ?? ''
      const expected = `Bearer nna_v${minValidAccessVersion}`
      const ok = !revoked && accessVersion >= minValidAccessVersion && authHeader === expected
      const status = ok ? 200 : 401
      messageStatuses.push(status)
      return new Response(JSON.stringify(ok ? { messages: [] } : { error: { code: 'unauthorized' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 })
  })

  return {
    fetchMock,
    expireCurrentAccessTokens() { minValidAccessVersion = accessVersion + 1 },
    stats: () => ({ refreshCalls, replayRevocations, accessVersion, revoked, messageStatuses: [...messageStatuses] }),
  }
}

type ConnectionModule = typeof import('./connection')

async function loadTabModule(): Promise<ConnectionModule> {
  vi.resetModules()
  return import('./connection')
}

describe('multi-tab auth sync & refresh serialization (connection.ts)', () => {
  const originalGlobals = {
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    BroadcastChannel: globalThis.BroadcastChannel,
    navigator: globalThis.navigator,
    fetch: globalThis.fetch,
  }

  let localStore: FakeStorage
  let server: ReturnType<typeof createStrictRotatingServer>

  beforeEach(() => {
    FakeBroadcastChannel.reset()
    localStore = new FakeStorage()
    server = createStrictRotatingServer()
    vi.stubGlobal('location', {
      protocol: 'http:',
      origin: 'http://localhost:5173',
      host: 'localhost:5173',
    })
    vi.stubGlobal('localStorage', localStore)
    vi.stubGlobal('sessionStorage', new FakeStorage())
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      locks: createFakeLocks(),
    })
    vi.stubGlobal('fetch', server.fetchMock)
  })

  afterEach(() => {
    FakeBroadcastChannel.reset()
    vi.unstubAllGlobals()
    // Restore original globals cleanly when running in node env.
    if (!originalGlobals.BroadcastChannel) delete (globalThis as Record<string, unknown>).BroadcastChannel
  })

  it('reuses a live peer tab access token on second tab boot without rotating refresh token or storing secrets in localStorage', async () => {
    const tabA = await loadTabModule()
    await tabA.bootstrapConnection()
    expect(tabA.getConnection().status).toBe('ready')
    expect(tabA.getConnection().accessToken).toBe('nna_v1')
    expect(server.stats().refreshCalls).toBe(1)

    // Opening Tab B while Tab A is already authenticated must adopt `nna_v1` via BroadcastChannel (0 extra /auth/refresh calls).
    const tabB = await loadTabModule()
    await tabB.bootstrapConnection()
    expect(tabB.getConnection().status).toBe('ready')
    expect(tabB.getConnection().accessToken).toBe('nna_v1')
    expect(server.stats().refreshCalls).toBe(1)

    // Both tabs succeed with zero 401 ping-pong.
    const [resA, resB] = await Promise.all([tabA.authedFetch('/messages'), tabB.authedFetch('/messages')])
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    expect(server.stats().refreshCalls).toBe(1)
    expect(server.stats().messageStatuses).toEqual([200, 200])

    // Security invariant: neither accessToken nor refreshToken is ever written to localStorage.
    for (let i = 0; i < localStore.length; i++) {
      const k = localStore.key(i)!
      const v = localStore.getItem(k) ?? ''
      expect(v).not.toContain('nna_v')
      expect(v).not.toContain('nnr_')
    }
  })

  it('serializes simultaneous 401 refreshes across two tabs into a single rotation with zero replay revocation', async () => {
    const tabA = await loadTabModule()
    await tabA.bootstrapConnection()
    const tabB = await loadTabModule()
    await tabB.bootstrapConnection()
    expect(server.stats().refreshCalls).toBe(1)

    // Simulate access token expiry across both tabs simultaneously (e.g. wake from sleep / TTL expiry).
    server.expireCurrentAccessTokens()

    const [resA, resB] = await Promise.all([tabA.authedFetch('/messages'), tabB.authedFetch('/messages')])
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    // Strictly ONE rotation occurred (v1 -> v2), zero replay revocations, both tabs hold `nna_v2`.
    expect(server.stats().refreshCalls).toBe(2)
    expect(server.stats().replayRevocations).toBe(0)
    expect(server.stats().revoked).toBe(false)
    expect(tabA.getConnection().accessToken).toBe('nna_v2')
    expect(tabB.getConnection().accessToken).toBe('nna_v2')
  })

  it('serializes simultaneous cold boots of two tabs into a single /v1/auth/refresh call', async () => {
    const tabA = await loadTabModule()
    const tabB = await loadTabModule()
    expect(tabA).not.toBe(tabB)
    await Promise.all([tabA.bootstrapConnection(), tabB.bootstrapConnection()])

    expect(tabA.getConnection().status).toBe('ready')
    expect(tabB.getConnection().status).toBe('ready')
    expect(tabA.getConnection().accessToken).toBe('nna_v1')
    expect(tabB.getConnection().accessToken).toBe('nna_v1')
    expect(server.stats().refreshCalls).toBe(1)
    expect(server.stats().replayRevocations).toBe(0)
  })

  it('propagates logout across tabs so peer tabs immediately clear in-memory tokens', async () => {
    const tabA = await loadTabModule()
    await tabA.bootstrapConnection()
    const tabB = await loadTabModule()
    await tabB.bootstrapConnection()
    expect(tabB.getConnection().status).toBe('ready')

    await tabA.disconnectCurrent(true)
    await new Promise(r => setTimeout(r, 20))

    expect(tabA.getConnection().status).toBe('unauthenticated')
    expect(tabB.getConnection().status).toBe('unauthenticated')
    expect(tabB.getConnection().accessToken).toBe('')
  })
})

describe('SSE instant message cache upsert (live.ts)', () => {
  const conv: Conversation = {
    id: 'cnv_1',
    title: '测试',
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    source: 'owner',
    origin: 'owner',
    threadId: null,
    meta: {},
  }
  const msg = (id: string, content: string): Message => ({
    id,
    conversationId: 'cnv_1',
    role: 'assistant',
    content,
    meta: {},
    ticketId: null,
    triggerId: null,
    createdAt: 100,
  })

  it('appends new SSE messages and updates existing ones in place without duplicating', () => {
    expect(upsertConversationMessage(undefined, msg('m1', 'hi'))).toBeUndefined()

    const initial = { conversation: conv, messages: [msg('m1', 'hello')] }
    const appended = upsertConversationMessage(initial, msg('m2', 'world'))!
    expect(appended.messages.map(m => `${m.id}:${m.content}`)).toEqual(['m1:hello', 'm2:world'])
    expect(initial.messages).toHaveLength(1)

    const updated = upsertConversationMessage(appended, msg('m2', 'world (edited)'))!
    expect(updated.messages.map(m => `${m.id}:${m.content}`)).toEqual(['m1:hello', 'm2:world (edited)'])
  })

  it('polls only while waiting for a reply and stops immediately once answered or idle', () => {
    const now = 1_700_000_050_000
    const userMsg = (createdAt: number): Message => ({ ...msg('u1', 'hi'), role: 'user', createdAt })
    const assistantMsg = (createdAt: number): Message => ({ ...msg('a1', 'hello'), role: 'assistant', createdAt })

    // Idle conversation (assistant already replied) -> zero polling.
    expect(pendingReplyPollInterval({
      messages: [userMsg(now - 5_000), assistantMsg(now - 2_000)],
      routerBusy: false,
      working: false,
      awaitingDelivery: false,
      connected: true,
      lastSentAt: now - 5_000,
      now,
    })).toBe(false)

    // User just sent a message and assistant has not replied yet -> gentle safety poll (faster if SSE disconnected).
    expect(pendingReplyPollInterval({
      messages: [userMsg(now - 3_000)],
      routerBusy: false,
      working: false,
      awaitingDelivery: false,
      connected: true,
      lastSentAt: now - 3_000,
      now,
    })).toBe(3_500)

    expect(pendingReplyPollInterval({
      messages: [userMsg(now - 3_000)],
      routerBusy: false,
      working: false,
      awaitingDelivery: false,
      connected: false,
      lastSentAt: now - 3_000,
      now,
    })).toBe(1_500)

    // Newly sent message before thread query hydrated (`messages: undefined`) still polls until settled.
    expect(pendingReplyPollInterval({
      messages: undefined,
      routerBusy: false,
      working: false,
      awaitingDelivery: false,
      connected: true,
      lastSentAt: now - 1_000,
      now,
    })).toBe(3_500)

    // Old unanswered message (> 2 min ago) -> zero idle polling.
    expect(pendingReplyPollInterval({
      messages: [userMsg(now - 180_000)],
      routerBusy: false,
      working: false,
      awaitingDelivery: false,
      connected: true,
      lastSentAt: 0,
      now,
    })).toBe(false)
  })
})
