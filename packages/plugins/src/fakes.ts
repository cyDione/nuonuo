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
  private updates: { update_id: number; message: unknown }[] = []
  private seq = 1
  private msg = 1
  sent: { chat_id: number; text: string; message_thread_id?: number }[] = []

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
      case 'sendMessage': this.sent.push(body as any); return json({ ok: true, result: { message_id: this.msg++ } })
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
