/**
 * HTTP security middlewares for the decoupled v1 daemon:
 * - Local-machine-only CLI admin key (`<home>/local-admin.key`, mode 0600, strictly loopback TCP only)
 * - CORS support for external/desktop clients using Bearer tokens (plus same-origin credentials for --web)
 * - WebUI gate (disabled by default; enabled explicitly via `--web` / `NUONUO_WEB=1`)
 * - Bearer Access Token + Scope RBAC enforcement + optional ephemeral single-path resource ticket
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, MiddlewareHandler } from 'hono'
import { AuthError, FULL_ADMIN_SCOPES, hasScope, PROTOCOL_VERSION, safeEqual, type AuthPrincipal, type AuthService, type Scope } from './auth-service'
import { isLoopback, type DaemonConfig } from './config'

export const REFRESH_COOKIE = 'nuonuo_refresh'
export const LOCAL_ADMIN_HEADER = 'x-nuonuo-local-admin'

/** Machine-local key used ONLY by the local CLI (`nuonuo pair`, `nuonuo devices`, `nuonuo status`) over loopback. */
export function loadLocalAdminKey(home: string): string {
  const file = join(home, 'local-admin.key')
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
  }
  chmodSync(file, 0o600)
  return readFileSync(file, 'utf8').trim()
}

export function rotateLocalAdminKey(home: string): string {
  writeFileSync(join(home, 'local-admin.key'), randomBytes(32).toString('base64url'), { mode: 0o600 })
  return loadLocalAdminKey(home)
}

/**
 * Extracts peer IP from Node server incoming socket.
 * `X-Forwarded-For` is trusted ONLY when the immediate TCP peer is loopback (e.g., local Caddy/Nginx/Cloudflared)
 * or in socketless in-memory unit tests, preventing direct LAN/WAN clients from spoofing IPs to bypass rate limits.
 */
export function clientIp(c: Context): string {
  const raw = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
  const normalized = raw?.replace(/^::ffff:/, '')
  if (!normalized || isLoopback(normalized)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  return normalized || '127.0.0.1'
}

export function isLoopbackSocket(c: Context): boolean {
  const raw = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
  // In-memory Hono app.request() unit tests have no TCP socket; treat as loopback only when no x-forwarded-for is set.
  if (!raw) return !c.req.header('x-forwarded-for')
  const normalized = raw.replace(/^::ffff:/, '')
  return isLoopback(normalized)
}

/**
 * Checks whether `Origin` matches the server's own HTTP origin or configured Vite `devOrigins`.
 * Prevents cross-port `SameSite` origins (e.g. `http://127.0.0.1:3000` -> `http://127.0.0.1:7420`) from reading
 * or redeeming the `HttpOnly` `nuonuo_refresh` cookie.
 */
export function isTrustedCookieOrigin(c: Context, config?: Pick<DaemonConfig, 'devOrigins'>): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host')
  const selfOrigin = host
    ? `${proto || (c.req.url.startsWith('https://') ? 'https' : 'http')}://${host}`
    : new URL(c.req.url).origin
  if (origin === selfOrigin) return true
  return Boolean(config?.devOrigins?.includes(origin))
}

/**
 * Bearer CORS for `/v1/*`:
 * - Same-origin (`--web`) and explicit `devOrigins` get credentialed CORS so `HttpOnly` refresh cookies work.
 * - All external origins (`app://nuonuo`, hosted Web UIs, third-party apps) get `Access-Control-Allow-Origin: *`
 *   WITHOUT `Access-Control-Allow-Credentials`, preventing cross-port localhost cookie exfiltration while keeping
 *   `Authorization: Bearer` + JSON `{ refreshToken }` open to all clients.
 */
export function v1Cors(config?: Pick<DaemonConfig, 'devOrigins'>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const credentialed = Boolean(origin && isTrustedCookieOrigin(c, config))
    const headers: Record<string, string> = {
      'access-control-allow-origin': credentialed && origin ? origin : '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': `authorization, content-type, last-event-id, ${LOCAL_ADMIN_HEADER}, x-nuonuo-client`,
      'access-control-expose-headers': 'x-nuonuo-protocol',
      'access-control-max-age': '86400',
      ...(credentialed ? { 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}),
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204, headers)
    await next()
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v)
    c.res.headers.set('x-nuonuo-protocol', PROTOCOL_VERSION)
  }
}

/**
 * Headless-by-default gate: when `config.web` is false, blocks static WebUI HTML/assets while leaving `/v1/*` and
 * plugin public callbacks open.
 */
export function webUiGate(config: DaemonConfig): MiddlewareHandler {
  return async (c, next) => {
    const p = c.req.path
    if (config.web || p.startsWith('/v1/') || p === '/v1' || p.startsWith('/plugin/') || p.startsWith('/plugin-window/')) {
      return next()
    }
    return c.json(
      {
        error: {
          code: 'web_ui_disabled',
          message: '服务端 WebUI 未启用。使用 `nuonuo start --web`（或设置 NUONUO_WEB=1）开启，或直接通过桌面端/客户端连接 /v1 接口。',
        },
      },
      404,
    )
  }
}

export type AuthEnv = { Variables: { principal: AuthPrincipal } }

const LOCAL_PRINCIPAL: AuthPrincipal = {
  sessionId: 'local_cli',
  deviceId: 'local_cli',
  device: {
    id: 'local_cli',
    name: 'Local CLI',
    kind: 'cli',
    display: 'full',
    scopes: FULL_ADMIN_SCOPES,
    createdAt: 0,
    lastSeenAt: null,
    revokedAt: null,
  },
  scopes: FULL_ADMIN_SCOPES,
  isLocalAdmin: true,
}

/** Authenticates a request via Bearer Access Token, loopback local-admin key, or (opt-in) ephemeral resource ticket. */
export function authenticateRequest(
  c: Context,
  auth: AuthService,
  localAdminKey?: string,
  opts: { allowResourceTicket?: boolean } = {},
): AuthPrincipal | undefined {
  const localKey = c.req.header(LOCAL_ADMIN_HEADER)
  if (localKey && localAdminKey && isLoopbackSocket(c) && safeEqual(localKey, localAdminKey)) {
    return LOCAL_PRINCIPAL
  }
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? ''
  if (bearer) {
    return auth.authenticateAccessToken(bearer)
  }
  if (opts.allowResourceTicket && c.req.method === 'GET') {
    const ticket = c.req.query('ticket')
    if (ticket) return auth.verifyResourceTicket(ticket, c.req.path)
  }
  return undefined
}

export function requireAuth(
  auth: AuthService,
  localAdminKey?: string,
  opts: { scope?: Scope; allowResourceTicket?: boolean } = {},
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const principal = authenticateRequest(c, auth, localAdminKey, opts)
    if (!principal) {
      throw new AuthError(401, 'unauthorized', '未认证或令牌已过期，请刷新会话或重新登录')
    }
    if (opts.scope && !hasScope(principal.scopes, opts.scope)) {
      throw new AuthError(403, 'forbidden', `当前设备没有「${opts.scope}」权限`)
    }
    c.set('principal', principal)
    await next()
  }
}

export function assertScope(c: Context<AuthEnv>, scope: Scope): void {
  const principal = c.get('principal')
  if (!principal || !hasScope(principal.scopes, scope)) {
    throw new AuthError(403, 'forbidden', `当前设备没有「${scope}」权限`)
  }
}
