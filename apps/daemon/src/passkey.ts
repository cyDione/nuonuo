/**
 * WebAuthn / Passkey service backed by @simplewebauthn/server (v14) and `auth_passkeys`.
 * Works on secure origins (HTTPS domains and localhost / 127.0.0.1).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { newId, schema } from '@nuonuo/db'
import { desc, eq } from 'drizzle-orm'
import { AuthError, FULL_ADMIN_SCOPES, type AuthService, type AuthTokenBundle, type DeviceInfo, type RequestMeta } from './auth-service'

const CHALLENGE_TTL_MS = 5 * 60_000

interface PendingChallenge {
  challenge: string
  rpID: string
  origin: string
  kind: 'register' | 'login'
  expiresAt: number
}

export interface PasskeyView {
  id: string
  name: string
  deviceType: string | null
  backedUp: boolean
  transports: string[]
  createdAt: number
  lastUsedAt: number | null
}

/** Validates origin for WebAuthn: must be https:// or localhost / 127.0.0.1. */
export function resolveWebAuthnContext(rawOrigin: string | undefined, hostHeader: string | undefined): { rpID: string; origin: string } {
  const candidate = rawOrigin?.trim() || (hostHeader ? `http://${hostHeader.trim()}` : '')
  if (!candidate) throw new AuthError(400, 'invalid_origin', '缺少有效的 Origin 头，无法发起 Passkey 认证')
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new AuthError(400, 'invalid_origin', '无效的 Origin 地址')
  }
  const hostname = url.hostname
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (url.protocol !== 'https:' && !isLocal) {
    throw new AuthError(400, 'insecure_origin', 'Passkey 仅支持 HTTPS 域名或 localhost，局域网明文 HTTP 请改用配对码或密码登录')
  }
  return { rpID: hostname === '127.0.0.1' ? 'localhost' : hostname, origin: url.origin }
}

export class PasskeyService {
  private challenges = new Map<string, PendingChallenge>()

  constructor(private auth: AuthService) {}

  list(): PasskeyView[] {
    return this.auth.store.db.select().from(schema.authPasskeys).orderBy(desc(schema.authPasskeys.createdAt)).all().map(r => ({
      id: r.id,
      name: r.name,
      deviceType: r.deviceType,
      backedUp: r.backedUp,
      transports: r.transports,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }))
  }

  hasPasskeys(): boolean {
    return this.list().length > 0
  }

  remove(id: string, actor?: { deviceId?: string; ip?: string }): boolean {
    const existing = this.auth.store.db.select().from(schema.authPasskeys).where(eq(schema.authPasskeys.id, id)).get()
    if (!existing) return false
    this.auth.store.db.delete(schema.authPasskeys).where(eq(schema.authPasskeys.id, id)).run()
    this.auth.audit('passkey_removed', { deviceId: actor?.deviceId, ip: actor?.ip, detail: existing.name })
    return true
  }

  async beginRegistration(ctx: { rpID: string; origin: string; rpName?: string }) {
    this.pruneChallenges()
    const existing = this.auth.store.db.select().from(schema.authPasskeys).all()
    const options = await generateRegistrationOptions({
      rpName: ctx.rpName ?? 'Nuonuo',
      rpID: ctx.rpID,
      userName: 'owner@nuonuo.local',
      userDisplayName: 'Nuonuo Owner',
      attestationType: 'none',
      excludeCredentials: existing.map(k => ({
        id: k.credentialId,
        transports: k.transports as any,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    })
    const challengeId = newId('pkc')
    this.challenges.set(challengeId, {
      challenge: options.challenge,
      rpID: ctx.rpID,
      origin: ctx.origin,
      kind: 'register',
      expiresAt: this.auth.now() + CHALLENGE_TTL_MS,
    })
    return { challengeId, options }
  }

  async finishRegistration(
    challengeId: string,
    response: RegistrationResponseJSON,
    name: string,
    actor?: { deviceId?: string; ip?: string },
  ): Promise<PasskeyView> {
    const pending = this.takeChallenge(challengeId, 'register')
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
        requireUserVerification: false,
      })
    } catch (error) {
      throw new AuthError(400, 'passkey_verify_failed', `Passkey 注册校验失败：${(error as Error).message}`)
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new AuthError(400, 'passkey_verify_failed', 'Passkey 注册未通过校验')
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    const id = newId('pk')
    const now = this.auth.now()
    const label = name.trim().slice(0, 60) || 'Passkey'
    const transports = Array.isArray(response.response?.transports) ? response.response.transports : []
    this.auth.store.db.insert(schema.authPasskeys).values({
      id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: label,
      createdAt: now,
      lastUsedAt: null,
    }).run()
    this.auth.audit('passkey_registered', { deviceId: actor?.deviceId, ip: actor?.ip, detail: label })
    return { id, name: label, deviceType: credentialDeviceType, backedUp: credentialBackedUp, transports, createdAt: now, lastUsedAt: null }
  }

  async beginLogin(ctx: { rpID: string; origin: string }) {
    this.pruneChallenges()
    const keys = this.auth.store.db.select().from(schema.authPasskeys).all()
    if (!keys.length) throw new AuthError(400, 'passkey_not_configured', '服务端尚未绑定 Passkey')
    const options = await generateAuthenticationOptions({
      rpID: ctx.rpID,
      userVerification: 'preferred',
      allowCredentials: keys.map(k => ({
        id: k.credentialId,
        transports: k.transports as any,
      })),
    })
    const challengeId = newId('pkc')
    this.challenges.set(challengeId, {
      challenge: options.challenge,
      rpID: ctx.rpID,
      origin: ctx.origin,
      kind: 'login',
      expiresAt: this.auth.now() + CHALLENGE_TTL_MS,
    })
    return { challengeId, options }
  }

  async finishLogin(
    challengeId: string,
    response: AuthenticationResponseJSON,
    device: DeviceInfo,
    meta: RequestMeta = {},
  ): Promise<AuthTokenBundle> {
    const pending = this.takeChallenge(challengeId, 'login')
    const stored = this.auth.store.db.select().from(schema.authPasskeys).where(eq(schema.authPasskeys.credentialId, response.id)).get()
    if (!stored) throw new AuthError(401, 'passkey_unknown', '未找到对应的 Passkey 凭据')

    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
        requireUserVerification: false,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
          counter: stored.counter,
          transports: stored.transports as any,
        },
      })
    } catch (error) {
      this.auth.audit('passkey_failed', { ip: meta.ip, detail: (error as Error).message })
      throw new AuthError(401, 'passkey_verify_failed', `Passkey 认证失败：${(error as Error).message}`)
    }
    if (!verification.verified) {
      this.auth.audit('passkey_failed', { ip: meta.ip, detail: 'unverified' })
      throw new AuthError(401, 'passkey_verify_failed', 'Passkey 认证未通过')
    }
    this.auth.store.db.update(schema.authPasskeys).set({
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: this.auth.now(),
    }).where(eq(schema.authPasskeys.id, stored.id)).run()

    return this.auth.issueDeviceSession(device, FULL_ADMIN_SCOPES, meta, 'passkey_login')
  }

  private takeChallenge(id: string, kind: 'register' | 'login'): PendingChallenge {
    this.pruneChallenges()
    const item = this.challenges.get(id)
    this.challenges.delete(id)
    if (!item || item.kind !== kind || item.expiresAt <= this.auth.now()) {
      throw new AuthError(401, 'challenge_expired', 'Passkey 认证挑战已失效，请重试')
    }
    return item
  }

  private pruneChallenges(): void {
    const t = this.auth.now()
    for (const [k, v] of this.challenges) {
      if (v.expiresAt <= t) this.challenges.delete(k)
    }
  }
}
