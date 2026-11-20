/**
 * @nuonuo/client — zero-dependency SDK for Nuonuo's unified public protocol `/v1/*` (docs/11-client-protocol.md).
 *
 * Works in Node 18+, Deno, Bun, browsers, Electron, React Native, and embedded webviews (needs only `fetch`,
 * `ReadableStream`, and `TextDecoder`).
 *
 *   const auth = await NuonuoClient.pair('https://nuonuo.example.com', 'K7QF-2M9D', { name: 'My App', kind: 'phone' })
 *   const nuonuo = new NuonuoClient({
 *     baseUrl: 'https://nuonuo.example.com',
 *     accessToken: auth.accessToken,
 *     refreshToken: auth.refreshToken,
 *     onTokensUpdated: tokens => saveToKeychain(tokens),
 *   })
 *   const reply = await nuonuo.ask('明天要带伞吗？')
 */

export const PROTOCOL_VERSION = '2.0'
export const API_BASE = '/v1'

export type DeviceKind = 'phone' | 'tablet' | 'watch' | 'speaker' | 'car' | 'tv' | 'glasses' | 'desktop' | 'web' | 'cli' | 'bot' | 'other'
export type Display = 'full' | 'small' | 'none'
export type Scope = 'chat' | 'notices' | 'approvals' | 'tasks:read' | 'tasks:write' | 'admin'

export interface DeviceInfo { name: string; kind?: DeviceKind; platform?: string; display?: Display }

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  platform?: string
  display: Display
  scopes: Scope[]
  createdAt: number
  lastSeenAt: number | null
  revokedAt?: number | null
}

export interface SessionInfo {
  id: string
  familyId: string
  deviceId: string
  createdAt: number
  rotatedAt: number | null
  expiresAt: number
  revokedAt: number | null
  ip: string | null
  userAgent: string | null
}

export interface AuthTokenBundle {
  protocol: string
  accessToken: string
  expiresIn: number
  expiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  device: Device
  session: SessionInfo
}

export interface AuthMethods {
  protocol: string
  server: { name: 'nuonuo'; version: string }
  webUi: boolean
  methods: { pairing: boolean; password: boolean; passkey: boolean; passkeyConfigured?: boolean }
}

export interface Hello {
  protocol: string
  server: { name: 'nuonuo'; version: string; webUi: boolean }
  assistant: { name: string; avatar: string; color: string; language: string }
  device: Device
  sessionId: string
  mainConversationId: string
  features: string[]
  limits: { maxUpload: number; maxText: number }
}

export interface Conversation {
  id: string
  title: string
  main: boolean
  pinned: boolean
  archived?: boolean
  updatedAt: number
  unread?: number
  lastMessage?: string | null
}

export interface Attachment { id: string; name: string; mime: string; size: number }

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system' | 'event'
  text: string
  content: string
  createdAt: number
  attachments: Attachment[]
  taskId: string | null
  task: { id: string; title: string; state: 'working' | 'waiting' | 'done' } | null
  final: boolean
  device: { id: string; name: string; kind: string } | null
  recalled: boolean
}

export interface Approval {
  id: string
  ticketId: string
  taskId: string
  task: string | null
  tool: string
  action: string
  risk: string
  reason: string
  createdAt: number
}

export interface Notice { id: string; kind: string; title: string; body: string; silent: boolean; hash?: string }

export type ClientEvent =
  | { type: 'ready'; protocol: string; device: string; sessionId?: string }
  | { type: 'message'; op: 'created' | 'updated'; conversationId: string; messageId: string; message?: Message }
  | { type: 'reply.delta'; conversationId: string; callId: string; text: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'notice'; notice: Notice }
  | { type: 'approval'; op: 'requested'; approval: Approval }
  | { type: 'approval'; op: 'resolved'; id: string }
  | { type: 'raw'; event: string; data: Record<string, unknown> }

export class NuonuoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'NuonuoError'
  }
}

export interface ClientOptions {
  /** Base server URL, e.g. `https://nuonuo.example.com` or `http://127.0.0.1:7420` (without `/v1`). */
  baseUrl: string
  /** Current short-lived Access Token (`nna_…`). Optional if `refreshToken` is provided (will refresh on first request). */
  accessToken?: string
  /** Rotating Refresh Token (`nnr_…`). Automatically rotated when access token expires. */
  refreshToken?: string
  /** Called whenever a refresh rotation yields new tokens — persist the new `refreshToken` securely! */
  onTokensUpdated?: (bundle: AuthTokenBundle) => void | Promise<void>
  /** Called when the refresh token is revoked or replayed and re-authentication is required. */
  onAuthLost?: (error: NuonuoError) => void
  fetch?: typeof fetch
}

const trim = (url: string) => url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')

/** Parses a `nuonuo://pair?server=...&code=...` URI (from QR code or CLI). */
export function parsePairUri(input: string): { server: string; code: string } | null {
  const raw = input.trim()
  if (!/^nuonuo:\/\/pair\?/i.test(raw)) return null
  try {
    const u = new URL(raw)
    const server = u.searchParams.get('server')?.trim()
    const code = u.searchParams.get('code')?.trim()
    if (!server || !code) return null
    return { server: trim(server), code }
  } catch {
    return null
  }
}

async function rawRequest<T>(f: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const res = await f(url, init)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown
  try { data = text ? JSON.parse(text) : undefined } catch { data = undefined }
  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error
    throw new NuonuoError(res.status, error?.code ?? 'http', error?.message ?? `HTTP ${res.status}`)
  }
  return data as T
}

/** Splits an SSE byte stream into events. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string; id?: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
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
        let id: string | undefined
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
          else if (field === 'id') id = value
        }
        yield { event, data: data.join('\n'), ...(id !== undefined ? { id } : {}) }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export class NuonuoClient {
  readonly baseUrl: string
  private accessToken: string
  private refreshToken: string | undefined
  private refreshing: Promise<AuthTokenBundle> | null = null
  private onTokensUpdated: ClientOptions['onTokensUpdated']
  private onAuthLost: ClientOptions['onAuthLost']
  private f: typeof fetch

  constructor(options: ClientOptions) {
    this.baseUrl = trim(options.baseUrl)
    this.accessToken = options.accessToken ?? ''
    this.refreshToken = options.refreshToken
    this.onTokensUpdated = options.onTokensUpdated
    this.onAuthLost = options.onAuthLost
    this.f = options.fetch ?? ((...args) => fetch(...args))
  }

  /** Discovers server version and enabled authentication methods (`pairing`, `password`, `passkey`). */
  static discover(baseUrl: string, options: { fetch?: typeof fetch } = {}): Promise<AuthMethods> {
    const f = options.fetch ?? ((...args) => fetch(...args))
    return rawRequest(f, `${trim(baseUrl)}${API_BASE}/auth/methods`, { method: 'GET' })
  }

  /** Exchanges a one-time pairing code (from `nuonuo pair` or QR code) for rotating session tokens. */
  static pair(baseUrl: string, code: string, device: DeviceInfo, options: { fetch?: typeof fetch } = {}): Promise<AuthTokenBundle> {
    const f = options.fetch ?? ((...args) => fetch(...args))
    return rawRequest(f, `${trim(baseUrl)}${API_BASE}/auth/pair/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device }),
    })
  }

  /** Authenticates with the server's Owner password (`nuonuo auth set-password`). */
  static loginWithPassword(baseUrl: string, password: string, device: DeviceInfo, options: { fetch?: typeof fetch } = {}): Promise<AuthTokenBundle> {
    const f = options.fetch ?? ((...args) => fetch(...args))
    return rawRequest(f, `${trim(baseUrl)}${API_BASE}/auth/password/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, device }),
    })
  }

  /** Single-flight refresh token rotation; concurrent 401s share one refresh call so rotation never triggers replay detection. */
  async refresh(): Promise<AuthTokenBundle> {
    if (this.refreshing) return this.refreshing
    if (!this.refreshToken) throw new NuonuoError(401, 'unauthorized', '缺少刷新令牌，请重新认证')
    const run = (async () => {
      try {
        const bundle = await rawRequest<AuthTokenBundle>(this.f, `${this.baseUrl}${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        })
        this.accessToken = bundle.accessToken
        this.refreshToken = bundle.refreshToken
        await this.onTokensUpdated?.(bundle)
        return bundle
      } catch (error) {
        if (error instanceof NuonuoError && error.status === 401) {
          this.accessToken = ''
          this.refreshToken = undefined
          this.onAuthLost?.(error)
        }
        throw error
      } finally {
        this.refreshing = null
      }
    })()
    this.refreshing = run
    return run
  }

  private async ensureToken(): Promise<string> {
    if (!this.accessToken && this.refreshToken) await this.refresh()
    return this.accessToken
  }

  /** Generic authenticated JSON call to any `/v1/*` endpoint, with automatic single-flight refresh on 401. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.ensureToken()
    const url = `${this.baseUrl}${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
    const run = (t: string) => rawRequest<T>(this.f, url, {
      method,
      headers: {
        authorization: `Bearer ${t}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    try {
      return await run(token)
    } catch (error) {
      if (error instanceof NuonuoError && error.status === 401 && this.refreshToken) {
        const next = await this.refresh()
        return run(next.accessToken)
      }
      throw error
    }
  }

  hello(): Promise<Hello> { return this.request('GET', '/hello') }

  async conversations(opts: { archived?: boolean } = {}): Promise<Conversation[]> {
    const qs = opts.archived ? '?archived=1' : ''
    return (await this.request<{ conversations: Conversation[] }>('GET', `/conversations${qs}`)).conversations
  }

  async createConversation(title?: string): Promise<Conversation> {
    return (await this.request<{ conversation: Conversation }>('POST', '/conversations', title ? { title } : {})).conversation
  }

  async messages(conversation = 'main', opts: { after?: string; limit?: number } = {}): Promise<Message[]> {
    const q = new URLSearchParams()
    if (opts.after) q.set('after', opts.after)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return (await this.request<{ messages: Message[] }>('GET', `/conversations/${encodeURIComponent(conversation)}/messages${qs ? `?${qs}` : ''}`)).messages
  }

  async send(text: string, opts: { conversation?: string; attachments?: string[]; clientId?: string } = {}): Promise<Message> {
    const clientId = opts.clientId ?? randomId()
    return (await this.request<{ message: Message }>('POST', `/conversations/${encodeURIComponent(opts.conversation ?? 'main')}/messages`, {
      text,
      clientId,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    })).message
  }

  async waitForReply(after: Message, opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal; onProgress?: (m: Message) => void } = {}): Promise<Message> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
    let cursor = after.id
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new NuonuoError(0, 'aborted', '已取消')
      const next = await this.messages(after.conversationId, { after: cursor, limit: 50 })
      for (const m of next) {
        if (m.role !== 'assistant' || !m.text.trim()) continue
        if (m.final) return m
        opts.onProgress?.(m)
      }
      if (next.length) cursor = next[next.length - 1]!.id
      await sleep(opts.intervalMs ?? 1_500, opts.signal)
    }
    throw new NuonuoError(0, 'timeout', '等回复超时了（它可能在做一件较长的事，稍后用 messages() 查看）')
  }

  async ask(text: string, opts: { conversation?: string; timeoutMs?: number; signal?: AbortSignal; onProgress?: (m: Message) => void } = {}): Promise<Message> {
    const sent = await this.send(text, opts.conversation ? { conversation: opts.conversation } : {})
    return this.waitForReply(sent, {
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    })
  }

  markRead(conversation = 'main'): Promise<{ ok: true }> {
    return this.request('POST', `/conversations/${encodeURIComponent(conversation)}/read`)
  }

  async upload(file: Blob, name: string, conversationId?: string): Promise<Attachment> {
    const token = await this.ensureToken()
    const run = (t: string) => {
      const form = new FormData()
      form.append('file', file, name)
      if (conversationId) form.append('conversation', conversationId)
      return rawRequest<{ upload: Attachment }>(this.f, `${this.baseUrl}${API_BASE}/uploads`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t}` },
        body: form,
      })
    }
    try {
      return (await run(token)).upload
    } catch (error) {
      if (error instanceof NuonuoError && error.status === 401 && this.refreshToken) {
        const next = await this.refresh()
        return (await run(next.accessToken)).upload
      }
      throw error
    }
  }

  /** Requests a 30-second single-path resource ticket for sandboxed iframes or browser downloads. */
  resourceTicket(path: string, maxUses = 4): Promise<{ ticket: string; expiresAt: number }> {
    return this.request('POST', '/auth/resource-ticket', { path, maxUses })
  }

  async approvals(): Promise<Approval[]> {
    return (await this.request<{ approvals: Approval[] }>('GET', '/approvals')).approvals
  }

  decide(id: string, approve: boolean, opts: { note?: string; scope?: 'once' | 'task' | 'always' } = {}): Promise<{ approval: Approval }> {
    return this.request('POST', `/approvals/${encodeURIComponent(id)}`, { approve, ...opts })
  }

  async devices(): Promise<Device[]> {
    return (await this.request<{ devices: Device[] }>('GET', '/devices')).devices
  }

  async logout(): Promise<void> {
    try {
      await this.request('POST', '/auth/logout')
    } finally {
      this.accessToken = ''
      this.refreshToken = undefined
    }
  }

  /** Live SSE stream over `/v1/events` using fetch streaming + automatic token refresh & reconnect. */
  async *events(opts: { conversation?: string; signal?: AbortSignal; reconnect?: boolean } = {}): AsyncGenerator<ClientEvent> {
    let delay = 1_000
    for (;;) {
      if (opts.signal?.aborted) return
      try {
        const token = await this.ensureToken()
        const url = `${this.baseUrl}${API_BASE}/events${opts.conversation ? `?conversation=${encodeURIComponent(opts.conversation)}` : ''}`
        let res = await this.f(url, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, ...(opts.signal ? { signal: opts.signal } : {}) })
        if (res.status === 401 && this.refreshToken) {
          const next = await this.refresh()
          res = await this.f(url, { headers: { authorization: `Bearer ${next.accessToken}`, accept: 'text/event-stream' }, ...(opts.signal ? { signal: opts.signal } : {}) })
        }
        if (res.status === 401 || res.status === 403) throw new NuonuoError(res.status, 'unauthorized', '会话无效或已被吊销，请重新认证')
        if (!res.ok || !res.body) throw new NuonuoError(res.status, 'http', `HTTP ${res.status}`)
        delay = 1_000
        for await (const raw of parseSSE(res.body, opts.signal)) {
          const event = toEvent(raw.event, raw.data)
          if (event) yield event
        }
      } catch (error) {
        if (opts.signal?.aborted) return
        if (error instanceof NuonuoError && (error.status === 401 || error.status === 403)) throw error
        if (opts.reconnect === false) throw error
      }
      if (opts.reconnect === false) return
      await sleep(delay, opts.signal).catch(() => undefined)
      delay = Math.min(delay * 2, 30_000)
    }
  }
}

function toEvent(event: string, data: string): ClientEvent | undefined {
  let d: any
  try { d = JSON.parse(data) } catch { return undefined }
  if (event === 'ready') return { type: 'ready', protocol: d.protocol, device: d.device, sessionId: d.sessionId }
  if (event === 'approval') {
    return d.op === 'requested'
      ? { type: 'approval', op: 'requested', approval: d.approval }
      : { type: 'approval', op: 'resolved', id: d.id }
  }
  if (event === 'message' && d && typeof d.type === 'string') {
    if (d.type === 'message.created' || d.type === 'message.updated') {
      return { type: 'message', op: d.type === 'message.created' ? 'created' : 'updated', conversationId: d.conversationId, messageId: d.messageId, ...(d.message ? { message: d.message } : {}) }
    }
    if (d.type === 'reply.delta') return { type: 'reply.delta', conversationId: d.conversationId, callId: d.callId, text: d.text }
    if (d.type === 'conversation.updated') return { type: 'conversation', conversationId: d.conversationId }
    if (d.type === 'notice') return { type: 'notice', notice: d }
    return { type: 'raw', event: d.type, data: d }
  }
  return undefined
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new NuonuoError(0, 'aborted', '已取消')); return }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(new NuonuoError(0, 'aborted', '已取消')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
