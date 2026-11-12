/**
 * The client protocol (docs/11-client-protocol.md): how any device — a phone app, a watch, a speaker, a car, a shortcut, a
 * script — talks to 糯糯. It is a small, versioned surface under `/client/v1`, separate from the web UI's internal `/api`
 * (which changes whenever the UI does).
 *
 * A device gets its own token by pairing: the owner makes a one-time code (`nuonuo pair`, or `POST /api/devices/pair`),
 * the device trades it for a token at `POST /client/v1/pair`. A device token only opens `/client/v1`, only with the scopes
 * it was paired with, and the owner can revoke it at any time; the owner token never needs to leave the computer.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { ModelError } from '@nuonuo/models'
import { kvGet, kvSet, newId, type Store } from '@nuonuo/db'
import { persona, type SendingDevice } from '@nuonuo/core'
import { VERSION } from './config'
import type { Conversations, Message } from './conversations'
import { EventMapper } from './events'
import type { Runtime } from './runtime'
import { MAX_UPLOAD, type Uploads } from './uploads'

/** Major version in the path; minor grows with additive changes only (new fields, endpoints, events). */
export const PROTOCOL = { version: '1.0', major: 1 } as const
export const CLIENT_BASE = '/client/v1'

export const DEVICE_KINDS = ['phone', 'tablet', 'watch', 'speaker', 'car', 'tv', 'glasses', 'desktop', 'bot', 'other'] as const
export const DISPLAYS = ['full', 'small', 'none'] as const
/** `chat`: talk and read the chats. `notices`: receive the notices the desktop shows. `approvals`: answer 「要不要做」. */
export const SCOPES = ['chat', 'notices', 'approvals'] as const
export type Scope = (typeof SCOPES)[number]
export const DEFAULT_SCOPES: Scope[] = ['chat', 'notices']

/** Features a client can check in `hello` before using them. */
export const FEATURES = ['messages', 'events.sse', 'reply.delta', 'uploads', 'notices', 'approvals', 'idempotency'] as const

export interface Device {
  id: string
  name: string
  kind: (typeof DEVICE_KINDS)[number]
  platform?: string
  display: (typeof DISPLAYS)[number]
  scopes: Scope[]
  createdAt: number
  lastSeenAt: number | null
  /** sha256 of the token; the token itself is shown to the device once and never stored. */
  tokenHash: string
}
export type DeviceView = Omit<Device, 'tokenHash'>

interface PairingCode { code: string; scopes: Scope[]; name?: string; expiresAt: number }

const KV = 'clients:devices'
const CODE_TTL = 10 * 60_000
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const MAX_FAILURES = 10
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

export class ClientError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, readonly code: string, message: string) { super(message) }
}

/** Paired devices (kept in the kv table) and the pairing codes waiting to be used (memory only: a restart voids them). */
export class Devices {
  private codes: PairingCode[] = []
  private failures: number[] = []

  constructor(private store: Store, private now: () => number = Date.now) {}

  private all(): Device[] { return kvGet<Device[]>(this.store, KV) ?? [] }
  private save(list: Device[]) { kvSet(this.store, KV, list) }
  static view({ tokenHash: _hash, ...rest }: Device): DeviceView { return rest }

  list(): DeviceView[] { return this.all().map(Devices.view) }

  /** A one-time code for one device, valid for ten minutes. */
  createCode(opts: { scopes?: Scope[]; name?: string } = {}): { code: string; expiresAt: number; scopes: Scope[] } {
    const t = this.now()
    this.codes = this.codes.filter(c => c.expiresAt > t)
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
    const scopes = [...new Set<Scope>(['chat', ...(opts.scopes ?? DEFAULT_SCOPES)])]
    this.codes.push({ code: raw, scopes, ...(opts.name ? { name: opts.name } : {}), expiresAt: t + CODE_TTL })
    return { code, expiresAt: t + CODE_TTL, scopes }
  }

  /** Trades a code for a device token. Too many wrong codes void every waiting code (against guessing). */
  pair(code: string, info: { name: string; kind: Device['kind']; platform?: string; display?: Device['display'] }): { token: string; device: DeviceView } {
    const t = this.now()
    this.failures = this.failures.filter(f => t - f < CODE_TTL)
    if (this.failures.length >= MAX_FAILURES) throw new ClientError(429, 'too_many_attempts', '配对码错误次数太多，请在电脑上重新生成配对码')
    const wanted = normalizeCode(code)
    const found = this.codes.find(c => c.expiresAt > t && same(c.code, wanted))
    if (!found) {
      this.failures.push(t)
      if (this.failures.length >= MAX_FAILURES) this.codes = []
      throw new ClientError(401, 'invalid_code', '配对码不对或已过期')
    }
    this.codes = this.codes.filter(c => c !== found)
    const token = `nnd_${randomBytes(32).toString('base64url')}`
    const device: Device = {
      id: newId('dev'), name: (found.name ?? info.name).trim().slice(0, 60) || '设备', kind: info.kind,
      ...(info.platform ? { platform: info.platform.slice(0, 60) } : {}),
      display: info.display ?? defaultDisplay(info.kind), scopes: found.scopes, createdAt: t, lastSeenAt: t, tokenHash: sha(token),
    }
    this.save([...this.all(), device])
    return { token, device: Devices.view(device) }
  }

  /** The device a token belongs to; marks it seen (at most once a minute, to keep writes down). */
  authenticate(token: string): Device | undefined {
    if (!token.startsWith('nnd_')) return undefined
    const hash = sha(token)
    const list = this.all()
    const device = list.find(d => same(d.tokenHash, hash))
    if (!device) return undefined
    const t = this.now()
    if (!device.lastSeenAt || t - device.lastSeenAt > 60_000) { device.lastSeenAt = t; this.save(list) }
    return device
  }

  update(id: string, patch: { name?: string; scopes?: Scope[]; display?: Device['display'] }): DeviceView {
    const list = this.all()
    const device = list.find(d => d.id === id)
    if (!device) throw new ClientError(404, 'missing', '没有这个设备')
    if (patch.name !== undefined) device.name = patch.name.trim().slice(0, 60) || device.name
    if (patch.scopes) device.scopes = [...new Set<Scope>(['chat', ...patch.scopes])]
    if (patch.display) device.display = patch.display
    this.save(list)
    return Devices.view(device)
  }

  revoke(id: string): boolean {
    const list = this.all()
    const next = list.filter(d => d.id !== id)
    if (next.length === list.length) return false
    this.save(next)
    return true
  }
}

export function defaultDisplay(kind: Device['kind']): Device['display'] {
  if (kind === 'speaker' || kind === 'car') return 'none'
  if (kind === 'watch' || kind === 'glasses') return 'small'
  return 'full'
}

/** A message as clients see it: stable field names, no internal metadata. */
export interface ClientMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: number
  attachments: { id: string; name: string; mime: string; size: number }[]
  /** The task the message belongs to, if any. */
  taskId: string | null
  /** That task's state now: `working` means more messages about it will follow. */
  task: { id: string; title: string; state: 'working' | 'waiting' | 'done' } | null
  /**
   * For the assistant's messages: whether this answers the request, rather than saying it is working on it ("好，我查一下").
   * A device that speaks one answer (a speaker, `ask()`) waits for a final one.
   */
  final: boolean
  /** The paired device a message of the owner came from. */
  device: { id: string; name: string; kind: string } | null
  recalled: boolean
}

export type TaskLookup = (id: string) => { title: string; ended: unknown; attention: unknown } | undefined

export function clientMessage(m: Message, taskOf: TaskLookup = () => undefined): ClientMessage | undefined {
  if (m.role === 'event') return undefined
  const meta = (m.meta ?? {}) as { attachments?: ClientMessage['attachments']; device?: SendingDevice; recalled?: boolean; result?: unknown }
  const t = m.ticketId ? taskOf(m.ticketId) : undefined
  const task = m.ticketId ? { id: m.ticketId, title: t?.title ?? '', state: (!t || t.ended ? 'done' : t.attention ? 'waiting' : 'working') as 'working' | 'waiting' | 'done' } : null
  return {
    id: m.id, conversationId: m.conversationId, role: m.role, text: m.content, createdAt: m.createdAt,
    attachments: (meta.attachments ?? []).map(({ id, name, mime, size }) => ({ id, name, mime, size })),
    taskId: m.ticketId ?? null,
    task,
    final: m.role === 'assistant' && (!task || task.state !== 'working' || meta.result !== undefined),
    device: meta.device ? { id: meta.device.id, name: meta.device.name, kind: meta.device.kind } : null,
    recalled: Boolean(meta.recalled),
  }
}

type Env = { Variables: { device: Device } }

const PairBody = z.object({
  code: z.string().trim().min(4).max(20),
  device: z.object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(DEVICE_KINDS).default('other'),
    platform: z.string().trim().max(60).optional(),
    display: z.enum(DISPLAYS).optional(),
  }),
})
const SendBody = z.object({
  text: z.string().trim().max(100_000).default(''),
  attachments: z.array(z.string()).max(20).optional(),
  /** Idempotency key: sending the same one again returns the first message instead of a second one. */
  clientId: z.string().trim().min(1).max(100).optional(),
}).refine(b => b.text.length > 0 || (b.attachments?.length ?? 0) > 0, '消息不能为空')

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) throw new ClientError(400, 'invalid', parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return parsed.data
}

/** Browser-based clients run on other origins; a bearer token is not an ambient credential, so any origin may call. */
const cors: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, last-event-id', 'access-control-max-age': '86400' })
  }
  await next()
  c.res.headers.set('access-control-allow-origin', '*')
  c.res.headers.set('x-nuonuo-protocol', PROTOCOL.version)
}

export function clientApi(rt: Runtime, devices: Devices, conversations: Conversations, uploads: Uploads, closing?: AbortSignal): Hono<Env> {
  const api = new Hono<Env>()
  api.use('*', cors)
  api.onError((error, c) => {
    if (error instanceof ClientError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof ModelError) return c.json({ error: { code: error.code, message: error.message } }, 409)
    const code = (error as { code?: string }).code
    if (code === 'missing') return c.json({ error: { code, message: error.message } }, 404)
    if (code === 'invalid' || code === 'conflict') return c.json({ error: { code, message: error.message } }, code === 'conflict' ? 409 : 400)
    console.error(error)
    return c.json({ error: { code: 'internal', message: (error as Error).message } }, 500)
  })

  // ── Pairing (no token yet) ───────────────────────────────────────────────
  api.post('/pair', async c => {
    const input = await body(c, PairBody)
    const paired = devices.pair(input.code, input.device)
    rt.bus.emit({ type: 'activity.updated' })
    return c.json({ token: paired.token, device: paired.device, protocol: PROTOCOL.version }, 201)
  })

  // ── Everything else needs a device token ─────────────────────────────────
  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    const device = devices.authenticate(bearer)
    if (!device) throw new ClientError(401, 'unauthorized', '设备令牌无效或已被移除：请重新配对')
    c.set('device', device)
    await next()
  }
  const need = (c: Context<Env>, scope: Scope) => {
    if (!c.get('device').scopes.includes(scope)) throw new ClientError(403, 'forbidden', `这个设备没有「${scope}」权限`)
  }
  const conversationId = (id: string) => {
    const real = id === 'main' ? rt.engine.mainConversation() : id
    const found = conversations.get(real)
    if (!found || found.source === 'watchdog') throw new ClientError(404, 'missing', '没有这个对话')
    return found
  }
  const taskOf: TaskLookup = id => { try { return rt.engine.ticket(id) } catch { return undefined } }
  const view = (m: Message) => clientMessage(m, taskOf)
  // Idempotency keys of recent sends, per device.
  const sent = new Map<string, string>()

  api.use('/hello', auth)
  api.use('/session', auth)
  api.use('/conversations', auth)
  api.use('/conversations/*', auth)
  api.use('/messages/*', auth)
  api.use('/uploads', auth)
  api.use('/uploads/*', auth)
  api.use('/events', auth)
  api.use('/approvals', auth)
  api.use('/approvals/*', auth)

  api.get('/hello', c => {
    const p = persona(rt.store)
    const device = c.get('device')
    return c.json({
      protocol: PROTOCOL.version,
      server: { name: 'nuonuo', version: VERSION },
      assistant: { name: p.name, avatar: p.avatar, color: p.color, language: p.language },
      device: Devices.view(device),
      mainConversationId: rt.engine.mainConversation(),
      features: FEATURES.filter(f => (f === 'notices' ? device.scopes.includes('notices') : f === 'approvals' ? device.scopes.includes('approvals') : true)),
      limits: { maxUpload: MAX_UPLOAD, maxText: 100_000 },
    })
  })
  /** The device forgets itself (logout). */
  api.delete('/session', c => { devices.revoke(c.get('device').id); rt.bus.emit({ type: 'activity.updated' }); return c.body(null, 204) })

  // ── Conversations and messages ───────────────────────────────────────────
  api.get('/conversations', c => {
    need(c, 'chat')
    const main = rt.engine.mainConversation()
    const list = conversations.list(false).filter(x => x.source !== 'watchdog').map((x: any) => ({
      id: x.id, title: x.title, main: x.id === main, pinned: x.pinned, updatedAt: x.updatedAt, unread: x.unread ?? 0, lastMessage: x.lastMessage ?? null,
    }))
    return c.json({ conversations: list })
  })
  api.post('/conversations', async c => {
    need(c, 'chat')
    const input = await body(c, z.object({ title: z.string().trim().min(1).max(80).optional() }).optional().default({}))
    const created = conversations.create(input.title)
    return c.json({ conversation: { id: created.id, title: created.title, main: false, pinned: false, updatedAt: created.updatedAt, unread: 0, lastMessage: null } }, 201)
  })
  /** `after` is a message id: only later messages are returned (catching up after a reconnect). */
  api.get('/conversations/:id/messages', c => {
    need(c, 'chat')
    const conversation = conversationId(c.req.param('id'))
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200)
    let list = conversations.messages(conversation.id)
    const after = c.req.query('after')
    if (after) {
      const i = list.findIndex(m => m.id === after)
      if (i < 0) throw new ClientError(404, 'missing', '`after` 不是这个对话里的消息')
      list = list.slice(i + 1, i + 1 + limit)
    } else list = list.slice(-limit)
    return c.json({ conversationId: conversation.id, messages: list.map(view).filter(Boolean) })
  })
  api.post('/conversations/:id/messages', async c => {
    need(c, 'chat')
    const conversation = conversationId(c.req.param('id'))
    const device = c.get('device')
    const input = await body(c, SendBody)
    const key = input.clientId ? `${device.id}:${input.clientId}` : undefined
    const earlier = key ? sent.get(key) : undefined
    if (earlier) {
      const m = conversations.message(earlier)
      if (m) return c.json({ message: view(m), duplicate: true }, 200)
    }
    if (!rt.hub.resolve('router')) throw new ModelError('no_model', '糯糯还没有配置模型：请先在电脑上的 设置 → 分层模型 选择')
    let files
    try { files = uploads.take(input.attachments ?? []) } catch (error) { throw new ClientError(400, 'invalid', (error as Error).message) }
    const result = rt.engine.receiveMessage(conversation.id, input.text, { ...(files.length ? { attachments: files } : {}),
      device: { id: device.id, name: device.name, kind: device.kind, display: device.display } })
    void conversations.autoTitle(conversation.id).then(named => { if (named) rt.bus.emit({ type: 'conversation.updated', conversationId: conversation.id }) })
    if (key) {
      sent.set(key, result.messageId)
      if (sent.size > 1_000) sent.delete(sent.keys().next().value!)
    }
    return c.json({ message: view(conversations.message(result.messageId)!) }, 201)
  })
  api.post('/conversations/:id/read', c => { need(c, 'chat'); conversations.markRead(conversationId(c.req.param('id')).id); return c.json({ ok: true }) })

  // ── Attachments ──────────────────────────────────────────────────────────
  api.post('/uploads', async c => {
    need(c, 'chat')
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new ClientError(400, 'invalid', '缺少文件（multipart 字段 file）')
    if (file.size > MAX_UPLOAD) throw new ClientError(400, 'too_large', '文件超过 50MB')
    let saved
    try { saved = uploads.save({ name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }) } catch (error) { throw new ClientError(400, 'invalid', (error as Error).message) }
    return c.json({ upload: { id: saved.id, name: saved.name, mime: saved.mime, size: saved.size } }, 201)
  })
  api.get('/uploads/:id', c => {
    need(c, 'chat')
    const row = uploads.get(c.req.param('id'))
    if (!row || !existsSync(row.path)) throw new ClientError(404, 'missing', '附件已不存在')
    return new Response(Readable.toWeb(createReadStream(row.path)) as ReadableStream, { headers: { 'content-type': row.mime || 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' } })
  })

  // ── Approvals ────────────────────────────────────────────────────────────
  const approvalView = (a: { id: string; ticketId: string; tool: string; input: Record<string, unknown>; risk: string; reason: string; createdAt: number }) => {
    let task: string | null = null
    try { task = rt.engine.ticket(a.ticketId).title } catch { /* gone */ }
    const input = a.input as { command?: string; summary?: string }
    return { id: a.id, taskId: a.ticketId, task, tool: a.tool, action: String(input.summary ?? input.command ?? a.tool).slice(0, 500), risk: a.risk, reason: a.reason, createdAt: a.createdAt }
  }
  api.get('/approvals', c => { need(c, 'approvals'); return c.json({ approvals: rt.reviewer.pending().map(approvalView) }) })
  api.post('/approvals/:id', async c => {
    need(c, 'approvals')
    const { approve, note } = await body(c, z.object({ approve: z.boolean(), note: z.string().max(500).optional() }))
    try { rt.reviewer.decide(c.req.param('id'), approve, note ? `${note}（来自 ${c.get('device').name}）` : `来自 ${c.get('device').name}`, 'once') } catch (error) {
      if (error instanceof ClientError) throw error
      throw new ClientError(409, 'conflict', (error as Error).message)
    }
    return c.json({ ok: true })
  })

  // ── Events ───────────────────────────────────────────────────────────────
  /**
   * One SSE stream per device. `?conversation=<id|main>` narrows message events to one chat. Events are not replayed: on
   * reconnect, catch up with `GET /conversations/:id/messages?after=<last id>`.
   */
  api.get('/events', c => {
    const device = c.get('device')
    const only = c.req.query('conversation') ? conversationId(c.req.query('conversation')!).id : undefined
    return streamSSE(c, async sse => {
      const mapper = new EventMapper()
      const queue: { event: string; data: unknown }[] = []
      let wake: (() => void) | undefined
      let seq = 0
      const want = (cnv: string) => (!only || cnv === only) && conversations.get(cnv)?.source !== 'watchdog'
      const off = rt.bus.on(event => {
        for (const e of mapper.map(event)) {
          if ((e.type === 'message.created' || e.type === 'message.updated') && want(e.conversationId) && device.scopes.includes('chat')) {
            const m = conversations.message(e.messageId)
            const shown = m && view(m)
            if (shown) queue.push({ event: 'message', data: { op: e.type === 'message.created' ? 'created' : 'updated', message: shown } })
          } else if (e.type === 'reply.delta' && want(e.conversationId) && device.scopes.includes('chat')) {
            queue.push({ event: 'reply.delta', data: { conversationId: e.conversationId, replyId: e.callId, text: e.text } })
          } else if (e.type === 'conversation.updated' && want(e.conversationId)) {
            queue.push({ event: 'conversation', data: { conversationId: e.conversationId } })
          } else if (e.type === 'notice' && device.scopes.includes('notices')) {
            queue.push({ event: 'notice', data: { id: e.id, kind: e.kind, title: e.title, body: e.body, silent: e.silent } })
          }
        }
        if (event.type === 'approval.updated' && device.scopes.includes('approvals')) {
          const id = String((event as { approvalId?: string }).approvalId)
          const pending = rt.reviewer.pending().find(a => a.id === id)
          queue.push({ event: 'approval', data: pending ? { op: 'requested', approval: approvalView(pending) } : { op: 'resolved', id } })
        }
        if (queue.length) wake?.()
      })
      const closed = new Promise<void>(resolve => {
        const done = () => resolve()
        c.req.raw.signal.addEventListener('abort', done, { once: true })
        closing?.addEventListener('abort', done, { once: true })
      })
      try {
        await sse.writeSSE({ event: 'ready', id: String(seq++), data: JSON.stringify({ protocol: PROTOCOL.version, device: device.id }) })
        for (;;) {
          while (queue.length) { const next = queue.shift()!; await sse.writeSSE({ event: next.event, id: String(seq++), data: JSON.stringify(next.data) }) }
          const ping = new Promise<'ping'>(r => setTimeout(() => r('ping'), 20_000))
          const next = await Promise.race([new Promise<'event'>(r => { wake = () => r('event') }), ping, closed.then(() => 'closed' as const)])
          wake = undefined
          if (next === 'closed') break
          if (next === 'ping') await sse.writeSSE({ event: 'ping', data: '{}' })
          // A revoked device is cut off at the next event or ping.
          if (!devices.list().some(d => d.id === device.id)) break
        }
      } finally { off() }
    })
  })

  api.all('*', c => c.json({ error: { code: 'not_found', message: `没有这个接口：${c.req.method} ${c.req.path}` } }, 404))
  return api
}
