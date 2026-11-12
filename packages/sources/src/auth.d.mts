import type { SourceContext, SourceKind } from './kind'

/** A value, or a function of the source's settings (and context) that gives it. */
type Of<T, C> = T | ((config: C, ctx: SourceContext<C>) => T)

interface OAuthBase<C> {
  /** The service's name on buttons and messages: 「授权 Gmail」. */
  label: string
  clientId: Of<string | undefined, C>
  clientSecret?: Of<string | undefined, C>
  tokenUrl: Of<string, C>
  scopes: Of<string[], C>
  /** Joins scopes (default a space). */
  scopeSeparator?: string
  /** Extra headers on token requests. */
  tokenHeaders?: Record<string, string>
  /** POSTed `token=` on 断开授权, so the grant leaves the account's connected apps. */
  revokeUrl?: Of<string, C>
  /** Shown when 授权 is pressed without a client id. */
  missingClient?: string
  /** Confirmation for 断开授权. */
  disconnectConfirm?: string
  /** After a grant: read the account; the facts returned show on the settings card. */
  onGrant?(ctx: SourceContext<C>, accessToken: string): Promise<Record<string, string> | void> | Record<string, string> | void
  onDisconnect?(ctx: SourceContext<C>): void | Promise<void>
  fetch?: typeof fetch
}

export interface CodeFlow<C> extends OAuthBase<C> {
  flow: 'code'
  authorizeUrl: Of<string, C>
  /** Extra query on the consent page (`access_type: 'offline'`, `prompt: 'consent'`…). */
  authorizeParams?: Of<Record<string, string>, C>
  /** PKCE (S256) is on unless false. */
  pkce?: boolean
  /** Fail the grant when no refresh token comes back. */
  requireRefresh?: boolean
}

export interface DeviceFlow<C> extends OAuthBase<C> {
  flow: 'device'
  deviceUrl: Of<string, C>
  /** A hint appended when the provider refuses the device request, by its error code. */
  deviceErrorHint?(error: string | undefined): string | undefined
}

export interface OAuth<C> {
  /** The kind with 授权 / 重新授权 / 断开授权, `authorized` and the oauth/* endpoints added. */
  source<K extends SourceKind<C>>(kind: K): K & Required<Pick<SourceKind<C>, 'actions' | 'authorized' | 'http'>>
  /** A valid access token, refreshed when needed; throws (status 401) when not authorized. */
  accessToken(ctx: SourceContext<C>): Promise<string>
  disconnect(ctx: SourceContext<C>): Promise<void>
}

export declare function oauth<C>(spec: CodeFlow<C> | DeviceFlow<C>): OAuth<C>

/** A cached app (tenant) token; `reset()` after a 401. */
export interface AppToken { (): Promise<string>; reset(): void }
export declare function appToken(fetchToken: () => Promise<{ token: string; expiresIn?: number }>, opts?: { marginSeconds?: number }): AppToken
