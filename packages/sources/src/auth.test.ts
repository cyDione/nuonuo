import { describe, expect, it } from 'vitest'
import { appToken, oauth } from './auth.mjs'
import type { SourceContext } from './kind'

function ctx(config: Record<string, unknown> = {}) {
  const secrets = new Map<string, string>()
  const state = new Map<string, unknown>()
  const facts: Record<string, string>[] = []
  return {
    id: 'svc', config, facts: (f: Record<string, string>) => { facts.push(f) },
    secret: { get: (n: string) => secrets.get(n), set: (n: string, v: string) => { secrets.set(n, v) }, delete: (n: string) => { secrets.delete(n) } },
    state: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => { state.set(k, v) } },
    secrets, seen: facts,
  } as unknown as SourceContext<any> & { secrets: Map<string, string>; seen: Record<string, string>[] }
}

describe('appToken', () => {
  it('fetches once for concurrent callers and caches until near expiry', async () => {
    let calls = 0
    const get = appToken(async () => { calls++; await new Promise(r => setTimeout(r, 5)); return { token: `t${calls}`, expiresIn: 7200 } })
    expect(await Promise.all([get(), get(), get()])).toEqual(['t1', 't1', 't1'])
    expect(await get()).toBe('t1')
    get.reset()
    expect(await get()).toBe('t2')
  })
})

describe('oauth code flow', () => {
  const requests: { url: string; body: URLSearchParams }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body))
    requests.push({ url, body })
    if (url.endsWith('/revoke')) return new Response('')
    if (body.get('grant_type') === 'authorization_code') return Response.json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 })
    if (body.get('grant_type') === 'refresh_token') return Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
    return Response.json({ error: 'bad' }, { status: 400 })
  }) as unknown as typeof fetch
  const auth = oauth<any>({ flow: 'code', label: 'Svc', fetch: fetchImpl, clientId: 'cid', authorizeUrl: 'https://svc/auth', tokenUrl: 'https://svc/token',
    revokeUrl: 'https://svc/revoke', scopes: ['read', 'write'], onGrant: () => ({ 账号: 'me' }) })
  const kind = auth.source({ id: 'svc', title: 'Svc', description: '', schema: {} as any, fields: [], start() {} })

  it('adds the buttons, sends PKCE, exchanges the code and refreshes with rotation', async () => {
    const c = ctx()
    expect(kind.actions!.map(a => a.id)).toEqual(['authorize', 'reauthorize', 'disconnect'])
    expect(kind.authorized!(c)).toBe(false)
    await expect(auth.accessToken(c)).rejects.toMatchObject({ status: 401 })
    const start = await (await kind.http!(c, new Request('http://x/'), 'oauth/start', { public: false, origin: 'http://127.0.0.1:7420' }))!.json() as { url: string }
    const url = new URL(start.url)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('read write')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:7420/plugin/svc/oauth/callback')
    const back = await kind.http!(c, new Request(`http://x/cb?code=c1&state=${url.searchParams.get('state')}`), 'oauth/callback', { public: true, origin: 'http://127.0.0.1:7420' })
    expect(back!.status).toBe(302)
    expect(requests.at(-1)!.body.get('code_verifier')).toBeTruthy()
    expect(c.secrets.get('refresh_token')).toBe('r1')
    expect(c.seen).toEqual([{ 账号: 'me' }])
    expect(await auth.accessToken(c)).toBe('a1')
    expect(kind.authorized!(c)).toBe(true)
  })

  it('refuses a callback with a wrong state, and revokes on disconnect', async () => {
    const c = ctx()
    c.secrets.set('refresh_token', 'old')
    expect(await auth.accessToken(c)).toBe('a2')
    expect(c.secrets.get('refresh_token')).toBe('r2')
    const bad = await kind.http!(c, new Request('http://x/cb?code=c&state=nope'), 'oauth/callback', { public: true, origin: 'o' })
    expect(bad!.status).toBe(400)
    await kind.http!(c, new Request('http://x/'), 'oauth/disconnect', { public: false, origin: 'o' })
    expect(requests.at(-1)).toMatchObject({ url: 'https://svc/revoke' })
    expect(c.secrets.size).toBe(0)
  })
})
