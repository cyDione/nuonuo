/**
 * Unified v1 authentication & session security engine:
 * - Per-device identities with fine-grained RBAC scopes (`chat`, `notices`, `approvals`, `tasks:read`, `tasks:write`, `admin`)
 * - One-time 10-minute pairing codes (with 10-failure brute-force lockout) & QR/URI payloads (`nuonuo://pair?...`)
 * - Owner password authentication via Node native `crypto.scrypt` + per-IP sliding-window rate limiting
 * - Short-lived HMAC-SHA256 signed access tokens (15m, `nna_…`) verified against live session/device revocation state
 * - Single-use rotating refresh tokens (30d, `nnr_…`, sha256-only storage) with full family revocation on replay detection
 * - Short-lived single-path resource tickets (`nnrt_…`, 30s) for sandboxed iframes / media downloads
 * - Security audit log (`auth_audit`)
 */
import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { kvGet, kvSet, newId, schema, type Store } from '@nuonuo/db'
import { desc, eq, isNull } from 'drizzle-orm'

export const PROTOCOL_VERSION = '2.0'
export const API_BASE = '/v1'

export const DEVICE_KINDS = ['phone', 'tablet', 'watch', 'speaker', 'car', 'tv', 'glasses', 'desktop', 'web', 'cli', 'bot', 'other'] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]

export const DISPLAYS = ['full', 'small', 'none'] as const
export type Display = (typeof DISPLAYS)[number]

export const SCOPES = ['chat', 'notices', 'approvals', 'tasks:read', 'tasks:write', 'admin'] as const
export type Scope = (typeof SCOPES)[number]

export const DEFAULT_DEVICE_SCOPES: Scope[] = ['chat', 'notices']
export const FULL_ADMIN_SCOPES: Scope[] = ['chat', 'notices', 'approvals', 'tasks:read', 'tasks:write', 'admin']

export const ACCESS_TOKEN_TTL_MS = 15 * 60_000
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000
export const PAIRING_CODE_TTL_MS = 10 * 60_000
export const RESOURCE_TICKET_TTL_MS = 30_000

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const MAX_PAIR_FAILURES = 10
const MAX_PASSWORD_FAILURES = 8
const PASSWORD_WINDOW_MS = 15 * 60_000
const SIGNING_KEY_KV = 'auth:signing-key'
const PASSWORD_KV = 'auth:password'

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface DeviceInfo {
  name: string
  kind?: DeviceKind | undefined
  platform?: string | undefined
  display?: Display | undefined
}

export interface DeviceView {
  id: string
  name: string
  kind: DeviceKind
  platform?: string
  display: Display
  scopes: Scope[]
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export interface SessionView {
  id: string
  familyId: string
  deviceId: string
  deviceName?: string
  deviceKind?: DeviceKind
  scopes?: Scope[]
  createdAt: number
  rotatedAt: number | null
  expiresAt: number
  revokedAt: number | null
  revokeReason: string | null
  ip: string | null
  userAgent: string | null
}

export interface AuthTokenBundle {
  accessToken: string
  expiresIn: number
  expiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  device: DeviceView
  session: SessionView
}

export interface AuthPrincipal {
  sessionId: string
  deviceId: string
  device: DeviceView
  scopes: Scope[]
  isLocalAdmin?: boolean
}

export interface RequestMeta {
  ip?: string | undefined
  userAgent?: string | undefined
}

interface PairingCodeRecord {
  code: string
  scopes: Scope[]
  name?: string
  expiresAt: number
}

interface StoredPassword {
  algo: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
  hash: string
  updatedAt: number
}

interface AccessPayload {
  v: 1
  sid: string
  did: string
  scopes: Scope[]
  ver: number
  iat: number
  exp: number
}

interface ResourceTicketRecord {
  path: string
  deviceId: string
  sessionId: string
  expiresAt: number
  usesLeft: number
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

export function defaultDisplay(kind: DeviceKind): Display {
  if (kind === 'speaker' || kind === 'car') return 'none'
  if (kind === 'watch' || kind === 'glasses') return 'small'
  return 'full'
}

export function normalizeScopes(scopes?: readonly Scope[], admin = false): Scope[] {
  if (admin || scopes?.includes('admin')) return [...FULL_ADMIN_SCOPES]
  const valid = (scopes ?? DEFAULT_DEVICE_SCOPES).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s))
  return [...new Set<Scope>(['chat', ...valid])]
}

export function hasScope(granted: readonly Scope[], required: Scope): boolean {
  return granted.includes('admin') || granted.includes(required)
}

export function buildPairUri(serverUrl: string, code: string): string {
  const base = serverUrl.replace(/\/+$/, '')
  return `nuonuo://pair?server=${encodeURIComponent(base)}&code=${encodeURIComponent(code)}`
}

export class AuthService {
  private signingKey: Buffer
  private codes: PairingCodeRecord[] = []
  private pairFailures: number[] = []
  private passwordFailures = new Map<string, number[]>()
  private resourceTickets = new Map<string, ResourceTicketRecord>()

  constructor(
    readonly store: Store,
    private opts: { signingKey?: string; now?: () => number; accessTtlMs?: number; refreshTtlMs?: number } = {},
  ) {
    let key = opts.signingKey?.trim()
    if (!key) {
      key = kvGet<string>(store, SIGNING_KEY_KV)
      if (!key) {
        key = randomBytes(32).toString('base64url')
        kvSet(store, SIGNING_KEY_KV, key)
      }
    }
    this.signingKey = Buffer.from(key, 'utf8')
  }

  now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private accessTtl(): number {
    return this.opts.accessTtlMs ?? ACCESS_TOKEN_TTL_MS
  }

  private refreshTtl(): number {
    return this.opts.refreshTtlMs ?? REFRESH_TOKEN_TTL_MS
  }

  audit(event: string, info: { deviceId?: string | null; sessionId?: string | null; ip?: string | null; detail?: string } = {}): void {
    this.store.db.insert(schema.authAudit).values({
      at: this.now(),
      event,
      deviceId: info.deviceId ?? null,
      sessionId: info.sessionId ?? null,
      ip: info.ip ?? null,
      detail: info.detail ?? null,
    }).run()
  }

  listAudit(limit = 100) {
    return this.store.db.select().from(schema.authAudit).orderBy(desc(schema.authAudit.id)).limit(Math.min(Math.max(limit, 1), 500)).all()
  }

  // ── Pairing codes ──────────────────────────────────────────────────────────

  createPairingCode(opts: { scopes?: Scope[]; admin?: boolean; name?: string } = {}): { code: string; expiresAt: number; scopes: Scope[] } {
    const t = this.now()
    this.codes = this.codes.filter(c => c.expiresAt > t)
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
    const scopes = normalizeScopes(opts.scopes, opts.admin)
    this.codes.push({ code: raw, scopes, ...(opts.name ? { name: opts.name.trim().slice(0, 60) } : {}), expiresAt: t + PAIRING_CODE_TTL_MS })
    this.audit('pair_created', { detail: `scopes=${scopes.join(',')}` })
    return { code, expiresAt: t + PAIRING_CODE_TTL_MS, scopes }
  }

  exchangePairingCode(code: string, info: DeviceInfo, meta: RequestMeta = {}): AuthTokenBundle {
    const t = this.now()
    this.pairFailures = this.pairFailures.filter(f => t - f < PAIRING_CODE_TTL_MS)
    if (this.pairFailures.length >= MAX_PAIR_FAILURES) {
      throw new AuthError(429, 'too_many_attempts', '配对码错误次数过多，请在服务端重新生成配对码')
    }
    const wanted = normalizeCode(code)
    const found = this.codes.find(c => c.expiresAt > t && safeEqual(c.code, wanted))
    if (!found) {
      this.pairFailures.push(t)
      if (this.pairFailures.length >= MAX_PAIR_FAILURES) this.codes = []
      this.audit('pair_failed', { ip: meta.ip, detail: 'invalid_or_expired_code' })
      throw new AuthError(401, 'invalid_code', '配对码不对或已过期')
    }
    this.codes = this.codes.filter(c => c !== found)
    const bundle = this.issueDeviceSession(
      { ...info, name: found.name ?? info.name },
      found.scopes,
      meta,
      'pair_exchanged',
    )
    return bundle
  }

  // ── Owner Password (scrypt) ────────────────────────────────────────────────

  hasPassword(): boolean {
    const stored = kvGet<StoredPassword>(this.store, PASSWORD_KV)
    return Boolean(stored?.hash && stored.salt)
  }

  setPassword(password: string, actor?: { deviceId?: string; ip?: string }): void {
    const trimmed = String(password ?? '')
    if (trimmed.length < 8) throw new AuthError(400, 'weak_password', '密码长度至少需要 8 位')
    if (trimmed.length > 256) throw new AuthError(400, 'invalid', '密码长度不能超过 256 位')
    const salt = randomBytes(16).toString('base64url')
    const N = 16384
    const r = 8
    const p = 1
    const hash = scryptSync(trimmed, salt, 64, { N, r, p }).toString('base64url')
    kvSet(this.store, PASSWORD_KV, { algo: 'scrypt', N, r, p, salt, hash, updatedAt: this.now() } satisfies StoredPassword)
    this.passwordFailures.clear()
    this.audit('password_set', { deviceId: actor?.deviceId, ip: actor?.ip })
  }

  clearPassword(actor?: { deviceId?: string; ip?: string }): void {
    this.store.db.delete(schema.kv).where(eq(schema.kv.key, PASSWORD_KV)).run()
    this.passwordFailures.clear()
    this.audit('password_cleared', { deviceId: actor?.deviceId, ip: actor?.ip })
  }

  verifyPassword(password: string): boolean {
    const stored = kvGet<StoredPassword>(this.store, PASSWORD_KV)
    if (!stored?.hash || !stored.salt) return false
    const derived = scryptSync(password, stored.salt, 64, { N: stored.N, r: stored.r, p: stored.p }).toString('base64url')
    return safeEqual(derived, stored.hash)
  }

  resetRateLimits(): void {
    this.pairFailures = []
    this.passwordFailures.clear()
  }

  loginWithPassword(password: string, info: DeviceInfo, meta: RequestMeta = {}): AuthTokenBundle {
    if (!this.hasPassword()) {
      throw new AuthError(400, 'password_not_configured', '服务端未启用密码登录，请使用配对码或在服务端设置密码')
    }
    const t = this.now()
    const bucketKey = meta.ip || 'unknown'
    const recent = (this.passwordFailures.get(bucketKey) ?? []).filter(ts => t - ts < PASSWORD_WINDOW_MS)
    if (recent.length >= MAX_PASSWORD_FAILURES) {
      throw new AuthError(429, 'too_many_attempts', '密码错误次数过多，请 15 分钟后再试或在服务端重置锁定')
    }
    if (!this.verifyPassword(password)) {
      recent.push(t)
      this.passwordFailures.set(bucketKey, recent)
      this.audit('password_failed', { ip: meta.ip })
      throw new AuthError(401, 'invalid_credentials', '密码错误')
    }
    this.passwordFailures.delete(bucketKey)
    return this.issueDeviceSession(info, FULL_ADMIN_SCOPES, meta, 'password_login')
  }

  // ── Session & Token Lifecycle ──────────────────────────────────────────────

  issueDeviceSession(info: DeviceInfo, scopes: Scope[], meta: RequestMeta, auditEvent: string): AuthTokenBundle {
    const t = this.now()
    const kind: DeviceKind = info.kind && (DEVICE_KINDS as readonly string[]).includes(info.kind) ? info.kind : 'other'
    const display: Display = info.display && (DISPLAYS as readonly string[]).includes(info.display) ? info.display : defaultDisplay(kind)
    const normalizedScopes = normalizeScopes(scopes)
    const deviceId = newId('dev')
    const sessionId = newId('asess')
    const familyId = newId('afam')
    const refreshToken = `nnr_${randomBytes(32).toString('base64url')}`
    const refreshExpiresAt = t + this.refreshTtl()
    const name = info.name.trim().slice(0, 60) || '设备'
    const platform = info.platform?.trim().slice(0, 60) || null

    this.store.atomic(() => {
      this.store.db.insert(schema.authDevices).values({
        id: deviceId,
        name,
        kind,
        platform,
        display,
        scopes: normalizedScopes,
        createdAt: t,
        lastSeenAt: t,
        revokedAt: null,
      }).run()
      this.store.db.insert(schema.authSessions).values({
        id: sessionId,
        familyId,
        deviceId,
        refreshHash: sha256(refreshToken),
        retiredHashes: [],
        accessVersion: 1,
        expiresAt: refreshExpiresAt,
        rotatedAt: null,
        revokedAt: null,
        revokeReason: null,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 240) ?? null,
        createdAt: t,
      }).run()
    })

    const { token: accessToken, expiresAt, expiresIn } = this.signAccessToken({
      sid: sessionId,
      did: deviceId,
      scopes: normalizedScopes,
      ver: 1,
    })

    const device = this.getDevice(deviceId)!
    const session = this.getSession(sessionId)!
    this.audit(auditEvent, { deviceId, sessionId, ip: meta.ip, detail: `kind=${kind},scopes=${normalizedScopes.join(',')}` })
    return { accessToken, expiresIn, expiresAt, refreshToken, refreshExpiresAt, device, session }
  }

  private signAccessToken(input: { sid: string; did: string; scopes: Scope[]; ver: number }): { token: string; expiresAt: number; expiresIn: number } {
    const iat = this.now()
    const ttl = this.accessTtl()
    const exp = iat + ttl
    const payload: AccessPayload = { v: 1, sid: input.sid, did: input.did, scopes: input.scopes, ver: input.ver, iat, exp }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const sig = createHmac('sha256', this.signingKey).update(encoded).digest('base64url')
    return { token: `nna_${encoded}.${sig}`, expiresAt: exp, expiresIn: Math.floor(ttl / 1000) }
  }

  authenticateAccessToken(rawToken: string): AuthPrincipal | undefined {
    if (!rawToken.startsWith('nna_')) return undefined
    const body = rawToken.slice(4)
    const dot = body.indexOf('.')
    if (dot <= 0) return undefined
    const encoded = body.slice(0, dot)
    const sig = body.slice(dot + 1)
    const expectedSig = createHmac('sha256', this.signingKey).update(encoded).digest('base64url')
    if (!safeEqual(sig, expectedSig)) return undefined

    let payload: AccessPayload
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AccessPayload
    } catch {
      return undefined
    }
    if (payload.v !== 1 || typeof payload.exp !== 'number' || payload.exp <= this.now()) return undefined

    const sessRow = this.store.db.select().from(schema.authSessions).where(eq(schema.authSessions.id, payload.sid)).get()
    if (!sessRow || sessRow.revokedAt !== null || sessRow.expiresAt <= this.now()) return undefined
    if (sessRow.accessVersion !== payload.ver) return undefined

    const devRow = this.store.db.select().from(schema.authDevices).where(eq(schema.authDevices.id, sessRow.deviceId)).get()
    if (!devRow || devRow.revokedAt !== null) return undefined

    const t = this.now()
    if (!devRow.lastSeenAt || t - devRow.lastSeenAt > 60_000) {
      this.store.db.update(schema.authDevices).set({ lastSeenAt: t }).where(eq(schema.authDevices.id, devRow.id)).run()
    }
    const device = toDeviceView(devRow)
    return { sessionId: sessRow.id, deviceId: device.id, device, scopes: device.scopes }
  }

  /**
   * Single-use refresh rotation with full token-family revocation upon replay detection.
   */
  refresh(refreshToken: string, meta: RequestMeta = {}): AuthTokenBundle {
    if (!refreshToken.startsWith('nnr_')) {
      throw new AuthError(401, 'invalid_refresh', '刷新令牌格式无效，请重新登录')
    }
    const hash = sha256(refreshToken)
    const t = this.now()

    // 1. Check current active hash.
    const active = this.store.db.select().from(schema.authSessions).where(eq(schema.authSessions.refreshHash, hash)).get()
    if (active) {
      if (active.revokedAt !== null) {
        // Replaying an already-revoked session's token revokes the entire family too.
        this.revokeFamily(active.familyId, 'replay_detected', meta.ip)
        throw new AuthError(401, 'token_reused', '检测到失效令牌被重放，会话已吊销，请重新登录')
      }
      if (active.expiresAt <= t) {
        throw new AuthError(401, 'refresh_expired', '登录状态已过期，请重新登录')
      }
      const devRow = this.store.db.select().from(schema.authDevices).where(eq(schema.authDevices.id, active.deviceId)).get()
      if (!devRow || devRow.revokedAt !== null) {
        throw new AuthError(401, 'device_revoked', '该设备已被移除，请重新配对')
      }

      const nextRefresh = `nnr_${randomBytes(32).toString('base64url')}`
      const nextRefreshHash = sha256(nextRefresh)
      const nextVersion = active.accessVersion + 1
      const retired = [...(active.retiredHashes ?? []), active.refreshHash].slice(-64)
      const nextExpiresAt = t + this.refreshTtl()

      this.store.db.update(schema.authSessions).set({
        refreshHash: nextRefreshHash,
        retiredHashes: retired,
        accessVersion: nextVersion,
        rotatedAt: t,
        expiresAt: nextExpiresAt,
        ip: meta.ip ?? active.ip,
        userAgent: meta.userAgent?.slice(0, 240) ?? active.userAgent,
      }).where(eq(schema.authSessions.id, active.id)).run()

      this.store.db.update(schema.authDevices).set({ lastSeenAt: t }).where(eq(schema.authDevices.id, devRow.id)).run()

      const device = toDeviceView({ ...devRow, lastSeenAt: t })
      const { token: accessToken, expiresAt, expiresIn } = this.signAccessToken({
        sid: active.id,
        did: device.id,
        scopes: device.scopes,
        ver: nextVersion,
      })
      const session = this.getSession(active.id)!
      this.audit('token_refreshed', { deviceId: device.id, sessionId: active.id, ip: meta.ip })
      return { accessToken, expiresIn, expiresAt, refreshToken: nextRefresh, refreshExpiresAt: nextExpiresAt, device, session }
    }

    // 2. Replay detection: scan retired hashes across sessions.
    const allSessions = this.store.db.select().from(schema.authSessions).all()
    const replayed = allSessions.find(s => (s.retiredHashes ?? []).some(h => safeEqual(h, hash)))
    if (replayed) {
      this.revokeFamily(replayed.familyId, 'replay_detected', meta.ip)
      throw new AuthError(401, 'token_reused', '检测到旧刷新令牌被重放，出于安全考虑已吊销该会话家族，请重新认证')
    }

    throw new AuthError(401, 'invalid_refresh', '刷新令牌无效或已过期，请重新登录')
  }

  private revokeFamily(familyId: string, reason: string, ip?: string): void {
    const t = this.now()
    const members = this.store.db.select().from(schema.authSessions).where(eq(schema.authSessions.familyId, familyId)).all()
    this.store.db.update(schema.authSessions)
      .set({ revokedAt: t, revokeReason: reason })
      .where(eq(schema.authSessions.familyId, familyId))
      .run()
    this.audit('replay_detected', {
      deviceId: members[0]?.deviceId ?? null,
      sessionId: members[0]?.id ?? null,
      ip: ip ?? null,
      detail: `family=${familyId},revoked=${members.length}`,
    })
  }

  // ── Ephemeral single-path resource tickets ─────────────────────────────────

  createResourceTicket(path: string, principal: AuthPrincipal, maxUses = 4): { ticket: string; expiresAt: number } {
    this.pruneTickets()
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    const ticket = `nnrt_${randomBytes(24).toString('base64url')}`
    const expiresAt = this.now() + RESOURCE_TICKET_TTL_MS
    this.resourceTickets.set(ticket, {
      path: normalizedPath,
      deviceId: principal.deviceId,
      sessionId: principal.sessionId,
      expiresAt,
      usesLeft: Math.max(1, Math.min(maxUses, 10)),
    })
    return { ticket, expiresAt }
  }

  verifyResourceTicket(ticket: string, requestPath: string): AuthPrincipal | undefined {
    this.pruneTickets()
    if (!ticket.startsWith('nnrt_')) return undefined
    const rec = this.resourceTickets.get(ticket)
    if (!rec || rec.expiresAt <= this.now() || rec.usesLeft <= 0) {
      this.resourceTickets.delete(ticket)
      return undefined
    }
    if (rec.path !== requestPath) return undefined
    rec.usesLeft--
    if (rec.usesLeft <= 0) this.resourceTickets.delete(ticket)
    const sess = this.store.db.select().from(schema.authSessions).where(eq(schema.authSessions.id, rec.sessionId)).get()
    if (!sess || sess.revokedAt !== null || sess.expiresAt <= this.now()) return undefined
    const dev = this.store.db.select().from(schema.authDevices).where(eq(schema.authDevices.id, rec.deviceId)).get()
    if (!dev || dev.revokedAt !== null) return undefined
    const view = toDeviceView(dev)
    return { sessionId: sess.id, deviceId: view.id, device: view, scopes: view.scopes }
  }

  private pruneTickets(): void {
    const t = this.now()
    for (const [k, v] of this.resourceTickets) {
      if (v.expiresAt <= t || v.usesLeft <= 0) this.resourceTickets.delete(k)
    }
  }

  // ── Device & session administration ────────────────────────────────────────

  getDevice(id: string): DeviceView | undefined {
    const row = this.store.db.select().from(schema.authDevices).where(eq(schema.authDevices.id, id)).get()
    return row ? toDeviceView(row) : undefined
  }

  listDevices(includeRevoked = false): DeviceView[] {
    const rows = includeRevoked
      ? this.store.db.select().from(schema.authDevices).orderBy(desc(schema.authDevices.createdAt)).all()
      : this.store.db.select().from(schema.authDevices).where(isNull(schema.authDevices.revokedAt)).orderBy(desc(schema.authDevices.createdAt)).all()
    return rows.map(toDeviceView)
  }

  updateDevice(id: string, patch: { name?: string; scopes?: Scope[]; display?: Display }): DeviceView {
    const row = this.store.db.select().from(schema.authDevices).where(eq(schema.authDevices.id, id)).get()
    if (!row || row.revokedAt !== null) throw new AuthError(404, 'missing', '没有这个设备')
    const nextName = patch.name !== undefined ? (patch.name.trim().slice(0, 60) || row.name) : row.name
    const nextScopes = patch.scopes ? normalizeScopes(patch.scopes) : (row.scopes as Scope[])
    const nextDisplay = patch.display ?? (row.display as Display)
    this.store.db.update(schema.authDevices)
      .set({ name: nextName, scopes: nextScopes, display: nextDisplay })
      .where(eq(schema.authDevices.id, id))
      .run()
    return this.getDevice(id)!
  }

  revokeDevice(id: string, actor?: { deviceId?: string; ip?: string }): boolean {
    const row = this.store.db.select().from(schema.authDevices).where(eq(schema.authDevices.id, id)).get()
    if (!row || row.revokedAt !== null) return false
    const t = this.now()
    this.store.atomic(() => {
      this.store.db.update(schema.authDevices).set({ revokedAt: t }).where(eq(schema.authDevices.id, id)).run()
      this.store.db.update(schema.authSessions).set({ revokedAt: t, revokeReason: 'device_revoked' }).where(eq(schema.authSessions.deviceId, id)).run()
    })
    this.audit('device_revoked', { deviceId: id, ip: actor?.ip, detail: actor?.deviceId ? `by=${actor.deviceId}` : undefined })
    return true
  }

  getSession(id: string): SessionView | undefined {
    const row = this.store.db.select().from(schema.authSessions).where(eq(schema.authSessions.id, id)).get()
    if (!row) return undefined
    const dev = this.getDevice(row.deviceId)
    return toSessionView(row, dev)
  }

  listSessions(includeRevoked = false): SessionView[] {
    const rows = includeRevoked
      ? this.store.db.select().from(schema.authSessions).orderBy(desc(schema.authSessions.createdAt)).all()
      : this.store.db.select().from(schema.authSessions).where(isNull(schema.authSessions.revokedAt)).orderBy(desc(schema.authSessions.createdAt)).all()
    const devices = new Map(this.listDevices(true).map(d => [d.id, d]))
    return rows.map(r => toSessionView(r, devices.get(r.deviceId)))
  }

  revokeSession(id: string, reason = 'user_logout', actor?: { deviceId?: string; ip?: string }): boolean {
    const row = this.store.db.select().from(schema.authSessions).where(eq(schema.authSessions.id, id)).get()
    if (!row || row.revokedAt !== null) return false
    this.store.db.update(schema.authSessions).set({ revokedAt: this.now(), revokeReason: reason }).where(eq(schema.authSessions.id, id)).run()
    this.audit('session_revoked', { deviceId: row.deviceId, sessionId: id, ip: actor?.ip, detail: reason })
    return true
  }

  isSessionActive(sessionId: string): boolean {
    const row = this.store.db.select().from(schema.authSessions).where(eq(schema.authSessions.id, sessionId)).get()
    if (!row || row.revokedAt !== null || row.expiresAt <= this.now()) return false
    const dev = this.store.db.select().from(schema.authDevices).where(eq(schema.authDevices.id, row.deviceId)).get()
    return Boolean(dev && dev.revokedAt === null)
  }
}

function toDeviceView(row: typeof schema.authDevices.$inferSelect): DeviceView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DeviceKind,
    ...(row.platform ? { platform: row.platform } : {}),
    display: row.display as Display,
    scopes: row.scopes as Scope[],
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  }
}

function toSessionView(row: typeof schema.authSessions.$inferSelect, dev?: DeviceView): SessionView {
  return {
    id: row.id,
    familyId: row.familyId,
    deviceId: row.deviceId,
    ...(dev ? { deviceName: dev.name, deviceKind: dev.kind, scopes: dev.scopes } : {}),
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
    ip: row.ip,
    userAgent: row.userAgent,
  }
}
