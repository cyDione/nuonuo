/**
 * @nuonuo/client — the SDK for Nuonuo's client protocol v1 (docs/11-client-protocol.md).
 *
 * No dependencies: it needs only `fetch`, `ReadableStream` and `TextDecoder`, so the same file runs in Node 18+, Deno, Bun,
 * browsers, React Native (with a streaming fetch) and webviews on watches, TVs and cars.
 *
 *   const { token } = await NuonuoClient.pair('http://192.168.1.5:7420', 'K7QF-2M9D', { name: '客厅音箱', kind: 'speaker' })
 *   const nuonuo = new NuonuoClient({ baseUrl: 'http://192.168.1.5:7420', token })
 *   const reply = await nuonuo.ask('明天要带伞吗？', { onProgress: m => speak(m.text) })
 */

export const PROTOCOL_VERSION = '1.0'
export const CLIENT_BASE = '/client/v1'

export type DeviceKind = 'phone' | 'tablet' | 'watch' | 'speaker' | 'car' | 'tv' | 'glasses' | 'desktop' | 'bot' | 'other'
/** `none`: no screen, answers are read aloud. `small`: a watch-sized screen. `full`: a normal chat screen. */
export type Display = 'full' | 'small' | 'none'
export type Scope = 'chat' | 'notices' | 'approvals'

export interface DeviceInfo { name: string; kind?: DeviceKind; platform?: string; display?: Display }

export interface Device {
  id: string; name: string; kind: DeviceKind; platform?: string; display: Display; scopes: Scope[]; createdAt: number; lastSeenAt: number | null
}

export interface Hello {
  protocol: string
  server: { name: 'nuonuo'; version: string }
  assistant: { name: string; avatar: string; color: string; language: string }
  device: Device
  mainConversationId: string
  features: string[]
  limits: { maxUpload: number; maxText: number }
}

export interface Conversation { id: string; title: string; main: boolean; pinned: boolean; updatedAt: number; unread: number; lastMessage: string | null }

export interface Attachment { id: string; name: string; mime: string; size: number }

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: number
  attachments: Attachment[]
  taskId: string | null
  /** The task this message is about; `working` means more messages about it will follow. */
  task: { id: string; title: string; state: 'working' | 'waiting' | 'done' } | null
  /** Assistant messages: `true` when it answers the request, `false` for "I'm on it" while a task works. */
  final: boolean
  device: { id: string; name: string; kind: string } | null
  recalled: boolean
}

export interface Approval { id: string; taskId: string; task: string | null; tool: string; action: string; risk: string; reason: string; createdAt: number }
export interface Notice { id: string; kind: string; title: string; body: string; silent: boolean }

export type ClientEvent =
  | { type: 'ready'; protocol: string; device: string }
  | { type: 'message'; op: 'created' | 'updated'; message: Message }
  | { type: 'reply.delta'; conversationId: string; replyId: string; text: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'notice'; notice: Notice }
  | { type: 'approval'; op: 'requested'; approval: Approval }
  | { type: 'approval'; op: 'resolved'; id: string }

export class NuonuoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'NuonuoError' }
}

export interface ClientOptions {
  /** Where the service is, e.g. `http://192.168.1.5:7420` (no `/client/v1`). */
  baseUrl: string
  /** The device token from `pair()`. */
  token: string
  fetch?: typeof fetch
}

const trim = (url: string) => url.replace(/\/+$/, '').replace(/\/client\/v1$/, '')

async function request<T>(f: typeof fetch, url: string, init: RequestInit): Promise<T> {
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
        let event = 'message'; let id: string | undefined; const data: string[] = []
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
  } finally { signal?.removeEventListener('abort', onAbort) }
}

export class NuonuoClient {
  readonly baseUrl: string
  private token: string
  private f: typeof fetch

  constructor(options: ClientOptions) {
    this.baseUrl = trim(options.baseUrl)
    this.token = options.token
    this.f = options.fetch ?? ((...args) => fetch(...args))
  }

  /** Trades a one-time pairing code (from `nuonuo pair` on the computer) for this device's token. Keep the token safe. */
  static async pair(baseUrl: string, code: string, device: DeviceInfo, options: { fetch?: typeof fetch } = {}): Promise<{ token: string; device: Device; protocol: string }> {
    const f = options.fetch ?? ((...args) => fetch(...args))
    return request(f, `${trim(baseUrl)}${CLIENT_BASE}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device }) })
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return request(this.f, `${this.baseUrl}${CLIENT_BASE}${path}`, {
      method, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  /** Who is on the other side, what this device may do, and the main conversation's id. */
  hello(): Promise<Hello> { return this.call('GET', '/hello') }

  async conversations(): Promise<Conversation[]> { return (await this.call<{ conversations: Conversation[] }>('GET', '/conversations')).conversations }

  async createConversation(title?: string): Promise<Conversation> {
    return (await this.call<{ conversation: Conversation }>('POST', '/conversations', title ? { title } : {})).conversation
  }

  /** The latest messages of a conversation (`main` for the main one), or those after a message id. */
  async messages(conversation = 'main', opts: { after?: string; limit?: number } = {}): Promise<Message[]> {
    const q = new URLSearchParams()
    if (opts.after) q.set('after', opts.after)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return (await this.call<{ messages: Message[] }>('GET', `/conversations/${encodeURIComponent(conversation)}/messages${qs ? `?${qs}` : ''}`)).messages
  }

  /**
   * Sends a message. Pass `clientId` (any unique string) so a retry after a dropped connection does not send it twice.
   * The answer arrives later as a `message` event, or with `ask()` / `waitForReply()`.
   */
  async send(text: string, opts: { conversation?: string; attachments?: string[]; clientId?: string } = {}): Promise<Message> {
    const clientId = opts.clientId ?? randomId()
    return (await this.call<{ message: Message }>('POST', `/conversations/${encodeURIComponent(opts.conversation ?? 'main')}/messages`,
      { text, clientId, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) })).message
  }

  /**
   * Waits for the assistant's answer to a message (polling, so it works on any network). "I'm on it" messages sent while a
   * task works go to `onProgress`; the promise resolves with the first final one.
   */
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

  /** Send and wait for the answer: the one call a speaker, a shortcut or a script needs. */
  async ask(text: string, opts: { conversation?: string; timeoutMs?: number; signal?: AbortSignal; onProgress?: (m: Message) => void } = {}): Promise<Message> {
    const sent = await this.send(text, opts.conversation ? { conversation: opts.conversation } : {})
    return this.waitForReply(sent, { ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) })
  }

  markRead(conversation = 'main'): Promise<{ ok: true }> { return this.call('POST', `/conversations/${encodeURIComponent(conversation)}/read`) }

  /** Uploads a file to attach to the next `send()` (by the returned id). */
  async upload(file: Blob, name: string): Promise<Attachment> {
    const form = new FormData()
    form.append('file', file, name)
    return (await request<{ upload: Attachment }>(this.f, `${this.baseUrl}${CLIENT_BASE}/uploads`, { method: 'POST', headers: { authorization: `Bearer ${this.token}` }, body: form })).upload
  }

  /** The URL and header to download an attachment with. */
  attachmentUrl(id: string): { url: string; headers: Record<string, string> } {
    return { url: `${this.baseUrl}${CLIENT_BASE}/uploads/${encodeURIComponent(id)}`, headers: { authorization: `Bearer ${this.token}` } }
  }

  async approvals(): Promise<Approval[]> { return (await this.call<{ approvals: Approval[] }>('GET', '/approvals')).approvals }
  decide(id: string, approve: boolean, note?: string): Promise<{ ok: true }> { return this.call('POST', `/approvals/${encodeURIComponent(id)}`, { approve, ...(note ? { note } : {}) }) }

  /** Unpairs this device: its token stops working. */
  forget(): Promise<void> { return this.call('DELETE', '/session') }

  /**
   * Live events. Reconnects by itself (backing off up to 30 s) until `signal` aborts; after a reconnect, catch up with
   * `messages(conversation, { after: lastSeenId })` — events are not replayed. A 401 (device removed) ends it with an error.
   */
  async *events(opts: { conversation?: string; signal?: AbortSignal; reconnect?: boolean } = {}): AsyncGenerator<ClientEvent> {
    let delay = 1_000
    for (;;) {
      if (opts.signal?.aborted) return
      try {
        const url = `${this.baseUrl}${CLIENT_BASE}/events${opts.conversation ? `?conversation=${encodeURIComponent(opts.conversation)}` : ''}`
        const res = await this.f(url, { headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' }, ...(opts.signal ? { signal: opts.signal } : {}) })
        if (res.status === 401 || res.status === 403) throw new NuonuoError(res.status, 'unauthorized', '设备令牌无效或已被移除：请重新配对')
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
  switch (event) {
    case 'ready': return { type: 'ready', protocol: d.protocol, device: d.device }
    case 'message': return { type: 'message', op: d.op, message: d.message }
    case 'reply.delta': return { type: 'reply.delta', conversationId: d.conversationId, replyId: d.replyId, text: d.text }
    case 'conversation': return { type: 'conversation', conversationId: d.conversationId }
    case 'notice': return { type: 'notice', notice: d }
    case 'approval': return d.op === 'requested' ? { type: 'approval', op: 'requested', approval: d.approval } : { type: 'approval', op: 'resolved', id: d.id }
    default: return undefined // `ping` and events newer than this SDK
  }
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
