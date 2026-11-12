/**
 * Slack over Socket Mode: the app opens a WebSocket with its app-level token (apps.connections.open), so no public URL
 * is needed. Events (messages, mentions) and button presses arrive as envelopes that are acknowledged by id; replies go
 * out through the Web API with the bot token. Threads are kept: a message in a thread is answered in that thread.
 * Everything chat apps share comes from the channel layer.
 */
import { ChannelError, defineChannel, definePlugin, z, type ChannelIO, type SocketLike } from '@nuonuo/plugin-sdk'
import pkg from '../package.json' with { type: 'json' }

export const SlackConfig = z.object({
  botToken: z.string().default(''),
  appToken: z.string().default(''),
  apiUrl: z.string().url().default('https://slack.com/api'),
}).strict()
type Config = z.infer<typeof SlackConfig>
type IO = ChannelIO<Config>

const GONE = new Set(['channel_not_found', 'not_in_channel', 'is_archived', 'account_inactive', 'user_not_found'])
const FATAL = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'missing_scope'])

export class SlackApi {
  constructor(private base: string, private fetchImpl: typeof fetch = fetch) {}
  async call<T>(method: string, token: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}/${method}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` })) as T & { ok: boolean; error?: string }
    if (!data.ok) throw new ChannelError(`Slack ${method}: ${data.error ?? res.status}`, { status: res.status, gone: GONE.has(String(data.error)), fatal: FATAL.has(String(data.error)) })
    return data
  }
}


/** Downloads a received file (Uint8Array), refusing anything over the channel's limit. */
async function grab(f: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<{ bytes: Uint8Array; mime?: string }> {
  const res = await f(url, { headers, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`下载失败 ${res.status}`)
  const mime = res.headers.get('content-type')?.split(';')[0]
  return { bytes: new Uint8Array(await res.arrayBuffer()), ...(mime ? { mime } : {}) }
}

export function slackKind(deps: { fetch?: typeof fetch; socket?: (url: string) => SocketLike } = {}) {
  const apis = new WeakMap<object, SlackApi>()
  const api = (io: IO) => {
    let a = apis.get(io)
    if (!a) { a = new SlackApi(io.config.apiUrl, deps.fetch); apis.set(io, a) }
    return a
  }

  return defineChannel<Config>({
    id: 'slack',
    title: 'Slack',
    description: '在 Slack 里和糯糯对话：私信直接说，频道里 @它。在 api.slack.com 创建应用，打开 Socket Mode（得到 xapp- 开头的 App token），订阅 message.im、app_mention 事件，装到工作区后拿到 xoxb- 开头的 Bot token。不需要公网地址。',
    // Files need the files:read scope; without it the download fails and the agent sees a note instead.
    capabilities: { inbound: 'websocket', threads: 'reply', format: 'plain', maxLength: 3500, edit: true, buttons: true, files: { in: true, out: false }, proactive: true },
    config: SlackConfig,
    fields: [
      { key: 'botToken', type: 'secret', label: 'Bot token', placeholder: 'xoxb-…', links: [{ label: 'Slack 应用', href: 'https://api.slack.com/apps' }] },
      { key: 'appToken', type: 'secret', label: 'App token（Socket Mode）', placeholder: 'xapp-…' },
      { key: 'apiUrl', type: 'text', label: 'API 地址', advanced: true },
    ],
    idHint: '你的 Slack 成员 ID（U…）或用户名',
    async connect(io) {
      if (!io.config.botToken || !io.config.appToken) throw new ChannelError('还没有填写 Bot token 和 App token', { fatal: true })
      const me = await api(io).call<{ user_id: string; user?: string; team?: string }>('auth.test', io.config.botToken)
      io.facts({ 机器人: me.user ?? me.user_id, ...(me.team ? { 工作区: me.team } : {}) })
      const { url } = await api(io).call<{ url: string }>('apps.connections.open', io.config.appToken)
      const ws = deps.socket ? deps.socket(url) : io.socket(url)
      const mention = `<@${me.user_id}>`
      await io.runSocket(ws, {
        message: async raw => {
          const env = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as { type: string; envelope_id?: string; payload?: any }
          if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }))
          if (env.type === 'hello') { io.online(); return }
          if (env.type === 'disconnect') { ws.close(4000); return }
          if (env.type === 'events_api') {
            const ev = env.payload?.event
            if (!ev || (ev.type !== 'message' && ev.type !== 'app_mention') || (ev.subtype && ev.subtype !== 'file_share' && ev.subtype !== 'thread_broadcast')) return
            const text = String(ev.text ?? '')
            await io.message({
              id: ev.ts, chat: { id: ev.channel, type: ev.channel_type === 'im' ? 'private' : 'group' },
              ...(ev.thread_ts ? { topic: ev.thread_ts } : {}),
              from: { id: String(ev.user ?? ev.bot_id ?? ''), bot: Boolean(ev.bot_id), self: ev.user === me.user_id },
              text: text.split(mention).join('').trim(),
              mentioned: ev.type === 'app_mention' || text.includes(mention),
              files: (ev.files ?? []).map((f: any) => ({ kind: String(f.mimetype).startsWith('image/') ? 'image' as const : String(f.mimetype).startsWith('audio/') ? 'voice' as const : 'file' as const,
                ...(f.name ? { name: String(f.name) } : {}), ...(f.mimetype ? { mime: String(f.mimetype) } : {}), ...(f.size ? { size: Number(f.size) } : {}), ...(f.url_private_download || f.url_private ? { ref: String(f.url_private_download ?? f.url_private) } : {}) })),
              at: Math.round(Number(ev.ts) * 1000) || Date.now(),
            })
            return
          }
          if (env.type === 'interactive' && env.payload?.type === 'block_actions') {
            const p = env.payload
            for (const a of p.actions ?? []) {
              await io.action({ data: String(a.value ?? a.action_id ?? ''), from: { id: p.user?.id, ...(p.user?.username ? { username: p.user.username } : {}) },
                ...(p.channel?.id ? { chat: { id: p.channel.id } } : {}), ...(p.message?.thread_ts ? { topic: p.message.thread_ts } : {}) })
            }
          }
        },
      })
    },
    async send(io, target, out) {
      const sent = await api(io).call<{ ts: string }>('chat.postMessage', io.config.botToken, {
        channel: target.chat, text: out.text, ...(target.topic ? { thread_ts: target.topic } : {}),
        ...(out.buttons?.length ? { blocks: [
          { type: 'section', text: { type: 'plain_text', text: out.text.slice(0, 3000) } },
          { type: 'actions', elements: out.buttons.map(b => ({ type: 'button', text: { type: 'plain_text', text: b.label }, value: b.id, action_id: b.id, ...(b.style ? { style: b.style } : {}) })) },
        ] } : {}),
      })
      return { id: sent.ts }
    },
    async download(io, file) {
      const url = String(file.ref)
      // Only Slack's own file host gets the bot token.
      if (!/^https:\/\/files\.slack\.com\//.test(url)) return undefined
      return { ...await grab(deps.fetch ?? fetch, url, { authorization: `Bearer ${io.config.botToken}` }), ...(file.name ? { name: file.name } : {}) }
    },
    async edit(io, target, messageId, out) {
      await api(io).call('chat.update', io.config.botToken, { channel: target.chat, ts: messageId, text: out.text, blocks: [{ type: 'section', text: { type: 'plain_text', text: out.text.slice(0, 3000) } }] })
    },
  })
}

export const slackPlugin = definePlugin({ id: 'slack', name: 'Slack', version: pkg.version, description: '在 Slack 里和糯糯对话', sources: [slackKind()] })
