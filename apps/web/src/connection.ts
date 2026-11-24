/**
 * Decoupled client-server connection manager for `apps/web` (works inside thin Electron desktop,
 * standalone hosted web, Vite dev, and daemon `--web` mode).
 *
 * - Keeps short-lived `accessToken` (`nna_…`) in memory ONLY.
 * - Stores rotating `refreshToken` (`nnr_…`) in Electron's OS-encrypted `safeStorage` vault on desktop,
 *   in an `HttpOnly; SameSite=Strict` cookie when same-origin (`--web`), or in `sessionStorage` for cross-origin web.
 * - Provides single-flight automatic refresh on 401, cross-tab/multi-window in-memory token sync (`BroadcastChannel`)
 *   and refresh serialization (`navigator.locks`), fetch-based SSE (`fetchSSE`), blob-backed image loading,
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
const AUTH_CHANNEL_NAME = 'nuonuo:auth-sync:v1'
const AUTH_META_PREFIX = 'nuonuo:auth-meta:v1:'
const TAB_ID = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const PEER_BOOT_TIMEOUT_MS = 180
const PEER_LOCK_TIMEOUT_MS = 350
const LOCK_RELEASE_YIELD_MS = 30

export interface RefreshOptions {
  /** Token that just failed with 401 (or triggered proactive refresh); if a peer already synced a newer token, reuse it. */
  staleToken?: string
  /** Proactive timer refresh: skip network rotation if current token still has ample lifetime left. */
  proactive?: boolean
}

interface AuthSyncMeta {
  sessionId: string | null
  rotatedAt: number
  expiresAt: number
  tabId: string
}

type AuthSyncMessage =
  | {
      type: 'auth-request'
      fromTabId: string
      requestId: string
      serverKey: string
    }
  | {
      type: 'auth-sync'
      fromTabId: string
      targetTabId?: string
      requestId?: string
      serverKey: string
      baseUrl: string
      profile?: ServerProfile
      accessToken: string
      expiresAt: number
      rotatedAt: number
      deviceId: string | null
      sessionId: string | null
      scopes: string[]
    }
  | {
      type: 'auth-logout'
      fromTabId: string
      serverKey: string
      sessionId: string | null
      reason?: string | null
    }

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

/** Canonical cross-tab key for a server (`''` and `location.origin` unify to `'same-origin'`). */
export function canonicalServerKey(baseUrl: string): string {
  if (isSameOriginUrl(baseUrl)) return 'same-origin'
  return normalizeServerUrl(baseUrl)
}

/** True when all tabs/windows share a single rotating refresh credential (same-origin HttpOnly cookie or Electron vault). */
function isSharedRefreshStore(baseUrl: string): boolean {
  return Boolean(desktop) || isSameOriginUrl(baseUrl)
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
let accessExpiresAt = 0
let lastRotatedAt = 0

const listeners = new Set<() => void>()
function update(patch: Partial<ConnectionState>) {
  conn = { ...conn, ...patch }
  for (const l of listeners) l()
}
export function useConnection(): ConnectionState {
  return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, () => conn)
}
export function getConnection(): ConnectionState { return conn }

// ── Cross-tab auth sync (BroadcastChannel + Web Locks; accessToken stays in-memory only) ──

interface PeerWaiter {
  serverKey: string
  excludeToken?: string
  resolve: (token: string | null) => void
  timer: ReturnType<typeof setTimeout>
}

let syncChannel: BroadcastChannel | null = null
const peerWaiters = new Set<PeerWaiter>()

function hasBroadcastChannel(): boolean {
  return typeof BroadcastChannel !== 'undefined'
}

function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.locks && typeof navigator.locks.request === 'function')
}

function readSyncMeta(serverKey: string): AuthSyncMeta | null {
  try {
    const raw = localStorage.getItem(`${AUTH_META_PREFIX}${serverKey}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AuthSyncMeta
    if (typeof parsed?.rotatedAt !== 'number' || typeof parsed?.expiresAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function writeSyncMeta(serverKey: string, meta: AuthSyncMeta): void {
  try {
    localStorage.setItem(`${AUTH_META_PREFIX}${serverKey}`, JSON.stringify(meta))
  } catch { /* private mode */ }
}

function clearSyncMeta(serverKey: string): void {
  try {
    localStorage.removeItem(`${AUTH_META_PREFIX}${serverKey}`)
  } catch { /* private mode */ }
}

function postSyncMessage(msg: AuthSyncMessage): void {
  const ch = ensureSyncChannel()
  if (!ch) return
  try {
    ch.postMessage(msg)
  } catch { /* closed or unsupported */ }
}

function broadcastAuthSync(
  baseUrl: string,
  profile: ServerProfile | undefined,
  opts: { targetTabId?: string; requestId?: string; rotatedAt: number } = { rotatedAt: Date.now() },
): void {
  if (!conn.accessToken || conn.status !== 'ready') return
  postSyncMessage({
    type: 'auth-sync',
    fromTabId: TAB_ID,
    ...(opts.targetTabId ? { targetTabId: opts.targetTabId } : {}),
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    serverKey: canonicalServerKey(baseUrl),
    baseUrl: normalizeServerUrl(baseUrl),
    ...(profile ? { profile } : {}),
    accessToken: conn.accessToken,
    expiresAt: accessExpiresAt,
    rotatedAt: opts.rotatedAt,
    deviceId: conn.deviceId,
    sessionId: conn.sessionId,
    scopes: conn.scopes,
  })
}

function broadcastAuthLogout(baseUrl: string, sessionId: string | null, reason?: string | null): void {
  postSyncMessage({
    type: 'auth-logout',
    fromTabId: TAB_ID,
    serverKey: canonicalServerKey(baseUrl),
    sessionId,
    reason: reason ?? null,
  })
}

function resolveMatchingWaiters(serverKey: string, token: string): void {
  for (const w of [...peerWaiters]) {
    if (w.serverKey !== serverKey) continue
    if (w.excludeToken && token === w.excludeToken) continue
    clearTimeout(w.timer)
    peerWaiters.delete(w)
    w.resolve(token)
  }
}

function handleSyncMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const msg = raw as AuthSyncMessage
  if (!msg.fromTabId || msg.fromTabId === TAB_ID) return

  if (msg.type === 'auth-request') {
    if (refreshing) return
    if (conn.status !== 'ready' || !conn.accessToken) return
    if (!isSharedRefreshStore(conn.baseUrl)) return
    if (canonicalServerKey(conn.baseUrl) !== msg.serverKey) return
    if (accessExpiresAt > 0 && accessExpiresAt - Date.now() <= 60_000) return
    const activeProfile = conn.profiles.find(p => p.id === conn.activeProfileId)
    broadcastAuthSync(conn.baseUrl, activeProfile, {
      targetTabId: msg.fromTabId,
      requestId: msg.requestId,
      rotatedAt: lastRotatedAt || Date.now(),
    })
    return
  }

  if (msg.type === 'auth-sync') {
    if (msg.targetTabId && msg.targetTabId !== TAB_ID) return
    if (!msg.accessToken) return
    const shared = isSharedRefreshStore(msg.baseUrl)
    const sameServer = canonicalServerKey(conn.baseUrl) === msg.serverKey
    const sameSession = Boolean(conn.sessionId && msg.sessionId && conn.sessionId === msg.sessionId)
    const canAdopt = shared
      ? (sameServer || conn.status === 'booting' || conn.status === 'unauthenticated' || conn.status === 'offline')
      : sameSession
    if (!canAdopt) return

    // Ignore stale out-of-order broadcasts when we already hold a fresher, live token.
    if (msg.rotatedAt < lastRotatedAt && conn.status === 'ready' && conn.accessToken && accessExpiresAt > Date.now() + 30_000) {
      return
    }

    const incomingProfile = msg.profile
    const profiles = incomingProfile
      ? [incomingProfile, ...conn.profiles.filter(p => p.id !== incomingProfile.id)]
      : conn.profiles
    const activeProfileId = incomingProfile?.id ?? conn.activeProfileId
    const nextBaseUrl = incomingProfile?.baseUrl ?? msg.baseUrl

    accessExpiresAt = msg.expiresAt || accessExpiresAt
    lastRotatedAt = Math.max(lastRotatedAt, msg.rotatedAt || Date.now())
    update({
      status: 'ready',
      profiles,
      activeProfileId,
      baseUrl: nextBaseUrl,
      accessToken: msg.accessToken,
      deviceId: msg.deviceId,
      sessionId: msg.sessionId,
      scopes: msg.scopes,
      error: null,
      pendingPairUri: null,
    })
    if (accessExpiresAt) scheduleProactiveRefresh(accessExpiresAt)
    resolveMatchingWaiters(msg.serverKey, msg.accessToken)
    return
  }

  if (msg.type === 'auth-logout') {
    if (canonicalServerKey(conn.baseUrl) !== msg.serverKey) return
    if (msg.sessionId && conn.sessionId && msg.sessionId !== conn.sessionId) return
    clearProactiveRefresh()
    accessExpiresAt = 0
    update({
      status: 'unauthenticated',
      accessToken: '',
      deviceId: null,
      sessionId: null,
      scopes: [],
      error: msg.reason ?? null,
    })
  }
}

function ensureSyncChannel(): BroadcastChannel | null {
  if (syncChannel) return syncChannel
  if (!hasBroadcastChannel()) return null
  try {
    syncChannel = new BroadcastChannel(AUTH_CHANNEL_NAME)
    syncChannel.onmessage = ev => handleSyncMessage(ev.data)
    return syncChannel
  } catch {
    return null
  }
}

function requestTokenFromPeers(
  serverKey: string,
  opts: { timeoutMs?: number; excludeToken?: string } = {},
): Promise<string | null> {
  const ch = ensureSyncChannel()
  if (!ch) return Promise.resolve(null)
  const timeoutMs = opts.timeoutMs ?? PEER_BOOT_TIMEOUT_MS
  return new Promise(resolve => {
    const waiter: PeerWaiter = {
      serverKey,
      ...(opts.excludeToken ? { excludeToken: opts.excludeToken } : {}),
      resolve,
      timer: setTimeout(() => {
        peerWaiters.delete(waiter)
        resolve(null)
      }, timeoutMs),
    }
    peerWaiters.add(waiter)
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    postSyncMessage({ type: 'auth-request', fromTabId: TAB_ID, requestId, serverKey })
  })
}

async function withCrossTabRefreshLock<T>(serverKey: string, fn: (lockWaitMs: number) => Promise<T>): Promise<T> {
  const enteredAt = Date.now()
  if (!hasWebLocks()) return fn(0)
  return navigator.locks.request(`nuonuo:auth-refresh:${serverKey}`, () => fn(Date.now() - enteredAt))
}

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
  // Visible tabs refresh slightly earlier (~120s before expiry + 0–5s jitter);
  // background tabs wait slightly longer (~95–110s before expiry) so they adopt the visible tab's BroadcastChannel sync instead of racing.
  const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const leadMs = isHidden ? 100_000 : 120_000
  const jitterMs = Math.floor(Math.random() * (isHidden ? 15_000 : 5_000))
  const delayMs = Math.max(15_000, expiresAt - Date.now() - leadMs + jitterMs)
  const scheduledForToken = conn.accessToken
  refreshTimer = setTimeout(() => {
    if (conn.status === 'ready') {
      void refreshSession(undefined, { proactive: true, staleToken: scheduledForToken })
    }
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
  ensureSyncChannel()
  const normalized = normalizeServerUrl(baseUrl)
  const existing = opts.existingId
    ? conn.profiles.find(p => p.id === opts.existingId)
    : conn.profiles.find(p => canonicalServerKey(p.baseUrl) === canonicalServerKey(normalized))
  const now = Date.now()
  const fallbackHost = typeof location !== 'undefined' && location.host ? location.host : 'localhost'
  const label = opts.profileName?.trim() || existing?.name || (normalized ? new URL(normalized).host : fallbackHost)
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
  accessExpiresAt = bundle.expiresAt
  lastRotatedAt = now
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
  const serverKey = canonicalServerKey(normalized)
  if (isSharedRefreshStore(normalized)) {
    writeSyncMeta(serverKey, {
      sessionId: bundle.session.id,
      rotatedAt: now,
      expiresAt: bundle.expiresAt,
      tabId: TAB_ID,
    })
  }
  broadcastAuthSync(normalized, profile, { rotatedAt: now })
  resolveMatchingWaiters(serverKey, bundle.accessToken)
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

function canReuseLiveToken(serverKey: string, opts: RefreshOptions): boolean {
  if (conn.status !== 'ready' || !conn.accessToken) return false
  if (canonicalServerKey(conn.baseUrl) !== serverKey) return false
  const now = Date.now()
  if (opts.staleToken) {
    // Another tab already synced a newer token replacing `staleToken`.
    return conn.accessToken !== opts.staleToken && (accessExpiresAt === 0 || accessExpiresAt > now + 30_000)
  }
  if (opts.proactive) {
    // Another tab already refreshed proactively; plenty of TTL left.
    return accessExpiresAt > now + 180_000
  }
  // Boot/reconnect call: another tab already pushed a fresh live token.
  return accessExpiresAt === 0 || accessExpiresAt > now + 60_000
}

export async function refreshSession(profileOverride?: ServerProfile, opts: RefreshOptions = {}): Promise<string | null> {
  if (refreshing) return refreshing
  ensureSyncChannel()
  const profile = profileOverride ?? conn.profiles.find(p => p.id === conn.activeProfileId)
  const baseUrl = profile ? profile.baseUrl : conn.baseUrl
  const serverKey = canonicalServerKey(baseUrl)

  // Fast path before waiting on any lock: a peer tab already pushed a newer valid token.
  if (canReuseLiveToken(serverKey, opts)) {
    if (opts.proactive && accessExpiresAt) scheduleProactiveRefresh(accessExpiresAt)
    return conn.accessToken
  }

  const run = (async () => {
    const useCookie = isSameOriginUrl(baseUrl)
    const sharedStore = isSharedRefreshStore(baseUrl)
    try {
      return await withCrossTabRefreshLock(serverKey, async lockWaitMs => {
        // Re-check after acquiring the cross-tab lock: a peer may have broadcast a fresh token while we waited.
        if (canReuseLiveToken(serverKey, opts)) {
          if (opts.proactive && accessExpiresAt) scheduleProactiveRefresh(accessExpiresAt)
          return conn.accessToken
        }

        // If we waited behind another lock holder OR localStorage shows another tab rotated more recently than our in-memory state,
        // wait briefly for the peer's BroadcastChannel sync before rotating the single-use refresh token again.
        if (sharedStore && hasBroadcastChannel()) {
          const meta = readSyncMeta(serverKey)
          const peerRecentlyRotated = Boolean(
            meta
            && meta.tabId !== TAB_ID
            && meta.rotatedAt > lastRotatedAt
            && meta.expiresAt > Date.now() + 60_000,
          )
          if (lockWaitMs >= 5 || peerRecentlyRotated) {
            const peerToken = await requestTokenFromPeers(serverKey, {
              timeoutMs: PEER_LOCK_TIMEOUT_MS,
              ...(opts.staleToken ? { excludeToken: opts.staleToken } : {}),
            })
            if (peerToken) return peerToken
          }
        }

        // Read refresh token INSIDE the cross-tab lock (critical for Electron vault shared between win & quick).
        const storedRefresh = profile ? await getStoredRefreshToken(profile.id) : undefined
        if (!storedRefresh && !useCookie) {
          update({ status: 'unauthenticated', accessToken: '', error: null })
          return null
        }

        const hadSession = Boolean(conn.sessionId || conn.accessToken)
        const prevSessionId = conn.sessionId
        const res = await fetch(apiUrl('/auth/refresh', baseUrl), {
          method: 'POST',
          credentials: useCookie ? 'include' : 'omit',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...(storedRefresh ? { refreshToken: storedRefresh } : {}), cookie: useCookie }),
        })
        if (res.status === 401 || res.status === 403) {
          // On non-secure origins without navigator.locks, a peer may have just rotated; check peers once before logging out.
          if (!hasWebLocks() && sharedStore && hasBroadcastChannel()) {
            const peerToken = await requestTokenFromPeers(serverKey, {
              timeoutMs: PEER_LOCK_TIMEOUT_MS,
              ...(opts.staleToken ? { excludeToken: opts.staleToken } : {}),
            })
            if (peerToken) return peerToken
          }
          clearProactiveRefresh()
          accessExpiresAt = 0
          const data = await res.json().catch(() => ({}))
          const message = data?.error?.message ?? null
          if (sharedStore) clearSyncMeta(serverKey)
          update({ status: 'unauthenticated', accessToken: '', deviceId: null, sessionId: null, scopes: [], error: message })
          if (hadSession && sharedStore) broadcastAuthLogout(baseUrl, prevSessionId, message)
          await notifyDesktopActive(null, '')
          return null
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const bundle = (await res.json()) as AuthBundle
        await applyAuthBundle(baseUrl, bundle, { existingId: profile?.id })
        // Briefly hold the cross-tab lock after posting `auth-sync` so queued peer tabs receive the BroadcastChannel message before entering.
        if (sharedStore && hasBroadcastChannel() && hasWebLocks()) {
          await new Promise(resolve => setTimeout(resolve, LOCK_RELEASE_YIELD_MS))
        }
        return bundle.accessToken
      })
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
  ensureSyncChannel()

  // Listen for `nuonuo://pair?...` deep links forwarded from Electron main process.
  desktop?.on?.('pair-uri', raw => {
    if (typeof raw !== 'string') return
    const parsed = parsePairUri(raw)
    if (parsed) update({ pendingPairUri: parsed, status: 'unauthenticated' })
  })
  desktop?.on?.('need-refresh', () => {
    if (conn.status === 'ready') void refreshSession(undefined, { staleToken: conn.accessToken })
  })

  const { profiles, activeId } = await loadProfilesFromStorage()
  const active = profiles.find(p => p.id === activeId) ?? profiles[0] ?? null
  update({ profiles, activeProfileId: active?.id ?? null, baseUrl: active?.baseUrl ?? '' })

  if (active) {
    if (isSharedRefreshStore(active.baseUrl)) {
      const peerToken = await requestTokenFromPeers(canonicalServerKey(active.baseUrl), { timeoutMs: PEER_BOOT_TIMEOUT_MS })
      if (peerToken) return
    }
    await refreshSession(active)
    return
  }

  // Same-origin browser (`nuonuo start --web` or Vite dev): adopt live peer token first, else probe same-origin cookie session.
  if (isHttpWebOrigin()) {
    const peerToken = await requestTokenFromPeers('same-origin', { timeoutMs: PEER_BOOT_TIMEOUT_MS })
    if (peerToken) return
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
  accessExpiresAt = 0
  lastRotatedAt = 0
  update({ status: 'booting', activeProfileId: target.id, baseUrl: target.baseUrl, accessToken: '', error: null })
  if (isSharedRefreshStore(target.baseUrl)) {
    const peerToken = await requestTokenFromPeers(canonicalServerKey(target.baseUrl), { timeoutMs: PEER_BOOT_TIMEOUT_MS })
    if (peerToken) return
  }
  await refreshSession(target)
}

export async function disconnectCurrent(revokeRemote = true): Promise<void> {
  clearProactiveRefresh()
  const prevBaseUrl = conn.baseUrl
  const prevSessionId = conn.sessionId
  const prevShared = isSharedRefreshStore(prevBaseUrl)
  if (revokeRemote && conn.accessToken) {
    const useCookie = isSameOriginUrl(prevBaseUrl)
    await fetch(apiUrl('/auth/logout'), {
      method: 'POST',
      credentials: useCookie ? 'include' : 'omit',
      headers: { authorization: `Bearer ${conn.accessToken}` },
    }).catch(() => {})
  }
  if (conn.activeProfileId) {
    await removeProfileFromStorage(conn.activeProfileId)
  }
  if (prevShared) clearSyncMeta(canonicalServerKey(prevBaseUrl))
  accessExpiresAt = 0
  lastRotatedAt = 0
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
  if (prevShared) broadcastAuthLogout(prevBaseUrl, prevSessionId, null)
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
  const tokenUsed = conn.accessToken
  let res = await run(tokenUsed)
  if (res.status === 401 && !init.signal?.aborted) {
    // If another tab synced a fresher token while our request was in flight, retry with it immediately without refreshing.
    let nextToken: string | null =
      conn.status === 'ready' && conn.accessToken && conn.accessToken !== tokenUsed
        ? conn.accessToken
        : await refreshSession(undefined, { staleToken: tokenUsed })
    if (nextToken && !init.signal?.aborted) {
      const retryToken = nextToken
      res = await run(retryToken)
      // Safety net: if a peer still rotated mid-retry, adopt/refresh once more so transient 401 never drops a UI refetch.
      if (res.status === 401 && !init.signal?.aborted) {
        nextToken =
          conn.status === 'ready' && conn.accessToken && conn.accessToken !== retryToken
            ? conn.accessToken
            : await refreshSession(undefined, { staleToken: retryToken })
        if (nextToken && nextToken !== retryToken && !init.signal?.aborted) {
          res = await run(nextToken)
        }
      }
    }
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
  if (signal.aborted) {
    onAbort()
    return
  }
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
