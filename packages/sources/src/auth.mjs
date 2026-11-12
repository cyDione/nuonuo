// Shared authorization for sources: one implementation of the OAuth flows and app-token caching that every source
// (built-in or third-party) declares instead of writing its own. Plain JavaScript, like channel.mjs, so the plugin
// sandbox can hand it to third-party plugins as `sdk.oauth` / `sdk.appToken`. Types: auth.d.mts. Guide: docs/04-plugin-sdk.md.
import { createHash, randomBytes } from 'node:crypto'

/**
 * Caches an app (tenant) access token until shortly before it expires, and lets concurrent callers share one fetch.
 * `fetchToken` returns `{ token, expiresIn }` (seconds). `reset()` drops the cached token (after a 401).
 */
export function appToken(fetchToken, { marginSeconds = 300 } = {}) {
  let cached
  let inflight
  const get = async () => {
    if (cached && cached.until > Date.now()) return cached.value
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const { token, expiresIn } = await fetchToken()
        cached = { value: token, until: Date.now() + Math.max(60, (Number(expiresIn) || 7200) - marginSeconds) * 1000 }
        return token
      } finally { inflight = undefined }
    })()
    return inflight
  }
  get.reset = () => { cached = undefined }
  return get
}

const form = params => new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')))
const pick = (v, ctx) => (typeof v === 'function' ? v(ctx.config, ctx) : v)
const authError = message => Object.assign(new Error(message), { status: 401 })

/**
 * Declarative OAuth for a source. `spec.flow` is 'code' (authorization code with PKCE, redirect back to
 * /plugin/<id>/oauth/callback) or 'device' (a code the owner types on the provider's page; no callback needed).
 * Returns `{ source(kind), accessToken(ctx), disconnect(ctx) }`: `source` adds the 授权 / 重新授权 / 断开授权 buttons,
 * `authorized`, and the oauth/* endpoints to the kind; `accessToken` gives a valid token, refreshing it when needed.
 *
 * Storage: a refresh token, when the provider gives one, goes to the source's secret `refresh_token` and access tokens
 * stay in memory; otherwise the access token itself is kept as the secret `token`.
 */
export function oauth(spec) {
  const label = spec.label
  const flow = spec.flow
  const scope = ctx => { const s = pick(spec.scopes, ctx) ?? []; return Array.isArray(s) ? s.join(spec.scopeSeparator ?? ' ') : String(s) }
  const client = ctx => ({ id: pick(spec.clientId, ctx) || '', secret: pick(spec.clientSecret, ctx) || undefined })
  const f = spec.fetch ?? ((...args) => fetch(...args))
  /** Access tokens by refresh token, so a new authorization never reuses the old one's access token. */
  const access = new Map()
  /** Device flow in progress, per source id. */
  const pending = new Map()

  async function post(ctx, url, params) {
    const res = await f(url, { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'nuonuo', ...spec.tokenHeaders },
      body: form(params) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok && !data.error) data.error = `HTTP ${res.status}`
    return data
  }

  /** Keeps what a token response grants, then lets the source read the account (`onGrant` returns facts to show). */
  async function grant(ctx, data) {
    if (data.refresh_token) {
      ctx.secret.set('refresh_token', data.refresh_token)
      ctx.secret.delete('token')
      if (data.access_token) access.set(data.refresh_token, { token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 })
    } else {
      ctx.secret.set('token', data.access_token)
      ctx.secret.delete('refresh_token')
    }
    const facts = spec.onGrant ? await spec.onGrant(ctx, data.access_token) : undefined
    if (facts) ctx.facts(facts)
  }

  async function accessToken(ctx) {
    const refresh = ctx.secret.get('refresh_token')
    if (!refresh) {
      const token = ctx.secret.get('token')
      if (token) return token
      throw authError(`还没有授权 ${label}：在 设置 → 来源 里点「授权 ${label}」`)
    }
    const cached = access.get(refresh)
    if (cached && cached.expires > Date.now() + 60_000) return cached.token
    const { id, secret } = client(ctx)
    const data = await post(ctx, pick(spec.tokenUrl, ctx), { client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' })
    if (!data.access_token) {
      throw authError(data.error === 'invalid_grant'
        ? `${label} 授权已失效（被撤销或过期），请在 设置 → 来源 里重新点「授权 ${label}」`
        : `刷新 ${label} 令牌失败：${data.error_description ?? data.error}`)
    }
    // Some providers rotate the refresh token on every use.
    if (data.refresh_token && data.refresh_token !== refresh) { ctx.secret.set('refresh_token', data.refresh_token); access.delete(refresh) }
    access.set(data.refresh_token ?? refresh, { token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 })
    return data.access_token
  }

  async function disconnect(ctx) {
    pending.delete(ctx.id)
    const refresh = ctx.secret.get('refresh_token')
    const token = refresh ?? ctx.secret.get('token')
    if (refresh) access.delete(refresh)
    const revoke = spec.revokeUrl && pick(spec.revokeUrl, ctx)
    // Revoke at the provider too, so the grant leaves the account's list of connected apps; best effort.
    if (token && revoke) await f(revoke, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
    ctx.secret.delete('refresh_token')
    ctx.secret.delete('token')
    await spec.onDisconnect?.(ctx)
  }

  /** Polls the provider until the owner entered the code (or it expired). */
  async function waitForGrant(ctx, p) {
    while (pending.get(ctx.id) === p && p.status === 'pending') {
      await new Promise(r => setTimeout(r, p.interval * 1000))
      if (pending.get(ctx.id) !== p) return
      if (Date.now() > p.expires) { Object.assign(p, { status: 'error', error: `验证码已过期，请重新点「授权 ${label}」` }); return }
      let data
      try {
        data = await post(ctx, pick(spec.tokenUrl, ctx), { client_id: client(ctx).id, client_secret: client(ctx).secret, device_code: p.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
      } catch { continue } // a network blip: try again at the next interval
      if (data.access_token) {
        try { await grant(ctx, data); p.status = 'done' } catch (error) {
          Object.assign(p, { status: 'error', error: `拿到令牌但读取账号失败：${error instanceof Error ? error.message : String(error)}` })
        }
        return
      }
      if (data.error === 'authorization_pending') continue
      if (data.error === 'slow_down') { p.interval = Number(data.interval) || p.interval + 5; continue }
      Object.assign(p, { status: 'error', error: data.error === 'access_denied' ? `你在 ${label} 上取消了授权` : data.error === 'expired_token' ? `验证码已过期，请重新点「授权 ${label}」` : `授权失败：${data.error_description ?? data.error}` })
      return
    }
  }

  async function handle(ctx, request, path, info) {
    if (!info.public && (path === 'oauth/start' || path === 'oauth/device')) {
      if (!client(ctx).id) return Response.json({ error: spec.missingClient ?? `先在下面填写 ${label} 的 Client ID 并保存` }, { status: 400 })
      if (flow === 'device') {
        const data = await post(ctx, pick(spec.deviceUrl, ctx), { client_id: client(ctx).id, scope: scope(ctx) })
        if (!data.device_code) {
          const hint = spec.deviceErrorHint?.(data.error) ?? ''
          return Response.json({ error: `${label} 拒绝了授权请求（${data.error_description ?? data.error}）${hint}` }, { status: 400 })
        }
        const expiresIn = Number(data.expires_in) || 900
        const p = { deviceCode: data.device_code, interval: data.interval != null ? Number(data.interval) : 5, expires: Date.now() + expiresIn * 1000, status: 'pending' }
        pending.set(ctx.id, p)
        void waitForGrant(ctx, p)
        return Response.json({ device: { userCode: data.user_code, verificationUri: data.verification_uri ?? data.verification_url, expiresIn, poll: 'oauth/status' } })
      }
      const state = randomBytes(16).toString('hex')
      const verifier = spec.pkce === false ? undefined : randomBytes(32).toString('base64url')
      ctx.state.set('oauth_state', { state, verifier, at: Date.now() })
      const url = `${pick(spec.authorizeUrl, ctx)}?${form({ client_id: client(ctx).id, redirect_uri: `${info.origin}/plugin/${ctx.id}/oauth/callback`, response_type: 'code',
        scope: scope(ctx), state, ...(verifier ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
        ...pick(spec.authorizeParams, ctx) })}`
      return Response.json({ url })
    }
    if (!info.public && path === 'oauth/status') {
      const p = pending.get(ctx.id)
      if (!p) return Response.json({ status: 'error', error: '没有进行中的授权' })
      return Response.json({ status: p.status, ...(p.error ? { error: p.error } : {}) })
    }
    if (!info.public && path === 'oauth/disconnect') {
      await disconnect(ctx)
      return Response.json({ ok: true })
    }
    if (info.public && path === 'oauth/callback' && flow === 'code') {
      const params = new URL(request.url).searchParams
      const expected = ctx.state.get('oauth_state')
      if (!expected || params.get('state') !== expected.state || Date.now() - expected.at > 15 * 60_000) return new Response('授权已过期或无效，请回到设置页重新点「授权」', { status: 400 })
      ctx.state.set('oauth_state', null)
      if (params.get('error')) return new Response(`授权被取消：${params.get('error')}`, { status: 400 })
      const { id, secret } = client(ctx)
      const data = await post(ctx, pick(spec.tokenUrl, ctx), { code: params.get('code') ?? '', client_id: id, client_secret: secret,
        redirect_uri: `${info.origin}/plugin/${ctx.id}/oauth/callback`, grant_type: 'authorization_code', code_verifier: expected.verifier })
      if (!data.access_token && !data.refresh_token) return new Response(`换取令牌失败：${data.error_description ?? data.error ?? '没有返回令牌'}`, { status: 400 })
      if (spec.requireRefresh && !data.refresh_token) return new Response('换取令牌失败：没有返回 refresh_token', { status: 400 })
      await grant(ctx, data)
      return new Response(null, { status: 302, headers: { location: `/#/settings/sources/${encodeURIComponent(ctx.id)}` } })
    }
    return undefined
  }

  /** The kind with the authorization buttons, `authorized` and the oauth/* endpoints added. */
  function source(kind) {
    const start = flow === 'device' ? 'oauth/device' : 'oauth/start'
    return {
      ...kind,
      actions: [
        { id: 'authorize', label: `授权 ${label}`, path: start, show: 'unauthorized', primary: true },
        { id: 'reauthorize', label: '重新授权', path: start, show: 'authorized' },
        { id: 'disconnect', label: '断开授权', path: 'oauth/disconnect', show: 'authorized', ...(spec.disconnectConfirm ? { confirm: spec.disconnectConfirm } : {}) },
        ...(kind.actions ?? []),
      ],
      authorized: ctx => Boolean(ctx.secret.get('refresh_token') || ctx.secret.get('token')),
      async http(ctx, request, path, info) {
        if (path.startsWith('oauth/')) {
          const handled = await handle(ctx, request, path, info)
          if (handled) return handled
        }
        return kind.http?.(ctx, request, path, info)
      },
    }
  }

  return { source, accessToken, disconnect }
}
