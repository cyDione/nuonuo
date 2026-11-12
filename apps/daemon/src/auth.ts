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
import { isLoopback, type DaemonConfig } from './config'

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
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`])
  for (const origin of config.devOrigins) hosts.add(new URL(origin).host)
  return hosts
}

/**
 * On loopback only the loopback names are accepted (against DNS rebinding). Listening on the network, the service is
 * reached by whatever address or name the network gives it, so any Host is accepted; the token still guards every API
 * call, and a page from another origin is still refused.
 */
export function hostGuard(config: DaemonConfig): MiddlewareHandler {
  const hosts = allowedHosts(config)
  const origins = new Set([...hosts].map(h => `http://${h}`))
  const open = !isLoopback(config.host)
  return async (c, next) => {
    const host = c.req.header('host') ?? ''
    if (!open && !hosts.has(host)) return c.text('forbidden host', 403)
    const origin = c.req.header('origin')
    // The client protocol takes a device token in a header (never a cookie), so a page elsewhere cannot ride on it.
    if (c.req.path.startsWith('/client/')) return next()
    if (origin && !origins.has(origin) && !(open && (origin === `http://${host}` || origin === `https://${host}`))) return c.text('forbidden origin', 403)
    await next()
  }
}

/** The header the desktop app adds to its window's requests. */
export const DESKTOP_HEADER = 'x-nuonuo-client'

/**
 * The desktop app with browser access turned off: pages are only served to its window. Calls with the token in an
 * Authorization header (the CLI, the desktop app itself) and sources' OAuth callbacks (opened in the browser) still work.
 */
export function webGate(config: DaemonConfig): MiddlewareHandler {
  return async (c, next) => {
    if (config.web || c.req.header(DESKTOP_HEADER) === 'desktop' || c.req.header('authorization') || c.req.path.startsWith('/plugin/') || c.req.path.startsWith('/client/')) return next()
    return c.html('<!doctype html><meta charset="utf-8"><title>Nuonuo</title><body style="font:15px system-ui;margin:3rem auto;max-width:32rem;line-height:1.6"><h2>网页访问未开启</h2><p>Nuonuo 桌面版默认只在应用窗口里使用。要在浏览器（或局域网里的其他设备）打开，请在桌面应用的「设置 → 系统 → 网页访问」中开启。</p></body>', 403)
  }
}

export function requireToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const presented = bearer || getCookie(c, COOKIE) || ''
    if (!presented || !same(presented, token)) return c.json({ error: { code: 'unauthorized', message: '需要访问令牌：运行 nuonuo token 获取登录链接' } }, 401)
    await next()
  }
}
