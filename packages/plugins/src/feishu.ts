/**
 * Feishu / Lark: the bot connects out over Feishu's long connection (长连接), so no public URL is needed. Messages arrive
 * as `im.message.receive_v1` events, button presses on approval cards as `card.action.trigger`; replies go out through
 * the IM API. Everything chat apps share comes from the channel layer.
 *
 * The long connection: POST /callback/ws/endpoint with the app's ID and secret returns a WebSocket URL. Its frames are
 * protobuf (`pbbp2.Frame`); control frames carry ping/pong, data frames carry event JSON and are acknowledged by
 * sending the frame back with a `{code: 200}` payload. Only one client of an app receives each event.
 */
import { ChannelError, defineChannel, definePlugin, z, type ChannelIO, type ChannelMessage, type SocketLike } from '@nuonuo/plugin-sdk'
import pkg from '../package.json' with { type: 'json' }

export const FeishuConfig = z.object({
  appId: z.string().trim().default(''),
  appSecret: z.string().default(''),
  domain: z.string().url().default('https://open.feishu.cn'),
}).strict()
type Config = z.infer<typeof FeishuConfig>
type IO = ChannelIO<Config>

// ── pbbp2.Frame, the long connection's envelope ─────────────────────────────

export interface FeishuFrame { seqId: bigint; logId: bigint; service: number; method: number; headers: { key: string; value: string }[]; payloadEncoding?: string; payloadType?: string; payload?: Uint8Array; logIdNew?: string }

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

function varint(out: number[], value: bigint): void {
  let v = BigInt.asUintN(64, value)
  while (v > 0x7fn) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n }
  out.push(Number(v))
}

export function encodeFrame(f: FeishuFrame): Uint8Array {
  const out: number[] = []
  const key = (field: number, wire: number) => varint(out, BigInt((field << 3) | wire))
  const bytes = (field: number, data: Uint8Array) => { key(field, 2); varint(out, BigInt(data.length)); for (const b of data) out.push(b) }
  key(1, 0); varint(out, f.seqId)
  key(2, 0); varint(out, f.logId)
  key(3, 0); varint(out, BigInt(f.service))
  key(4, 0); varint(out, BigInt(f.method))
  for (const h of f.headers) {
    const inner: number[] = []
    const k = utf8.encode(h.key); const v = utf8.encode(h.value)
    varint(inner, 0x0an); varint(inner, BigInt(k.length)); inner.push(...k)
    varint(inner, 0x12n); varint(inner, BigInt(v.length)); inner.push(...v)
    bytes(5, Uint8Array.from(inner))
  }
  if (f.payloadEncoding !== undefined) bytes(6, utf8.encode(f.payloadEncoding))
  if (f.payloadType !== undefined) bytes(7, utf8.encode(f.payloadType))
  if (f.payload !== undefined) bytes(8, f.payload)
  if (f.logIdNew !== undefined) bytes(9, utf8.encode(f.logIdNew))
  return Uint8Array.from(out)
}

export function decodeFrame(buf: Uint8Array): FeishuFrame {
  let i = 0
  const readVarint = (): bigint => {
    let shift = 0n; let v = 0n
    for (;;) {
      if (i >= buf.length) throw new Error('帧不完整')
      const b = buf[i++]!
      v |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return v
      shift += 7n
    }
  }
  const readBytes = () => { const n = Number(readVarint()); const out = buf.subarray(i, i + n); i += n; return out }
  const f: FeishuFrame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] }
  while (i < buf.length) {
    const tag = Number(readVarint())
    const field = tag >> 3; const wire = tag & 7
    if (wire === 0) {
      const v = readVarint()
      if (field === 1) f.seqId = v; else if (field === 2) f.logId = v; else if (field === 3) f.service = Number(v); else if (field === 4) f.method = Number(v)
    } else if (wire === 2) {
      const data = readBytes()
      if (field === 5) {
        const h = decodeHeader(data)
        f.headers.push(h)
      } else if (field === 6) f.payloadEncoding = fromUtf8.decode(data)
      else if (field === 7) f.payloadType = fromUtf8.decode(data)
      else if (field === 8) f.payload = Uint8Array.from(data)
      else if (field === 9) f.logIdNew = fromUtf8.decode(data)
    } else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else throw new Error(`未知的 protobuf 类型 ${wire}`)
  }
  return f
}

function decodeHeader(data: Uint8Array): { key: string; value: string } {
  const inner = decodeFrameLike(data)
  return { key: inner[1] ?? '', value: inner[2] ?? '' }
}

/** A message of string fields only (pbbp2.Header). */
function decodeFrameLike(data: Uint8Array): Record<number, string> {
  const out: Record<number, string> = {}
  let i = 0
  const readVarint = () => { let shift = 0; let v = 0; for (;;) { const b = data[i++]!; v |= (b & 0x7f) << shift; if (!(b & 0x80)) return v; shift += 7 } }
  while (i < data.length) {
    const tag = readVarint()
    const n = readVarint()
    out[tag >> 3] = fromUtf8.decode(data.subarray(i, i + n))
    i += n
  }
  return out
}

const header = (f: FeishuFrame, key: string) => f.headers.find(h => h.key === key)?.value

// ── The API ─────────────────────────────────────────────────────────────────

interface FeishuEvent {
  header?: { event_type?: string }
  event?: {
    sender?: { sender_id?: { open_id?: string }; sender_type?: string }
    message?: { message_id: string; chat_id: string; chat_type: string; message_type: string; content: string; thread_id?: string; create_time?: string; mentions?: { key: string; name?: string; id?: { open_id?: string } }[] }
    operator?: { open_id?: string }
    action?: { value?: Record<string, unknown> }
    context?: { open_chat_id?: string; open_message_id?: string }
  }
}

export class FeishuApi {
  private token: { value: string; until: number } | undefined
  constructor(private base: string, private appId: string, private appSecret: string, private fetchImpl: typeof fetch = fetch) {}

  private async json<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
    if (init.auth !== false) headers.authorization = `Bearer ${await this.tenantToken()}`
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}${path}`, { method: init.method ?? 'POST', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(30_000) })
    const data = await res.json().catch(() => ({ code: res.status, msg: `HTTP ${res.status}` })) as { code: number; msg?: string } & T
    if (data.code !== 0) throw new ChannelError(`飞书 ${path.split('?')[0]}: ${data.msg ?? data.code}`, { status: res.status >= 400 ? res.status : data.code, gone: [230002, 230006, 230011].includes(data.code), fatal: [10003, 10014, 99991663].includes(data.code) })
    return data
  }

  async tenantToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value
    const data = await this.json<{ tenant_access_token: string; expire: number }>('/open-apis/auth/v3/tenant_access_token/internal', { auth: false, body: { app_id: this.appId, app_secret: this.appSecret } })
    this.token = { value: data.tenant_access_token, until: Date.now() + Math.max(60, data.expire - 300) * 1000 }
    return data.tenant_access_token
  }

  bot() { return this.json<{ bot: { open_id: string; app_name?: string } }>('/open-apis/bot/v3/info', { method: 'GET' }).then(d => d.bot) }
  endpoint() {
    return this.json<{ data: { URL: string; ClientConfig?: { PingInterval?: number } } }>('/callback/ws/endpoint', { auth: false, body: { AppID: this.appId, AppSecret: this.appSecret } }).then(d => d.data)
  }
  send(chatId: string, msgType: string, content: unknown) {
    return this.json<{ data: { message_id: string } }>('/open-apis/im/v1/messages?receive_id_type=chat_id', { body: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) } }).then(d => d.data)
  }
  reply(messageId: string, msgType: string, content: unknown) {
    return this.json<{ data: { message_id: string } }>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, { body: { msg_type: msgType, content: JSON.stringify(content), reply_in_thread: true } }).then(d => d.data)
  }
  updateCard(messageId: string, card: unknown) {
    return this.json(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { method: 'PATCH', body: { content: JSON.stringify(card) } })
  }
}

/** A card: the text, plus buttons whose value carries the channel layer's button id. */
export function feishuCard(text: string, buttons: { id: string; label: string; style?: string }[] = []) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: text } },
      ...(buttons.length ? [{ tag: 'action', actions: buttons.map(b => ({ tag: 'button', text: { tag: 'plain_text', content: b.label }, type: b.style === 'danger' ? 'danger' : 'primary', value: { nuonuo: b.id } })) }] : []),
    ],
  }
}

/** The text of a message, whatever its type: text, rich text (post), or a note for files. */
function contentOf(type: string, raw: string, mentions: NonNullable<NonNullable<FeishuEvent['event']>['message']>['mentions'] = []): { text: string; files: ChannelMessage['files'] } {
  let content: any = {}
  try { content = JSON.parse(raw) } catch { /* not JSON */ }
  const named = (t: string) => mentions.reduce((s, m) => s.split(m.key).join(m.name ? `@${m.name}` : ''), t).trim()
  if (type === 'text') return { text: named(String(content.text ?? '')), files: [] }
  if (type === 'post') {
    const post = content.content ? content : content.zh_cn ?? content.en_us ?? Object.values(content)[0] ?? {}
    const lines = (post.content ?? []).map((line: any[]) => line.map(n => (n.tag === 'text' || n.tag === 'a' ? n.text : n.tag === 'at' ? `@${n.user_name ?? ''}` : '')).join(''))
    return { text: named([post.title, ...lines].filter(Boolean).join('\n')), files: [] }
  }
  if (type === 'image') return { text: '', files: [{ kind: 'image' }] }
  if (type === 'audio') return { text: '', files: [{ kind: 'voice' }] }
  if (type === 'file' || type === 'media') return { text: '', files: [{ kind: 'file', ...(content.file_name ? { name: content.file_name } : {}) }] }
  return { text: `[${type}]`, files: [] }
}

export function feishuKind(deps: { fetch?: typeof fetch; socket?: (url: string) => SocketLike } = {}) {
  const sessions = new WeakMap<object, { api: FeishuApi; bot: { open_id: string; app_name?: string } }>()
  const session = async (io: IO) => {
    const known = sessions.get(io)
    if (known) return known
    if (!io.config.appId || !io.config.appSecret) throw new ChannelError('还没有填写 App ID 和 App Secret', { fatal: true })
    const api = new FeishuApi(io.config.domain, io.config.appId, io.config.appSecret, deps.fetch)
    const bot = await api.bot()
    io.facts({ 机器人: bot.app_name ?? bot.open_id })
    const value = { api, bot }
    sessions.set(io, value)
    return value
  }

  async function onEvent(io: IO, botId: string, data: FeishuEvent): Promise<unknown> {
    const type = data.header?.event_type
    const e = data.event ?? {}
    if (type === 'im.message.receive_v1' && e.message) {
      const m = e.message
      const sender = e.sender?.sender_id?.open_id ?? ''
      if (m.thread_id) io.state.set(`last:${m.chat_id}:${m.thread_id}`, m.message_id)
      const { text, files } = contentOf(m.message_type, m.content, m.mentions)
      await io.message({
        id: m.message_id,
        chat: { id: m.chat_id, type: m.chat_type === 'p2p' ? 'private' : 'group' },
        ...(m.thread_id ? { topic: m.thread_id } : {}),
        from: { id: sender, bot: e.sender?.sender_type !== 'user', self: sender === botId },
        text, files,
        mentioned: (m.mentions ?? []).some(x => x.id?.open_id === botId),
        at: Number(m.create_time) || Date.now(),
      })
      return undefined
    }
    if (type === 'card.action.trigger') {
      const value = e.action?.value?.nuonuo
      if (typeof value !== 'string') return undefined
      const toast = await io.action({ data: value, from: { id: e.operator?.open_id ?? '' }, ...(e.context?.open_chat_id ? { chat: { id: e.context.open_chat_id } } : {}) })
      return toast ? { toast: { type: 'info', content: toast } } : undefined
    }
    return undefined
  }

  const open = (url: string, io: IO) => (deps.socket ? deps.socket(url) : io.socket(url))

  return defineChannel<Config>({
    id: 'feishu',
    title: '飞书',
    description: '在飞书里和糯糯对话：私聊直接说，群里 @它。到飞书开放平台创建企业自建应用，开启机器人能力，事件订阅选「长连接」并订阅「接收消息」（im.message.receive_v1）；要用按钮回答确认，卡片回调也选长连接。不需要公网地址。',
    capabilities: { inbound: 'websocket', threads: 'reply', format: 'plain', maxLength: 4000, edit: true, buttons: true, files: { in: false, out: false }, proactive: true },
    config: FeishuConfig,
    fields: [
      { key: 'appId', type: 'text', label: 'App ID', placeholder: 'cli_…', links: [{ label: '飞书开放平台', href: 'https://open.feishu.cn/app' }] },
      { key: 'appSecret', type: 'secret', label: 'App Secret' },
      { key: 'domain', type: 'select', label: '版本', advanced: true, options: [{ value: 'https://open.feishu.cn', label: '飞书' }, { value: 'https://open.larksuite.com', label: 'Lark（国际版）' }] },
    ],
    idHint: '你的飞书 open_id（ou_…）',
    async connect(io) {
      const { api, bot } = await session(io)
      const ep = await api.endpoint()
      const service = Number(new URL(ep.URL).searchParams.get('service_id') ?? 0)
      const pingMs = Math.max(10, ep.ClientConfig?.PingInterval ?? 120) * 1000
      const parts = new Map<string, Uint8Array[]>()
      const ws = open(ep.URL, io)
      let timer: ReturnType<typeof setInterval> | undefined
      const ping = () => { try { ws.send(encodeFrame({ seqId: 0n, logId: 0n, service, method: 0, headers: [{ key: 'type', value: 'ping' }] })) } catch { /* closing */ } }
      try {
        await io.runSocket(ws, {
          open: () => { io.online(); ping(); timer = setInterval(ping, pingMs) },
          message: async raw => {
            if (typeof raw === 'string') return
            const frame = decodeFrame(new Uint8Array(raw))
            if (frame.method !== 1) return // control: pong
            const started = Date.now()
            const id = header(frame, 'message_id') ?? ''
            const sum = Number(header(frame, 'sum') ?? 1)
            let payload = frame.payload ?? new Uint8Array()
            if (sum > 1) {
              const got = parts.get(id) ?? new Array(sum)
              got[Number(header(frame, 'seq') ?? 0)] = payload
              parts.set(id, got)
              if (got.filter(Boolean).length < sum) return
              parts.delete(id)
              payload = Uint8Array.from(got.flatMap(p => [...p]))
            }
            let result: unknown
            let code = 200
            try { result = await onEvent(io, bot.open_id, JSON.parse(fromUtf8.decode(payload)) as FeishuEvent) } catch (error) { code = 500; io.log(`处理事件出错：${(error as Error).message}`) }
            const answer = { code, headers: {}, ...(result ? { data: Buffer.from(JSON.stringify(result)).toString('base64') } : {}) }
            ws.send(encodeFrame({ ...frame, headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - started) }], payload: utf8.encode(JSON.stringify(answer)) }))
          },
        })
      } finally { clearInterval(timer) }
    },
    async send(io, target, out) {
      const { api } = await session(io)
      const type = out.buttons?.length ? 'interactive' : 'text'
      const content = out.buttons?.length ? feishuCard(out.text, out.buttons) : { text: out.text }
      const root = target.topic ? io.state.get<string>(`last:${target.chat}:${target.topic}`) : undefined
      const sent = root ? await api.reply(root, type, content) : await api.send(target.chat, type, content)
      return { id: sent.message_id }
    },
    // Only approval cards are edited (to mark the answer and drop the buttons).
    async edit(io, _target, messageId, out) {
      const { api } = await session(io)
      await api.updateCard(messageId, feishuCard(out.text))
    },
  })
}

export const feishuPlugin = definePlugin({ id: 'feishu', name: '飞书', version: pkg.version, description: '在飞书里和糯糯对话', sources: [feishuKind()] })
