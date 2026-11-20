/**
 * Security test suite for the unified v1 authentication kernel:
 * - One-time pairing codes & 10-failure lockout
 * - Short-lived Access Tokens & single-use Refresh Token rotation
 * - Refresh replay detection -> full token-family revocation + audit log
 * - Owner password scrypt hashing & sliding-window rate limiting
 * - WebAuthn Passkey origin security checks & challenge lifecycle
 * - Ephemeral single-path resource tickets
 * - Default-deny RBAC route scope enforcement
 */
import { Hono } from 'hono'
import { openStore } from '@nuonuo/db'
import { describe, expect, it } from 'vitest'
import { AuthError, AuthService, buildPairUri, FULL_ADMIN_SCOPES } from './auth-service'
import { clientIp, isTrustedCookieOrigin, REFRESH_COOKIE, v1Cors, type AuthEnv } from './auth'
import { mountAuthRoutes } from './auth-routes'
import { PasskeyService, resolveWebAuthnContext } from './passkey'
import { allowsResourceTicket, eventAllowedForScopes, requiredScopeFor } from './v1-rbac'

describe('AuthService security guarantees', () => {
  it('issues one-time pairing codes, exchanges for rotating tokens, and locks out after 10 failures', () => {
    const store = openStore(':memory:')
    try {
      const auth = new AuthService(store)
      const issued = auth.createPairingCode({ admin: true, name: 'My Mac' })
      expect(issued.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      expect(buildPairUri('https://nuonuo.example.com/', issued.code)).toBe(
        `nuonuo://pair?server=${encodeURIComponent('https://nuonuo.example.com')}&code=${encodeURIComponent(issued.code)}`,
      )

      const bundle = auth.exchangePairingCode(issued.code, { name: 'Ignored', kind: 'desktop' }, { ip: '127.0.0.1' })
      expect(bundle.accessToken).toMatch(/^nna_/)
      expect(bundle.refreshToken).toMatch(/^nnr_/)
      expect(bundle.device.name).toBe('My Mac')
      expect(bundle.device.scopes).toEqual(FULL_ADMIN_SCOPES)

      // Pairing code is strictly single-use.
      expect(() => auth.exchangePairingCode(issued.code, { name: 'Retry', kind: 'desktop' })).toThrow(/不对或已过期/)

      // 10 failures void all pending codes and return 429.
      const pending = auth.createPairingCode({ scopes: ['chat'] })
      for (let i = 0; i < 9; i++) {
        expect(() => auth.exchangePairingCode('ZZZZ-ZZZZ', { name: 'attacker' })).toThrow()
      }
      expect(() => auth.exchangePairingCode(pending.code, { name: 'victim' })).toThrow(/错误次数过多/)
    } finally {
      store.close()
    }
  })

  it('rotates refresh tokens and revokes the entire session family when an old refresh token is replayed', () => {
    const store = openStore(':memory:')
    try {
      const auth = new AuthService(store)
      const { code } = auth.createPairingCode({ admin: true })
      const initial = auth.exchangePairingCode(code, { name: 'Laptop', kind: 'desktop' })

      // Normal rotation succeeds; old access token becomes invalid immediately because accessVersion incremented.
      const rotated = auth.refresh(initial.refreshToken, { ip: '10.0.0.2' })
      expect(rotated.refreshToken).not.toBe(initial.refreshToken)
      expect(rotated.accessToken).not.toBe(initial.accessToken)
      expect(auth.authenticateAccessToken(initial.accessToken)).toBeUndefined()
      expect(auth.authenticateAccessToken(rotated.accessToken)?.deviceId).toBe(initial.device.id)

      // Attacker replays the already-rotated initial refresh token -> triggers family-wide revocation!
      expect(() => auth.refresh(initial.refreshToken, { ip: '203.0.113.9' })).toThrow(/重放/)

      // Both the newer access token and newer refresh token in that family are now dead.
      expect(auth.authenticateAccessToken(rotated.accessToken)).toBeUndefined()
      expect(() => auth.refresh(rotated.refreshToken)).toThrow(/重放|无效/)
      expect(auth.listAudit().some(a => a.event === 'replay_detected')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('enforces access token expiration and immediate device revocation', () => {
    const store = openStore(':memory:')
    let now = 1_700_000_000_000
    try {
      const auth = new AuthService(store, { now: () => now, accessTtlMs: 10_000 })
      const { code } = auth.createPairingCode({ scopes: ['chat'] })
      const b = auth.exchangePairingCode(code, { name: 'Phone', kind: 'phone' })
      expect(auth.authenticateAccessToken(b.accessToken)).toBeDefined()

      // Past expiry -> rejected.
      now += 11_000
      expect(auth.authenticateAccessToken(b.accessToken)).toBeUndefined()

      // Refresh yields a fresh valid access token.
      const b2 = auth.refresh(b.refreshToken)
      expect(auth.authenticateAccessToken(b2.accessToken)).toBeDefined()

      // Revoking the device immediately kills both access and refresh tokens.
      expect(auth.revokeDevice(b.device.id)).toBe(true)
      expect(auth.authenticateAccessToken(b2.accessToken)).toBeUndefined()
      expect(() => auth.refresh(b2.refreshToken)).toThrow()
    } finally {
      store.close()
    }
  })

  it('hashes owner passwords with scrypt, enforces minimum length, and rate-limits failed logins per IP', () => {
    const store = openStore(':memory:')
    try {
      const auth = new AuthService(store)
      expect(auth.hasPassword()).toBe(false)
      expect(() => auth.setPassword('short')).toThrow(/8 位/)
      auth.setPassword('correct-horse-battery-staple')
      expect(auth.hasPassword()).toBe(true)

      const ok = auth.loginWithPassword('correct-horse-battery-staple', { name: 'Browser', kind: 'web' }, { ip: '127.0.0.1' })
      expect(ok.device.scopes).toEqual(FULL_ADMIN_SCOPES)

      for (let i = 0; i < 8; i++) {
        expect(() => auth.loginWithPassword('wrong-pass', { name: 'Attacker', kind: 'web' }, { ip: '198.51.100.5' })).toThrow(/密码错误/)
      }
      expect(() => auth.loginWithPassword('correct-horse-battery-staple', { name: 'Attacker', kind: 'web' }, { ip: '198.51.100.5' })).toThrow(/错误次数过多/)

      auth.clearPassword()
      expect(auth.hasPassword()).toBe(false)
    } finally {
      store.close()
    }
  })

  it('validates single-path ephemeral resource tickets strictly by path, use count, and TTL', () => {
    const store = openStore(':memory:')
    let now = 1_700_000_000_000
    try {
      const auth = new AuthService(store, { now: () => now })
      const b = auth.issueDeviceSession({ name: 'Web', kind: 'web' }, ['chat'], {}, 'test')
      const principal = auth.authenticateAccessToken(b.accessToken)!
      const { ticket } = auth.createResourceTicket('/v1/uploads/upl_1', principal, 2)

      // Wrong path rejected (and does not consume ticket).
      expect(auth.verifyResourceTicket(ticket, '/v1/uploads/upl_2')).toBeUndefined()
      // Exact path succeeds twice, fails on third use.
      expect(auth.verifyResourceTicket(ticket, '/v1/uploads/upl_1')?.deviceId).toBe(b.device.id)
      expect(auth.verifyResourceTicket(ticket, '/v1/uploads/upl_1')?.deviceId).toBe(b.device.id)
      expect(auth.verifyResourceTicket(ticket, '/v1/uploads/upl_1')).toBeUndefined()

      // Expired ticket rejected.
      const { ticket: expiring } = auth.createResourceTicket('/v1/artifacts/art_1', principal, 2)
      now += 31_000
      expect(auth.verifyResourceTicket(expiring, '/v1/artifacts/art_1')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('enforces HTTPS / localhost origin requirements for WebAuthn Passkeys', async () => {
    expect(resolveWebAuthnContext('https://nuonuo.example.com', undefined)).toEqual({
      rpID: 'nuonuo.example.com',
      origin: 'https://nuonuo.example.com',
    })
    expect(resolveWebAuthnContext('http://localhost:5173', undefined)).toEqual({
      rpID: 'localhost',
      origin: 'http://localhost:5173',
    })
    expect(resolveWebAuthnContext('http://127.0.0.1:7420', undefined)).toEqual({
      rpID: 'localhost',
      origin: 'http://127.0.0.1:7420',
    })
    expect(() => resolveWebAuthnContext('http://192.168.1.50:7420', undefined)).toThrow(/HTTPS/)

    const store = openStore(':memory:')
    try {
      const auth = new AuthService(store)
      const passkeys = new PasskeyService(auth)
      const reg = await passkeys.beginRegistration({ rpID: 'localhost', origin: 'http://localhost:7420' })
      expect(reg.challengeId).toMatch(/^pkc_/)
      expect(reg.options.rp.id).toBe('localhost')
      await expect(passkeys.beginLogin({ rpID: 'localhost', origin: 'http://localhost:7420' })).rejects.toThrow(/尚未绑定/)
    } finally {
      store.close()
    }
  })
})

describe('v1 default-deny RBAC matrix', () => {
  it('maps narrow scopes explicitly and defaults every unknown or sensitive route to admin', () => {
    expect(requiredScopeFor('/hello', 'GET')).toBeNull()
    expect(requiredScopeFor('/events', 'GET')).toBeNull()
    expect(requiredScopeFor('/conversations/main/messages', 'POST')).toBe('chat')
    expect(requiredScopeFor('/uploads/upl_1', 'GET')).toBe('chat')
    expect(requiredScopeFor('/approvals', 'GET')).toBe('approvals')
    expect(requiredScopeFor('/tickets', 'GET')).toBe('tasks:read')
    expect(requiredScopeFor('/tickets/tkt_1/stop', 'POST')).toBe('tasks:write')
    expect(requiredScopeFor('/providers', 'GET')).toBe('admin')
    expect(requiredScopeFor('/settings/execution', 'PUT')).toBe('admin')
    expect(requiredScopeFor('/devices', 'GET')).toBe('admin')
    expect(requiredScopeFor('/some-future-unmapped-endpoint', 'POST')).toBe('admin')

    expect(allowsResourceTicket('/uploads/upl_1', 'GET')).toBe(true)
    expect(allowsResourceTicket('/uploads/upl_1', 'DELETE')).toBe(false)
    expect(allowsResourceTicket('/providers', 'GET')).toBe(false)

    expect(eventAllowedForScopes({ type: 'message.created', conversationId: 'c', messageId: 'm' }, ['chat'])).toBe(true)
    expect(eventAllowedForScopes({ type: 'settings.updated', keys: ['roles'] }, ['chat', 'tasks:read'])).toBe(false)
    expect(eventAllowedForScopes({ type: 'settings.updated', keys: ['roles'] }, ['admin'])).toBe(true)
  })
})

describe('CORS credential isolation & X-Forwarded-For anti-spoofing', () => {
  it('blocks cross-port localhost origins from redeeming nuonuo_refresh cookies or reading credentialed CORS', async () => {
    const store = openStore(':memory:')
    try {
      const auth = new AuthService(store)
      const passkeys = new PasskeyService(auth)
      const config = { home: '/tmp', host: '127.0.0.1', port: 7420, web: true, dev: false, devOrigins: ['http://localhost:5173'], sources: { host: 'default', port: 'default', web: 'flag' } as const }
      const app = new Hono()
      app.onError((err, c) => err instanceof AuthError ? c.json({ error: { code: err.code } }, err.status) : c.json({ error: { code: 'internal' } }, 500))
      const v1 = new Hono<AuthEnv>()
      v1.use('*', v1Cors(config))
      mountAuthRoutes(v1, { auth, passkeys, config, bus: { emit() {} } } as any, undefined, () => 7420)
      app.route('/v1', v1)

      const bundle = auth.issueDeviceSession({ name: 'Browser', kind: 'web' }, FULL_ADMIN_SCOPES, {}, 'test')

      // 1. Untrusted sibling port (http://127.0.0.1:3000) trying to ride SameSite cookie is rejected with 403 and no Allow-Credentials.
      const crossPort = await app.request('http://127.0.0.1:7420/v1/auth/refresh', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7420',
          origin: 'http://127.0.0.1:3000',
          cookie: `${REFRESH_COOKIE}=${bundle.refreshToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cookie: true }),
      })
      expect(crossPort.status).toBe(403)
      expect(crossPort.headers.get('access-control-allow-credentials')).toBeNull()

      // 2. External client (e.g. app://nuonuo) passing explicit refreshToken in JSON body succeeds with wildcard CORS (no credentials).
      const explicitBody = await app.request('http://127.0.0.1:7420/v1/auth/refresh', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7420',
          origin: 'app://nuonuo',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: bundle.refreshToken }),
      })
      expect(explicitBody.status).toBe(200)
      expect(explicitBody.headers.get('access-control-allow-origin')).toBe('*')
      expect(explicitBody.headers.get('access-control-allow-credentials')).toBeNull()
      const next = await explicitBody.json() as { refreshToken: string }

      // 3. Same-origin WebUI (http://127.0.0.1:7420) CAN use nuonuo_refresh cookie with Allow-Credentials.
      const sameOrigin = await app.request('http://127.0.0.1:7420/v1/auth/refresh', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7420',
          origin: 'http://127.0.0.1:7420',
          cookie: `${REFRESH_COOKIE}=${next.refreshToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cookie: true }),
      })
      expect(sameOrigin.status).toBe(200)
      expect(sameOrigin.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:7420')
      expect(sameOrigin.headers.get('access-control-allow-credentials')).toBe('true')
    } finally {
      store.close()
    }
  })

  it('ignores spoofed X-Forwarded-For headers from non-loopback TCP peers while honoring local reverse proxies', async () => {
    const app = new Hono()
    app.get('/ip', c => c.json({ ip: clientIp(c), trusted: isTrustedCookieOrigin(c) }))

    // Direct LAN peer trying to spoof X-Forwarded-For: must return real socket IP 192.168.1.99.
    const lanRes = await app.request('http://192.168.1.10:7420/ip', {
      headers: { 'x-forwarded-for': '8.8.8.8' },
    }, { incoming: { socket: { remoteAddress: '::ffff:192.168.1.99' } } })
    expect(await lanRes.json()).toEqual({ ip: '192.168.1.99', trusted: true })

    // Loopback reverse proxy (127.0.0.1) forwarding real client IP: honored.
    const proxyRes = await app.request('http://127.0.0.1:7420/ip', {
      headers: { 'x-forwarded-for': '203.0.113.5, 127.0.0.1' },
    }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } })
    expect(await proxyRes.json()).toEqual({ ip: '203.0.113.5', trusted: true })
  })
})
