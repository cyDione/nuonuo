/**
 * Decoupled client-server connection manager for `apps/web` (works inside thin Electron desktop,
 * standalone hosted web, Vite dev, and daemon `--web` mode).
 *
 * - Keeps short-lived `accessToken` (`nna_…`) in memory ONLY.
 * - Stores rotating `refreshToken` (`nnr_…`) in Electron's OS-encrypted `safeStorage` vault on desktop,
 *   in an `HttpOnly; SameSite=Strict` cookie when same-origin (`--web`), or in `sessionStorage` for cross-origin web.
 * - Provides single-flight automatic refresh on 401, fetch-based SSE (`fetchSSE`), blob-backed image loading,
 *   ephemeral single-path resource tickets, and native WebAuthn Passkey helpers.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { desktop } from './shell'

export type AuthStatus = 'booting' | 'ready' | 'unauthenticated' | 'offline'

export interface ServerProfile {
  id: string
  name: string
  baseUrl: string
  deviceId?: string
  deviceName?: string
  scopes?: string[]
  insecureAllowed?: boolean
  createdAt: number
  lastConnectedAt?: number
}

export interface AuthMethodsResponse {
  protocol: string
  server: { name: 'nuonuo'; version: string }
  webUi: boolean
  methods: { pairing: boolean; password: boolean; passkey: boolean; passkeyConfigured?: boolean }
}

export interface AuthBundle {
  protocol: string
  accessToken: string
  expiresIn: number
  expiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  device: { id: string; name: string; kind: string; scopes: string[] }
  session: { id: string; familyId: string }
}

export interface ConnectionState {
  status: AuthStatus
  profiles: ServerProfile[]
  activeProfileId: string | null
  baseUrl: string
  accessToken: string
  deviceId: string | null
  sessionId: string | null
  scopes: string[]
  error: string | null
  /** Deep-linked `nuonuo://pair?...` payload waiting for user confirmation in the Connect view. */
  pendingPairUri: { server: string; code: string } | null
}

const PROFILES_KEY = 'nuonuo:profiles:v1'
const ACTIVE_KEY = 'nuonuo:active-profile:v1'
const REFRESH_SS_PREFIX = 'nuonuo:refresh:'

export function normalizeServerUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  return `https://${s}`
}

export function isLocalServerUrl(url: string): boolean {
  if (!url) return true
  try {
    const u = new URL(url)
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  } catch {
    return false
  }
}

export function isInsecureRemoteUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && !isLocalServerUrl(url)
  } catch {
    return false
  }
}

export function parsePairUri(input: string): { server: string; code: string } | null {
  const raw = input.trim()
  if (!/^nuonuo:\/\/pair\?/i.test(raw)) return null
  try {
    const u = new URL(raw)
    const server = u.searchParams.get('server')?.trim()
    const code = u.searchParams.get('code')?.trim()
    if (!server || !code) return null
    return { server: normalizeServerUrl(server), code }
  } catch {
    return null
  }
}

/** True when served directly by the daemon `--web` or Vite dev proxy over http(s). */
export function isHttpWebOrigin(): boolean {
  if (typeof location === 'undefined' || desktop) return false
  return location.protocol === 'http:' || location.protocol === 'https:'
}

function isSameOriginUrl(baseUrl: string): boolean {
  if (!isHttpWebOrigin()) return false
  if (!baseUrl) return true
  try {
    return new URL(baseUrl).origin === location.origin
  } catch {
    return false
  }
}

let conn: ConnectionState = {
  status: 'booting',
  profiles: [],
  activeProfileId: null,
  baseUrl: '',
  accessToken: '',
  deviceId: null,
  sessionId: null,
  scopes: [],
  error: null,
  pendingPairUri: null,
}

const listeners = new Set<() => void>()
function update(patch: Partial<ConnectionState>) {
  conn = { ...conn, ...patch }
  for (const l of listeners) l()
}
export function useConnection(): ConnectionState {
  return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, () => conn)
}
export function getConnection(): ConnectionState { return conn }

// ── Profile & Refresh Token storage (Electron safeStorage vault vs Browser) ──

async function loadProfilesFromStorage(): Promise<{ profiles: ServerProfile[]; activeId: string | null }> {
  if (desktop?.vault) {
    const data = await desktop.vault.list()
    return { profiles: data.profiles, activeId: data.activeId }
  }
  try {
    const profiles = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]') as ServerProfile[]
    const activeId = localStorage.getItem(ACTIVE_KEY)
    return { profiles: Array.isArray(profiles) ? profiles : [], activeId }
  } catch {
    return { profiles: [], activeId: null }
  }
}

async function saveProfileToStorage(profile: ServerProfile, refreshToken?: string): Promise<void> {
  if (desktop?.vault) {
    await desktop.vault.save(profile, refreshToken)
    return
  }
  const existing = conn.profiles.filter(p => p.id !== profile.id)
  const next = [profile, ...existing]
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(next))
    localStorage.setItem(ACTIVE_KEY, profile.id)
    if (refreshToken && !isSameOriginUrl(profile.baseUrl)) {
      sessionStorage.setItem(`${REFRESH_SS_PREFIX}${profile.id}`, refreshToken)
    }
  } catch { /* private mode */ }
}

async function getStoredRefreshToken(profileId: string): Promise<string | undefined> {
  if (desktop?.vault) return desktop.vault.getRefreshToken(profileId)
  try {
    return sessionStorage.getItem(`${REFRESH_SS_PREFIX}${profileId}`) ?? undefined
  } catch {
    return undefined
  }
}

async function removeProfileFromStorage(profileId: string): Promise<void> {
  if (desktop?.vault) {
    await desktop.vault.remove(profileId)
    return
  }
  const next = conn.profiles.filter(p => p.id !== profileId)
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(next))
    sessionStorage.removeItem(`${REFRESH_SS_PREFIX}${profileId}`)
    if (localStorage.getItem(ACTIVE_KEY) === profileId) {
      if (next[0]) localStorage.setItem(ACTIVE_KEY, next[0].id)
      else localStorage.removeItem(ACTIVE_KEY)
    }
  } catch { /* private mode */ }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
function clearProactiveRefresh() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
}
function scheduleProactiveRefresh(expiresAt: number) {
  clearProactiveRefresh()
  if (typeof window === 'undefined' || !expiresAt) return
  const delayMs = Math.max(15_000, expiresAt - Date.now() - 120_000)
  refreshTimer = setTimeout(() => {
    if (conn.status === 'ready') void refreshSession()
  }, delayMs)
}

async function notifyDesktopActive(profile: ServerProfile | null, accessToken: string) {
  if (desktop?.vault?.setActiveSession) {
    await desktop.vault.setActiveSession(profile ? { id: profile.id, baseUrl: profile.baseUrl, accessToken } : null).catch(() => {})
  }
}

// ── Server discovery & authentication actions ────────────────────────────────

export function apiUrl(path: string, baseUrl = conn.baseUrl): string {
  const cleanPath = path.startsWith('/v1') ? path : `/v1${path.startsWith('/') ? path : `/${path}`}`
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}${cleanPath}` : cleanPath
}

export async function discoverServer(baseUrl: string): Promise<AuthMethodsResponse> {
  const normalized = normalizeServerUrl(baseUrl)
  const res = await fetch(apiUrl('/auth/methods', normalized), {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  })
  const data = await res.json().catch(() => undefined)
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  return data as AuthMethodsResponse
}

function defaultClientDevice(): { name: string; kind: 'desktop' | 'web'; platform: string } {
  const isDesk = Boolean(desktop)
  const plat = desktop?.platform ?? (typeof navigator !== 'undefined' ? navigator.platform || 'browser' : 'browser')
  const name = isDesk ? `Nuonuo 桌面端 (${plat})` : `Web 浏览器 (${plat})`
  return { name, kind: isDesk ? 'desktop' : 'web', platform: plat }
}

async function applyAuthBundle(baseUrl: string, bundle: AuthBundle, opts: { profileName?: string; insecureAllowed?: boolean; existingId?: string } = {}): Promise<void> {
  const normalized = normalizeServerUrl(baseUrl)
  const existing = opts.existingId
    ? conn.profiles.find(p => p.id === opts.existingId)
    : conn.profiles.find(p => p.baseUrl === normalized)
  const now = Date.now()
  const label = opts.profileName?.trim() || existing?.name || (normalized ? new URL(normalized).host : location.host)
  const profile: ServerProfile = {
    id: existing?.id ?? `srv_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: label,
    baseUrl: normalized,
    deviceId: bundle.device.id,
    deviceName: bundle.device.name,
    scopes: bundle.device.scopes,
    ...(opts.insecureAllowed || existing?.insecureAllowed ? { insecureAllowed: true } : {}),
    createdAt: existing?.createdAt ?? now,
    lastConnectedAt: now,
  }
  await saveProfileToStorage(profile, bundle.refreshToken)
  const profiles = [profile, ...conn.profiles.filter(p => p.id !== profile.id)]
  update({
    status: 'ready',
    profiles,
    activeProfileId: profile.id,
    baseUrl: normalized,
    accessToken: bundle.accessToken,
    deviceId: bundle.device.id,
    sessionId: bundle.session.id,
    scopes: bundle.device.scopes,
    error: null,
    pendingPairUri: null,
  })
  scheduleProactiveRefresh(bundle.expiresAt)
  await notifyDesktopActive(profile, bundle.accessToken)
}

export async function loginWithPairCode(
  baseUrl: string,
  code: string,
  opts: { deviceName?: string; profileName?: string; insecureAllowed?: boolean } = {},
): Promise<void> {
  const normalized = normalizeServerUrl(baseUrl)
  const dev = defaultClientDevice()
  const useCookie = isSameOriginUrl(normalized)
  const res = await fetch(apiUrl('/auth/pair/exchange', normalized), {
    method: 'POST',
    credentials: useCookie ? 'include' : 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: code.trim(),
      device: { ...dev, ...(opts.deviceName?.trim() ? { name: opts.deviceName.trim() } : {}) },
      cookie: useCookie,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  await applyAuthBundle(normalized, data as AuthBundle, opts)
}

export async function loginWithPassword(
  baseUrl: string,
  password: string,
  opts: { deviceName?: string; profileName?: string; insecureAllowed?: boolean } = {},
): Promise<void> {
  const normalized = normalizeServerUrl(baseUrl)
  const dev = defaultClientDevice()
  const useCookie = isSameOriginUrl(normalized)
  const res = await fetch(apiUrl('/auth/password/login', normalized), {
    method: 'POST',
    credentials: useCookie ? 'include' : 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password,
      device: { ...dev, ...(opts.deviceName?.trim() ? { name: opts.deviceName.trim() } : {}) },
      cookie: useCookie,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  await applyAuthBundle(normalized, data as AuthBundle, opts)
}

// ── Native WebAuthn Passkey helpers (zero extra browser dependency) ─────────

function b64uToBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const pad = b64u.length % 4 === 0 ? '' : '='.repeat(4 - (b64u.length % 4))
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return view
}

function bytesToB64u(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isPasskeyBrowserSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && Boolean(navigator.credentials)
}

export async function loginWithPasskey(
  baseUrl: string,
  opts: { deviceName?: string; profileName?: string; insecureAllowed?: boolean } = {},
): Promise<void> {
  if (!isPasskeyBrowserSupported()) throw new Error('当前环境不支持 WebAuthn Passkey（需要 HTTPS 或 localhost 浏览器）')
  const normalized = normalizeServerUrl(baseUrl)
  const useCookie = isSameOriginUrl(normalized)
  const optRes = await fetch(apiUrl('/auth/passkey/login/options', normalized), { method: 'POST', credentials: useCookie ? 'include' : 'omit' })
  const optData = await optRes.json().catch(() => ({}))
  if (!optRes.ok) throw new Error(optData?.error?.message ?? `HTTP ${optRes.status}`)
  const { challengeId, options } = optData as { challengeId: string; options: any }
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: b64uToBytes(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c: any) => ({ ...c, id: b64uToBytes(c.id) })),
  }
  const cred = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null
  if (!cred) throw new Error('Passkey 认证已取消')
  const resp = cred.response as AuthenticatorAssertionResponse
  const payload = {
    id: cred.id,
    rawId: bytesToB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64u(resp.clientDataJSON),
      authenticatorData: bytesToB64u(resp.authenticatorData),
      signature: bytesToB64u(resp.signature),
      ...(resp.userHandle ? { userHandle: bytesToB64u(resp.userHandle) } : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  }
  const dev = defaultClientDevice()
  const verifyRes = await fetch(apiUrl('/auth/passkey/login/verify', normalized), {
    method: 'POST',
    credentials: useCookie ? 'include' : 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId,
      response: payload,
      device: { ...dev, ...(opts.deviceName?.trim() ? { name: opts.deviceName.trim() } : {}) },
      cookie: useCookie,
    }),
  })
  const verifyData = await verifyRes.json().catch(() => ({}))
  if (!verifyRes.ok) throw new Error(verifyData?.error?.message ?? `HTTP ${verifyRes.status}`)
  await applyAuthBundle(normalized, verifyData as AuthBundle, opts)
}

export async function registerPasskey(name: string): Promise<{ id: string; name: string }> {
  if (!isPasskeyBrowserSupported()) throw new Error('当前环境不支持 WebAuthn Passkey（需要 HTTPS 或 localhost）')
  const optRes = await authedFetch('/auth/passkey/register/options', { method: 'POST' })
  const optData = await optRes.json().catch(() => ({}))
  if (!optRes.ok) throw new Error(optData?.error?.message ?? `HTTP ${optRes.status}`)
  const { challengeId, options } = optData as { challengeId: string; options: any }
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: b64uToBytes(options.challenge),
    user: { ...options.user, id: b64uToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({ ...c, id: b64uToBytes(c.id) })),
  }
  const cred = await navigator.credentials.create({ publicKey }) as PublicKeyCredential | null
  if (!cred) throw new Error('Passkey 注册已取消')
  const resp = cred.response as AuthenticatorAttestationResponse
  const payload = {
    id: cred.id,
    rawId: bytesToB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64u(resp.clientDataJSON),
      attestationObject: bytesToB64u(resp.attestationObject),
      ...(typeof resp.getTransports === 'function' ? { transports: resp.getTransports() } : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  }
  const res = await authedFetch('/auth/passkey/register/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, response: payload, name }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  return data.passkey as { id: string; name: string }
}

// ── Single-flight refresh & session lifecycle ────────────────────────────────

let refreshing: Promise<string | null> | null = null

export async function refreshSession(profileOverride?: ServerProfile): Promise<string | null> {
  if (refreshing) return refreshing
  const run = (async () => {
    const profile = profileOverride ?? conn.profiles.find(p => p.id === conn.activeProfileId)
    const baseUrl = profile ? profile.baseUrl : conn.baseUrl
    const useCookie = isSameOriginUrl(baseUrl)
    const storedRefresh = profile ? await getStoredRefreshToken(profile.id) : undefined
    if (!storedRefresh && !useCookie) {
      update({ status: 'unauthenticated', accessToken: '', error: null })
      return null
    }
    try {
      const res = await fetch(apiUrl('/auth/refresh', baseUrl), {
        method: 'POST',
        credentials: useCookie ? 'include' : 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(storedRefresh ? { refreshToken: storedRefresh } : {}), cookie: useCookie }),
      })
      if (res.status === 401 || res.status === 403) {
        clearProactiveRefresh()
        const data = await res.json().catch(() => ({}))
        update({ status: 'unauthenticated', accessToken: '', error: data?.error?.message ?? null })
        await notifyDesktopActive(null, '')
        return null
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bundle = (await res.json()) as AuthBundle
      await applyAuthBundle(baseUrl, bundle, { existingId: profile?.id })
      return bundle.accessToken
    } catch (error) {
      update({ status: 'offline', error: (error as Error).message })
      return null
    } finally {
      refreshing = null
    }
  })()
  refreshing = run
  return run
}

let booted = false
export async function bootstrapConnection(): Promise<void> {
  if (booted) return
  booted = true

  // Listen for `nuonuo://pair?...` deep links forwarded from Electron main process.
  desktop?.on?.('pair-uri', raw => {
    if (typeof raw !== 'string') return
    const parsed = parsePairUri(raw)
    if (parsed) update({ pendingPairUri: parsed, status: 'unauthenticated' })
  })
  desktop?.on?.('need-refresh', () => {
    if (conn.status === 'ready') void refreshSession()
  })

  const { profiles, activeId } = await loadProfilesFromStorage()
  const active = profiles.find(p => p.id === activeId) ?? profiles[0] ?? null
  update({ profiles, activeProfileId: active?.id ?? null, baseUrl: active?.baseUrl ?? '' })

  if (active) {
    await refreshSession(active)
    return
  }

  // Same-origin browser (`nuonuo start --web` or Vite dev): probe same-origin cookie session automatically.
  if (isHttpWebOrigin()) {
    try {
      await discoverServer('')
      const token = await refreshSession()
      if (!token) update({ status: 'unauthenticated', baseUrl: '', error: null })
      return
    } catch {
      update({ status: 'unauthenticated', baseUrl: '', error: null })
      return
    }
  }

  // Thin desktop client with no saved server yet: open the Connection Center immediately.
  update({ status: 'unauthenticated', error: null })
}

export async function switchProfile(profileId: string): Promise<void> {
  const target = conn.profiles.find(p => p.id === profileId)
  if (!target) return
  if (desktop?.vault) await desktop.vault.setActive(profileId)
  else try { localStorage.setItem(ACTIVE_KEY, profileId) } catch { /* ignore */ }
  update({ status: 'booting', activeProfileId: target.id, baseUrl: target.baseUrl, accessToken: '', error: null })
  await refreshSession(target)
}

export async function disconnectCurrent(revokeRemote = true): Promise<void> {
  clearProactiveRefresh()
  if (revokeRemote && conn.accessToken) {
    const useCookie = isSameOriginUrl(conn.baseUrl)
    await fetch(apiUrl('/auth/logout'), {
      method: 'POST',
      credentials: useCookie ? 'include' : 'omit',
      headers: { authorization: `Bearer ${conn.accessToken}` },
    }).catch(() => {})
  }
  if (conn.activeProfileId) {
    await removeProfileFromStorage(conn.activeProfileId)
  }
  const remaining = conn.profiles.filter(p => p.id !== conn.activeProfileId)
  update({
    status: 'unauthenticated',
    profiles: remaining,
    activeProfileId: remaining[0]?.id ?? null,
    baseUrl: remaining[0]?.baseUrl ?? '',
    accessToken: '',
    deviceId: null,
    sessionId: null,
    scopes: [],
    error: null,
  })
  await notifyDesktopActive(null, '')
}

export async function removeSavedProfile(profileId: string): Promise<void> {
  if (profileId === conn.activeProfileId && conn.status === 'ready') {
    await disconnectCurrent(true)
    return
  }
  await removeProfileFromStorage(profileId)
  const remaining = conn.profiles.filter(p => p.id !== profileId)
  update({
    profiles: remaining,
    activeProfileId: conn.activeProfileId === profileId ? (remaining[0]?.id ?? null) : conn.activeProfileId,
  })
}

export function openConnectionCenter(): void {
  update({ status: 'unauthenticated', error: null })
}

// ── Authenticated fetch, SSE, blobs & ephemeral resource tickets ─────────────

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = apiUrl(path)
  const run = (token: string) => {
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  }
  let res = await run(conn.accessToken)
  if (res.status === 401) {
    const nextToken = await refreshSession()
    if (nextToken) res = await run(nextToken)
  }
  return res
}

/** Issues a 30-second single-path resource ticket and returns the direct URL (for iframes / downloads). */
export async function signedResourceUrl(v1Path: string, opts: { download?: boolean } = {}): Promise<string> {
  const cleanPath = v1Path.startsWith('/v1') ? v1Path : `/v1${v1Path.startsWith('/') ? v1Path : `/${v1Path}`}`
  const basePath = cleanPath.split('?')[0]!
  const res = await authedFetch('/auth/resource-ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: basePath }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { ticket } = (await res.json()) as { ticket: string }
  const sep = cleanPath.includes('?') ? '&' : '?'
  const dl = opts.download ? '&download=1' : ''
  return `${apiUrl(cleanPath)}${sep}ticket=${encodeURIComponent(ticket)}${dl}`
}

/** Fetches a protected image/media path with Bearer auth and returns a managed `blob:` URL. */
export function useAuthedBlobUrl(v1Path: string | null | undefined): { url: string | null; error: boolean } {
  const [state, setState] = useState<{ url: string | null; error: boolean }>({ url: null, error: false })
  useEffect(() => {
    if (!v1Path) { setState({ url: null, error: false }); return }
    let revoked = false
    let objectUrl: string | null = null
    const ctrl = new AbortController()
    void authedFetch(v1Path, { signal: ctrl.signal })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setState({ url: objectUrl, error: false })
      })
      .catch(() => {
        if (!revoked) setState({ url: null, error: true })
      })
    return () => {
      revoked = true
      ctrl.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [v1Path])
  return state
}

/** Fetch-based SSE reader carrying `Authorization: Bearer` (replaces cookie-only native `EventSource`). */
export async function streamAuthedSSE(
  path: string,
  onEvent: (event: string, data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await authedFetch(path, {
    headers: { accept: 'text/event-stream' },
    cache: 'no-store',
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'event') event = val
          else if (field === 'data') data.push(val)
        }
        if (data.length || event !== 'message') onEvent(event, data.join('\n'))
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
