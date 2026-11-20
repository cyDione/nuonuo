/**
 * Unified `/v1/auth/*`, `/v1/devices/*`, and `/v1/sessions/*` HTTP endpoints:
 * - Discovery (`GET /v1/auth/methods`)
 * - One-time pairing codes & QR payloads (`POST /v1/auth/pair/codes`, `POST /v1/auth/pair/exchange`)
 * - Owner password login & management (`POST /v1/auth/password/login`, `POST/DELETE /v1/auth/password`)
 * - WebAuthn Passkey registration & login (`POST /v1/auth/passkey/*`, `GET/DELETE /v1/auth/passkeys`)
 * - Rotating refresh token exchange (`POST /v1/auth/refresh`, supports body or HttpOnly cookie) & logout
 * - Short-lived single-path resource ticket (`POST /v1/auth/resource-ticket`)
 * - Device, session & auth audit administration
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import QRCode from 'qrcode'
import { z } from 'zod'
import { clientIp, isTrustedCookieOrigin, REFRESH_COOKIE, requireAuth, type AuthEnv } from './auth'
import {
  AuthError,
  buildPairUri,
  DEVICE_KINDS,
  DISPLAYS,
  PROTOCOL_VERSION,
  SCOPES,
  type AuthTokenBundle,
} from './auth-service'
import { connectHost, isLoopback, networkUrls, VERSION } from './config'
import { resolveWebAuthnContext } from './passkey'
import type { Runtime } from './runtime'

const DeviceInfoSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(DEVICE_KINDS).default('other'),
  platform: z.string().trim().max(60).optional(),
  display: z.enum(DISPLAYS).optional(),
})

const PairCodeCreateSchema = z.object({
  scopes: z.array(z.enum(SCOPES)).optional(),
  admin: z.boolean().optional(),
  name: z.string().trim().min(1).max(60).optional(),
  serverUrl: z.string().url().optional(),
}).optional().default({})

const PairExchangeSchema = z.object({
  code: z.string().trim().min(4).max(32),
  device: DeviceInfoSchema,
  cookie: z.boolean().optional(),
})

const PasswordLoginSchema = z.object({
  password: z.string().min(1).max(256),
  device: DeviceInfoSchema.default({ name: 'Web 浏览器', kind: 'web' }),
  cookie: z.boolean().optional(),
})

const PasswordSetSchema = z.object({
  password: z.string().min(8).max(256),
  currentPassword: z.string().max(256).optional(),
})

const RefreshSchema = z.object({
  refreshToken: z.string().min(1).max(512).optional(),
  cookie: z.boolean().optional(),
}).optional().default({})

const PasskeyFinishRegSchema = z.object({
  challengeId: z.string().min(1),
  response: z.any(),
  name: z.string().trim().min(1).max(60).default('Passkey'),
})

const PasskeyFinishLoginSchema = z.object({
  challengeId: z.string().min(1),
  response: z.any(),
  device: DeviceInfoSchema.default({ name: 'Web 浏览器', kind: 'web' }),
  cookie: z.boolean().optional(),
})

const ResourceTicketSchema = z.object({
  path: z.string().trim().min(1).max(500),
  maxUses: z.number().int().min(1).max(10).optional(),
})

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => undefined)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new AuthError(400, 'invalid', parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  }
  return parsed.data
}

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (proto) return proto === 'https'
  return c.req.url.startsWith('https://')
}

function maybeSetRefreshCookie(c: Context, bundle: AuthTokenBundle, useCookie?: boolean): void {
  if (!useCookie) return
  setCookie(c, REFRESH_COOKIE, bundle.refreshToken, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: isSecureRequest(c),
    path: '/v1/auth',
    maxAge: Math.floor((bundle.refreshExpiresAt - Date.now()) / 1000),
  })
}

function requestMeta(c: Context) {
  return { ip: clientIp(c), userAgent: c.req.header('user-agent') }
}

export function mountAuthRoutes(v1: Hono<AuthEnv>, rt: Runtime, localAdminKey: string | undefined, getPort: () => number): void {
  const auth = rt.auth
  const passkeys = rt.passkeys

  // ── Public auth discovery & credential exchanges ──────────────────────────

  v1.get('/auth/methods', c => {
    const origin = c.req.header('origin')
    const host = c.req.header('host')
    let passkeySupportedOnOrigin = false
    try {
      resolveWebAuthnContext(origin, host)
      passkeySupportedOnOrigin = true
    } catch {
      passkeySupportedOnOrigin = false
    }
    return c.json({
      protocol: PROTOCOL_VERSION,
      server: { name: 'nuonuo', version: VERSION },
      webUi: rt.config.web,
      methods: {
        pairing: true,
        password: auth.hasPassword(),
        passkey: passkeys.hasPasskeys() && passkeySupportedOnOrigin,
        passkeyConfigured: passkeys.hasPasskeys(),
      },
    })
  })

  v1.post('/auth/pair/exchange', async c => {
    const input = await parseJson(c, PairExchangeSchema)
    const bundle = auth.exchangePairingCode(input.code, input.device, requestMeta(c))
    maybeSetRefreshCookie(c, bundle, input.cookie)
    rt.bus.emit({ type: 'activity.updated' })
    return c.json({ ...bundle, protocol: PROTOCOL_VERSION }, 201)
  })

  v1.post('/auth/password/login', async c => {
    const input = await parseJson(c, PasswordLoginSchema)
    const bundle = auth.loginWithPassword(input.password, input.device, requestMeta(c))
    maybeSetRefreshCookie(c, bundle, input.cookie)
    rt.bus.emit({ type: 'activity.updated' })
    return c.json({ ...bundle, protocol: PROTOCOL_VERSION })
  })

  v1.post('/auth/passkey/login/options', async c => {
    const ctx = resolveWebAuthnContext(c.req.header('origin'), c.req.header('host'))
    const result = await passkeys.beginLogin(ctx)
    return c.json(result)
  })

  v1.post('/auth/passkey/login/verify', async c => {
    const input = await parseJson(c, PasskeyFinishLoginSchema)
    const bundle = await passkeys.finishLogin(input.challengeId, input.response, input.device, requestMeta(c))
    maybeSetRefreshCookie(c, bundle, input.cookie)
    rt.bus.emit({ type: 'activity.updated' })
    return c.json({ ...bundle, protocol: PROTOCOL_VERSION })
  })

  v1.post('/auth/refresh', async c => {
    const input = await parseJson(c, RefreshSchema)
    const trustedOrigin = isTrustedCookieOrigin(c, rt.config)
    const cookieToken = getCookie(c, REFRESH_COOKIE)
    if (!input.refreshToken && cookieToken && !trustedOrigin) {
      throw new AuthError(403, 'origin_mismatch', '跨源请求不允许使用 Cookie 刷新会话，请在请求体传递 refreshToken')
    }
    const token = input.refreshToken || (trustedOrigin ? cookieToken : undefined) || ''
    if (!token) throw new AuthError(401, 'invalid_refresh', '缺少刷新令牌')
    const bundle = auth.refresh(token, requestMeta(c))
    maybeSetRefreshCookie(c, bundle, trustedOrigin && (input.cookie ?? Boolean(cookieToken && !input.refreshToken)))
    return c.json({ ...bundle, protocol: PROTOCOL_VERSION })
  })

  // ── Authenticated session self-service ────────────────────────────────────

  v1.post('/auth/logout', requireAuth(auth, localAdminKey), c => {
    const principal = c.get('principal')
    if (!principal.isLocalAdmin) {
      auth.revokeSession(principal.sessionId, 'user_logout', { deviceId: principal.deviceId, ip: clientIp(c) })
    }
    deleteCookie(c, REFRESH_COOKIE, { path: '/v1/auth' })
    return c.body(null, 204)
  })

  v1.post('/auth/resource-ticket', requireAuth(auth, localAdminKey), async c => {
    const input = await parseJson(c, ResourceTicketSchema)
    const normalized = input.path.startsWith('/') ? input.path : `/${input.path}`
    const allowedPrefixes = ['/v1/uploads/', '/v1/artifacts/', '/v1/browser/', '/v1/browsers/screenshot', '/v1/computers/']
    if (!allowedPrefixes.some(p => normalized.startsWith(p))) {
      throw new AuthError(400, 'invalid', '该路径不支持临时资源票据')
    }
    const principal = c.get('principal')
    const issued = auth.createResourceTicket(normalized, principal, input.maxUses ?? 4)
    return c.json(issued, 201)
  })

  // ── Admin auth management (pairing codes, password, passkeys, devices, sessions, audit) ──

  const adminOnly = requireAuth(auth, localAdminKey, { scope: 'admin' })

  const createPairHandler = async (c: Context<AuthEnv>) => {
    const input = await parseJson(c, PairCodeCreateSchema)
    const issued = auth.createPairingCode({
      ...(input.scopes ? { scopes: input.scopes } : {}),
      ...(input.admin !== undefined ? { admin: input.admin } : {}),
      ...(input.name ? { name: input.name } : {}),
    })
    const port = getPort()
    const localUrl = `http://${connectHost(rt.config.host)}:${port}`
    const lanUrls = networkUrls(rt.config.host, port)
    const preferredUrl = input.serverUrl || lanUrls[0] || localUrl
    const uri = buildPairUri(preferredUrl, issued.code)
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 220 })
    return c.json({
      ...issued,
      uri,
      qrSvg,
      urls: [localUrl, ...lanUrls],
      base: '/v1',
      reachable: !isLoopback(rt.config.host),
    }, 201)
  }

  v1.post('/auth/pair/codes', adminOnly, createPairHandler)
  v1.post('/devices/pair', adminOnly, createPairHandler)

  v1.get('/auth/status', adminOnly, c => c.json({
    hasPassword: auth.hasPassword(),
    passkeyCount: passkeys.list().length,
    activeDevices: auth.listDevices().length,
    activeSessions: auth.listSessions().length,
  }))

  v1.post('/auth/password', adminOnly, async c => {
    const input = await parseJson(c, PasswordSetSchema)
    const principal = c.get('principal')
    if (auth.hasPassword() && !principal.isLocalAdmin) {
      if (!input.currentPassword || !auth.verifyPassword(input.currentPassword)) {
        throw new AuthError(401, 'invalid_credentials', '当前密码不正确')
      }
    }
    auth.setPassword(input.password, { deviceId: principal.deviceId, ip: clientIp(c) })
    return c.json({ ok: true, hasPassword: true })
  })

  v1.delete('/auth/password', adminOnly, c => {
    const principal = c.get('principal')
    auth.clearPassword({ deviceId: principal.deviceId, ip: clientIp(c) })
    return c.json({ ok: true, hasPassword: false })
  })

  v1.get('/auth/passkeys', adminOnly, c => c.json({ passkeys: passkeys.list() }))

  v1.post('/auth/passkey/register/options', adminOnly, async c => {
    const ctx = resolveWebAuthnContext(c.req.header('origin'), c.req.header('host'))
    return c.json(await passkeys.beginRegistration(ctx))
  })

  v1.post('/auth/passkey/register/verify', adminOnly, async c => {
    const input = await parseJson(c, PasskeyFinishRegSchema)
    const principal = c.get('principal')
    const created = await passkeys.finishRegistration(input.challengeId, input.response, input.name, { deviceId: principal.deviceId, ip: clientIp(c) })
    return c.json({ passkey: created }, 201)
  })

  v1.delete('/auth/passkeys/:id', adminOnly, c => {
    const principal = c.get('principal')
    if (!passkeys.remove(c.req.param('id'), { deviceId: principal.deviceId, ip: clientIp(c) })) {
      throw new AuthError(404, 'missing', '没有这个 Passkey')
    }
    return c.body(null, 204)
  })

  v1.get('/auth/audit', adminOnly, c => c.json({ entries: auth.listAudit(Number(c.req.query('limit')) || 100) }))

  v1.get('/devices', adminOnly, c => c.json({ devices: auth.listDevices(c.req.query('all') === '1') }))

  v1.patch('/devices/:id', adminOnly, async c => {
    const patch = await parseJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        scopes: z.array(z.enum(SCOPES)).optional(),
        display: z.enum(DISPLAYS).optional(),
      }).strict(),
    )
    return c.json({ device: auth.updateDevice(c.req.param('id'), patch) })
  })

  v1.delete('/devices/:id', adminOnly, c => {
    const principal = c.get('principal')
    if (!auth.revokeDevice(c.req.param('id'), { deviceId: principal.deviceId, ip: clientIp(c) })) {
      throw new AuthError(404, 'missing', '没有这个设备')
    }
    rt.bus.emit({ type: 'activity.updated' })
    return c.body(null, 204)
  })

  v1.get('/sessions', adminOnly, c => c.json({ sessions: auth.listSessions(c.req.query('all') === '1') }))

  v1.delete('/sessions/:id', adminOnly, c => {
    const principal = c.get('principal')
    if (!auth.revokeSession(c.req.param('id'), 'admin_revoked', { deviceId: principal.deviceId, ip: clientIp(c) })) {
      throw new AuthError(404, 'missing', '没有这个会话')
    }
    return c.body(null, 204)
  })
}
