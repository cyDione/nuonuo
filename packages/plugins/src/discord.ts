/**
 * Discord: the bot connects out to the Gateway (a WebSocket), so no public URL is needed. Direct messages always reach
 * the assistant; in servers, mention the bot or reply to it. Threads are channels of their own, so each thread is its own
 * chat. Approval buttons arrive as interactions over the same Gateway. Everything chat apps share comes from the channel layer.
 *
 * In the Developer Portal, turn on the MESSAGE CONTENT intent for the bot, or server messages arrive without text.
 */
import { ChannelError, defineChannel, definePlugin, z, type ChannelIO, type SocketLike } from '@nuonuo/plugin-sdk'
import pkg from '../package.json' with { type: 'json' }

export const DiscordConfig = z.object({
  token: z.string().default(''),
  apiUrl: z.string().url().default('https://discord.com/api/v10'),
  gatewayUrl: z.string().url().default('wss://gateway.discord.gg/?v=10&encoding=json'),
}).strict()
type Config = z.infer<typeof DiscordConfig>
type IO = ChannelIO<Config>

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

interface DcUser { id: string; username?: string; global_name?: string; bot?: boolean }
interface DcMessage { id: string; channel_id: string; guild_id?: string; author: DcUser; content: string; mentions?: DcUser[]; referenced_message?: { author?: DcUser } | null; attachments?: { filename?: string; content_type?: string }[]; timestamp?: string }
interface DcInteraction { id: string; token: string; type: number; channel_id?: string; data?: { custom_id?: string }; member?: { user?: DcUser }; user?: DcUser }

export class DiscordApi {
  constructor(private base: string, private token: string, private fetchImpl: typeof fetch = fetch) {}
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}${path}`, {
      method, headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 204) return undefined as T
    const data = await res.json().catch(() => ({})) as T & { message?: string; retry_after?: number }
    if (!res.ok) {
      if (res.status === 429 && data.retry_after) await new Promise(r => setTimeout(r, Math.min(10_000, data.retry_after! * 1000)))
      throw new ChannelError(`Discord ${method} ${path}: ${data.message ?? res.status}`, { status: res.status, gone: res.status === 403 || res.status === 404, fatal: res.status === 401 })
    }
    return data
  }
}

export function discordKind(deps: { fetch?: typeof fetch; socket?: (url: string) => SocketLike } = {}) {
  const apis = new WeakMap<object, DiscordApi>()
  const api = (io: IO) => {
    let a = apis.get(io)
    if (!a) {
      if (!io.config.token) throw new ChannelError('还没有填写 Bot token', { fatal: true })
      a = new DiscordApi(io.config.apiUrl, io.config.token, deps.fetch)
      apis.set(io, a)
    }
    return a
  }
  const name = (u: DcUser) => u.global_name ?? u.username

  return defineChannel<Config>({
    id: 'discord',
    title: 'Discord',
    description: '在 Discord 里和糯糯对话：私信直接说，服务器里 @它。到 Discord Developer Portal 创建应用和机器人，拿到 token，打开 MESSAGE CONTENT 权限，再把机器人邀请进你的服务器。不需要公网地址。',
    capabilities: { inbound: 'websocket', threads: 'topic', format: 'markdown', maxLength: 2000, edit: true, buttons: true, typing: true, files: { in: false, out: false }, proactive: true },
    config: DiscordConfig,
    fields: [
      { key: 'token', type: 'secret', label: 'Bot token', links: [{ label: 'Developer Portal', href: 'https://discord.com/developers/applications' }] },
      { key: 'apiUrl', type: 'text', label: 'API 地址', advanced: true },
      { key: 'gatewayUrl', type: 'text', label: 'Gateway 地址', advanced: true },
    ],
    idHint: '你的 Discord 用户 ID 或用户名',
    async connect(io) {
      const rest = api(io)
      const ws = deps.socket ? deps.socket(io.config.gatewayUrl) : io.socket(io.config.gatewayUrl)
      let seq: number | null = null
      let me = ''
      let beat: ReturnType<typeof setInterval> | undefined
      let acked = true
      const send = (op: number, d: unknown) => { try { ws.send(JSON.stringify({ op, d })) } catch { /* closing */ } }
      try {
        await io.runSocket(ws, {
          message: async raw => {
            const msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as { op: number; d: any; s?: number | null; t?: string }
            if (typeof msg.s === 'number') seq = msg.s
            switch (msg.op) {
              case 10: { // Hello
                const every = Number(msg.d?.heartbeat_interval ?? 41_250)
                beat = setInterval(() => { if (!acked) { ws.close(4000); return } acked = false; send(1, seq) }, every)
                send(2, { token: io.config.token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: 'nuonuo', device: 'nuonuo' } })
                return
              }
              case 11: acked = true; return
              case 1: send(1, seq); return
              case 7: ws.close(4000); return // reconnect
              case 9: await io.sleep(2_000); ws.close(4000); return // invalid session
              case 0: break
              default: return
            }
            if (msg.t === 'READY') {
              me = String(msg.d.user?.id ?? '')
              io.facts({ 机器人: msg.d.user?.username ?? me })
              io.online()
            } else if (msg.t === 'MESSAGE_CREATE') {
              const m = msg.d as DcMessage
              const files = (m.attachments ?? []).map(a => (a.content_type?.startsWith('image/') ? { kind: 'image' as const } : a.content_type?.startsWith('audio/') ? { kind: 'voice' as const } : { kind: 'file' as const, ...(a.filename ? { name: a.filename } : {}) }))
              await io.message({
                id: m.id,
                chat: { id: m.channel_id, type: m.guild_id ? 'group' : 'private' },
                from: { id: m.author.id, bot: Boolean(m.author.bot), self: m.author.id === me, ...(m.author.username ? { username: m.author.username } : {}), ...(name(m.author) ? { name: name(m.author)! } : {}) },
                text: m.content.replace(new RegExp(`<@!?${me}>`, 'g'), '').trim(),
                mentioned: (m.mentions ?? []).some(u => u.id === me),
                replyToBot: m.referenced_message?.author?.id === me,
                files,
                at: m.timestamp ? Date.parse(m.timestamp) : Date.now(),
              })
            } else if (msg.t === 'INTERACTION_CREATE') {
              const it = msg.d as DcInteraction
              const user = it.member?.user ?? it.user
              if (it.type !== 3 || !it.data?.custom_id || !user) return
              const toast = await io.action({ data: it.data.custom_id, from: { id: user.id, ...(user.username ? { username: user.username } : {}) }, ...(it.channel_id ? { chat: { id: it.channel_id } } : {}) })
              // 4 = reply visible only to the presser; acknowledges the press within Discord's 3 seconds.
              await rest.call('POST', `/interactions/${it.id}/${it.token}/callback`, { type: 4, data: { content: toast ?? '好的', flags: 64 } }).catch(e => io.log((e as Error).message))
            }
          },
        })
      } finally { clearInterval(beat) }
    },
    async send(io, target, out) {
      const sent = await api(io).call<{ id: string }>('POST', `/channels/${target.chat}/messages`, {
        content: out.text, allowed_mentions: { parse: [] },
        ...(out.buttons?.length ? { components: [{ type: 1, components: out.buttons.map(b => ({ type: 2, style: b.style === 'danger' ? 4 : 1, label: b.label, custom_id: b.id })) }] } : {}),
      })
      return { id: sent.id }
    },
    async edit(io, target, messageId, out) {
      await api(io).call('PATCH', `/channels/${target.chat}/messages/${messageId}`, { content: out.text, components: [] })
    },
  })
}

export const discordPlugin = definePlugin({ id: 'discord', name: 'Discord', version: pkg.version, description: '在 Discord 里和糯糯对话', sources: [discordKind()] })
