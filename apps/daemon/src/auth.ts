/**
 * Local-only access control. A daemon on 127.0.0.1 is still reachable by any web page the person visits, so every API call
 * needs the token from `<home>/token`, the Host header must name loopback (against DNS rebinding), and a cross-origin
 * Origin is refused (against CSRF).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { DaemonConfig } from './config'

export const COOKIE = 'sa_token'

export function loadToken(home: string): string {
  const file = join(home, 'token')
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString('base64url'), { mode: 0o600 })
  chmodSync(file, 0o600)
  return readFileSync(file, 'utf8').trim()
}

export function rotateToken(home: string): string {
  writeFileSync(join(home, 'token'), randomBytes(24).toString('base64url'), { mode: 0o600 })
  return loadToken(home)
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function allowedHosts(config: DaemonConfig): Set<string> {
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`])
  for (const origin of config.devOrigins) hosts.add(new URL(origin).host)
  return hosts
}

export function hostGuard(config: DaemonConfig): MiddlewareHandler {
  const hosts = allowedHosts(config)
  const origins = new Set([...hosts].map(h => `http://${h}`))
  return async (c, next) => {
    const host = c.req.header('host') ?? ''
    if (!hosts.has(host)) return c.text('forbidden host', 403)
    const origin = c.req.header('origin')
    if (origin && !origins.has(origin)) return c.text('forbidden origin', 403)
    await next()
  }
}

export function requireToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const presented = bearer || getCookie(c, COOKIE) || ''
    if (!presented || !same(presented, token)) return c.json({ error: { code: 'unauthorized', message: '需要访问令牌：运行 superagent token 获取登录链接' } }, 401)
    await next()
  }
}
