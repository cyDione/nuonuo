/** In-memory stand-ins for the Telegram Bot API and the Gmail API (tests and local end-to-end runs). */
import { createServer, type Server } from 'node:http'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serve(handler: (req: Request) => Promise<Response>, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c
    const response = await handler(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(raw ? { body: raw } : {}) }))
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()))
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

export class FakeTelegram {
  readonly token = '123:test'
  readonly bot = { id: 999, is_bot: true, username: 'my_agent_bot', first_name: 'Agent' }
  private updates: { update_id: number; message?: unknown; callback_query?: unknown }[] = []
  private seq = 1
  private msg = 1
  sent: { chat_id: number; text: string; message_thread_id?: number; message_id?: number; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = []
  edits: { chat_id: number; message_id: number; text: string }[] = []
  answered: { callback_query_id: string; text?: string }[] = []

  /** A user presses an inline button under one of the bot's messages. */
  press(from: { id: number; username?: string }, data: string, chatId: number = from.id) {
    this.updates.push({ update_id: this.seq++, callback_query: { id: `cb${this.seq}`, from: { is_bot: false, first_name: 'u', ...from }, data, message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private' } } } })
  }

  /** A user writes to the bot. */
  say(from: { id: number; username?: string; is_bot?: boolean }, text: string, chat: { id: number; type: 'private' | 'group'; title?: string } = { id: from.id, type: 'private' }) {
    this.updates.push({ update_id: this.seq++, message: { message_id: this.msg++, date: Math.floor(Date.now() / 1000), text, from: { is_bot: false, first_name: from.username ?? 'u', ...from }, chat } })
  }

  fetch: typeof fetch = async (input, init) => this.handle(new Request(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init))
  listen(port: number) { return serve(r => this.handle(r), port) }

  private async handle(req: Request): Promise<Response> {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname)
    if (!m || m[1] !== this.token) return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401)
    const body = await req.json().catch(() => ({})) as Record<string, any>
    switch (m[2]) {
      case 'getMe': return json({ ok: true, result: this.bot })
      case 'getUpdates': {
        if (body.offset) this.updates = this.updates.filter(u => u.update_id >= body.offset)
        if (!this.updates.length && body.timeout) await new Promise(r => setTimeout(r, Math.min(body.timeout * 1000, 300)))
        return json({ ok: true, result: this.updates })
      }
      case 'sendMessage': { const message_id = this.msg++; this.sent.push({ ...body, message_id } as any); return json({ ok: true, result: { message_id } }) }
      case 'editMessageText': this.edits.push(body as any); return json({ ok: true, result: true })
      case 'answerCallbackQuery': this.answered.push(body as any); return json({ ok: true, result: true })
      default: return json({ ok: false, error_code: 404, description: 'Not Found' }, 404)
    }
  }
}

interface FakeMail { id: string; threadId: string; from: string; to: string; subject: string; body: string; labelIds: string[]; messageId: string; date: number }

export class FakeGmail {
  readonly email = 'me@example.com'
  mails: FakeMail[] = []
  drafts: { id: string; threadId?: string; raw: string }[] = []
  labels = [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_7', name: 'nuonuo' }]
  private history: { id: number; added?: string; labelAdded?: { id: string; labels: string[] } }[] = []
  private historyId = 100
  issuedCode = 'auth-code-1'
  refreshToken = 'refresh-1'
  revoked: string[] = []

  /** A mail arrives. */
  receive(from: string, subject: string, body: string, opts: { threadId?: string; labels?: string[] } = {}): FakeMail {
    const id = `m${this.mails.length + 1}`
    const mail = { id, threadId: opts.threadId ?? `t${this.mails.length + 1}`, from, to: this.email, subject, body, labelIds: ['INBOX', ...(opts.labels ?? [])], messageId: `<${id}@mail>`, date: Date.now() }
    this.mails.push(mail)
    this.history.push({ id: ++this.historyId, added: id })
    return mail
  }
  label(mailId: string, labelId: string) {
    this.mails.find(m => m.id === mailId)!.labelIds.push(labelId)
    this.history.push({ id: ++this.historyId, labelAdded: { id: mailId, labels: [labelId] } })
  }

  fetch: typeof fetch = async (input, init) => this.handle(new Request(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init))
  listen(port: number) { return serve(r => this.handle(r), port) }

  private message(m: FakeMail, format: string) {
    const headers = [['From', m.from], ['To', m.to], ['Subject', m.subject], ['Date', new Date(m.date).toUTCString()], ['Message-ID', m.messageId]].map(([name, value]) => ({ name, value }))
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.body.slice(0, 80), internalDate: String(m.date),
      payload: format === 'full' ? { mimeType: 'multipart/alternative', headers, parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(m.body).toString('base64url') } }] } : { headers } }
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/revoke') { this.revoked.push(new URLSearchParams(await req.text()).get('token') ?? ''); return json({}) }
    if (url.pathname.endsWith('/token')) {
      const form = new URLSearchParams(await req.text())
      if (form.get('grant_type') === 'authorization_code') {
        return form.get('code') === this.issuedCode ? json({ access_token: 'access-1', refresh_token: this.refreshToken, expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400)
      }
      return form.get('refresh_token') === this.refreshToken ? json({ access_token: 'access-2', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400)
    }
    if (!(req.headers.get('authorization') ?? '').startsWith('Bearer access-')) return json({ error: { code: 401 } }, 401)
    const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, '')
    if (p === '/profile') return json({ emailAddress: this.email, historyId: String(this.historyId) })
    if (p === '/labels') return json({ labels: this.labels })
    if (p === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'))
      const items = this.history.filter(h => h.id > start).map(h => h.added ? { messagesAdded: [{ message: { id: h.added } }] } : { labelsAdded: [{ message: { id: h.labelAdded!.id }, labelIds: h.labelAdded!.labels }] })
      return json({ history: items, historyId: String(this.historyId) })
    }
    if (p === '/messages') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      return json({ messages: this.mails.filter(m => !q || `${m.from} ${m.subject} ${m.body}`.toLowerCase().includes(q.replace(/^from:/, ''))).map(m => ({ id: m.id, threadId: m.threadId })) })
    }
    const mm = /^\/messages\/(\w+)$/.exec(p)
    if (mm) {
      const m = this.mails.find(x => x.id === mm[1])
      return m ? json(this.message(m, url.searchParams.get('format') ?? 'full')) : json({ error: { code: 404 } }, 404)
    }
    if (p === '/drafts' && req.method === 'POST') {
      const body = await req.json() as { message: { raw: string; threadId?: string } }
      const draft = { id: `d${this.drafts.length + 1}`, raw: Buffer.from(body.message.raw, 'base64url').toString('utf8'), ...(body.message.threadId ? { threadId: body.message.threadId } : {}) }
      this.drafts.push(draft)
      return json({ id: draft.id, message: { id: `dm${this.drafts.length}` } })
    }
    return json({ error: { code: 404, message: `fake gmail: ${req.method} ${p}` } }, 404)
  }
}


/** A WebSocket stand-in: the test plays the server side (`deliver`, `sent`). It opens on the next tick. */
export class FakeSocket {
  binaryType = 'blob'
  sent: (string | Uint8Array)[] = []
  closed: number | undefined
  private listeners: Record<string, ((e: any) => void)[]> = {}
  onSend: ((data: string | Uint8Array) => void) | undefined
  constructor(readonly url: string) { setTimeout(() => this.emit('open', {}), 0) }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn) }
  private emit(type: string, e: unknown) { for (const fn of this.listeners[type] ?? []) fn(e) }
  send(data: string | ArrayBufferLike | Uint8Array) {
    const d = typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer)
    this.sent.push(d)
    this.onSend?.(d)
  }
  close(code = 1000) { if (this.closed !== undefined) return; this.closed = code; setTimeout(() => this.emit('close', { code }), 0) }
  /** The server sends a frame. */
  deliver(data: string | Uint8Array) { this.emit('message', { data: typeof data === 'string' ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }) }
}

/** The Feishu Open Platform: token, bot info, the long-connection endpoint and the IM API. */
export class FakeFeishu {
  readonly appId = 'cli_test'
  readonly appSecret = 'secret'
  readonly botId = 'ou_bot'
  sockets: FakeSocket[] = []
  sent: { chat?: string; replyTo?: string; msgType: string; content: any; id: string }[] = []
  patched: { id: string; content: any }[] = []
  private n = 1
  fetch: typeof fetch = async (input, init) => this.handle(new Request(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init))
  socket = (url: string) => { const s = new FakeSocket(url); this.sockets.push(s); return s as unknown as import('@nuonuo/plugin-sdk').SocketLike }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, any>
    const authed = req.headers.get('authorization') === 'Bearer t-token'
    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal')
      return body.app_id === this.appId && body.app_secret === this.appSecret ? json({ code: 0, tenant_access_token: 't-token', expire: 7200 }) : json({ code: 10014, msg: 'app secret invalid' })
    if (url.pathname === '/callback/ws/endpoint') return json({ code: 0, data: { URL: 'wss://fake-feishu.local/ws?device_id=d1&service_id=33', ClientConfig: { PingInterval: 120 } } })
    if (!authed) return json({ code: 99991663, msg: 'invalid token' })
    if (url.pathname === '/open-apis/bot/v3/info') return json({ code: 0, bot: { open_id: this.botId, app_name: '糯糯' } })
    if (url.pathname === '/open-apis/im/v1/messages' && req.method === 'POST') {
      if (body.receive_id === 'oc_gone') return json({ code: 230002, msg: 'bot is not in the chat' })
      const id = `om_out${this.n++}`; this.sent.push({ chat: body.receive_id, msgType: body.msg_type, content: JSON.parse(body.content), id }); return json({ code: 0, data: { message_id: id } })
    }
    const reply = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(url.pathname)
    if (reply) { const id = `om_out${this.n++}`; this.sent.push({ replyTo: reply[1]!, msgType: body.msg_type, content: JSON.parse(body.content), id }); return json({ code: 0, data: { message_id: id } }) }
    const patch = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(url.pathname)
    if (patch && req.method === 'PATCH') { this.patched.push({ id: patch[1]!, content: JSON.parse(body.content) }); return json({ code: 0 }) }
    return json({ code: 404, msg: 'not found' }, 404)
  }
}

/** Discord: the REST API and the Gateway (op 10 Hello → identify → READY). */
export class FakeDiscord {
  readonly token = 'discord-token'
  readonly botId = '9000'
  sockets: FakeSocket[] = []
  identified: any[] = []
  sent: { channel: string; content: string; components?: any[]; id: string }[] = []
  edits: { channel: string; id: string; content: string; components?: any[] }[] = []
  callbacks: { id: string; body: any }[] = []
  private n = 1
  private s = 1
  fetch: typeof fetch = async (input, init) => this.handle(new Request(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init))
  socket = (url: string) => {
    const ws = new FakeSocket(url)
    this.sockets.push(ws)
    setTimeout(() => ws.deliver(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } })), 1)
    ws.onSend = data => {
      const msg = JSON.parse(String(data))
      if (msg.op === 2) { this.identified.push(msg.d); ws.deliver(JSON.stringify({ op: 0, s: this.s++, t: 'READY', d: { user: { id: this.botId, username: 'nuonuo-bot' }, session_id: 's' } })) }
      if (msg.op === 1) ws.deliver(JSON.stringify({ op: 11 }))
    }
    return ws as unknown as import('@nuonuo/plugin-sdk').SocketLike
  }
  dispatch(t: string, d: unknown) { this.sockets.at(-1)!.deliver(JSON.stringify({ op: 0, s: this.s++, t, d })) }

  private async handle(req: Request): Promise<Response> {
    if (req.headers.get('authorization') !== `Bot ${this.token}`) return json({ message: '401: Unauthorized' }, 401)
    const path = new URL(req.url).pathname.replace(/^\/api\/v10/, '')
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, any>
    let m = /^\/channels\/(\d+)\/messages$/.exec(path)
    if (m && req.method === 'POST') {
      if (m[1] === '404') return json({ message: 'Unknown Channel' }, 404)
      const id = `${8000 + this.n++}`; this.sent.push({ channel: m[1]!, content: body.content, components: body.components, id }); return json({ id })
    }
    m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path)
    if (m && req.method === 'PATCH') { this.edits.push({ channel: m[1]!, id: m[2]!, content: body.content, components: body.components }); return json({ id: m[2] }) }
    m = /^\/interactions\/(\w+)\/([\w.-]+)\/callback$/.exec(path)
    if (m) { this.callbacks.push({ id: m[1]!, body }); return new Response(null, { status: 204 }) }
    return json({ message: 'Not Found' }, 404)
  }
}
