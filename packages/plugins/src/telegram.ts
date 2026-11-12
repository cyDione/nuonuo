/**
 * Telegram: talk to your own computer from your phone. A bot you create with @BotFather long-polls the Bot API (no public
 * URL needed). Everything chat apps share (who may ask, /new, splitting, approvals) comes from the channel layer; this
 * file only speaks the Bot API.
 */
import { ChannelError, defineChannel, definePlugin, z, type ChannelIO, type ChannelMessage } from '@nuonuo/plugin-sdk'
import pkg from '../package.json' with { type: 'json' }

export const TelegramConfig = z.object({
  token: z.string().default(''),
  apiUrl: z.string().url().default('https://api.telegram.org'),
}).strict()
type Config = z.infer<typeof TelegramConfig>
type IO = ChannelIO<Config>

interface TgUser { id: number; is_bot: boolean; username?: string; first_name?: string }
interface TgMessage {
  message_id: number; date: number; text?: string; caption?: string; from?: TgUser
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string; first_name?: string }
  message_thread_id?: number; reply_to_message?: { from?: TgUser }; photo?: unknown[]; document?: { file_name?: string }; voice?: unknown
}
interface TgCallback { id: string; from: TgUser; data?: string; message?: TgMessage }

export class TelegramApi {
  constructor(private base: string, private token: string, private fetchImpl: typeof fetch = fetch) {}
  async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(40_000),
    })
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` })) as { ok: boolean; result?: T; description?: string; error_code?: number }
    if (!data.ok) {
      const status = data.error_code ?? res.status
      throw new ChannelError(`Telegram ${method}: ${data.description ?? res.status}`, { status, fatal: status === 401 || status === 404 })
    }
    return data.result as T
  }
}

export function telegramKind(deps: { fetch?: typeof fetch } = {}) {
  const sessions = new WeakMap<object, { api: TelegramApi; me: TgUser }>()
  const session = async (io: IO) => {
    const known = sessions.get(io)
    if (known) return known
    if (!io.config.token) throw new ChannelError('还没有填写 Bot token', { fatal: true })
    const api = new TelegramApi(io.config.apiUrl, io.config.token, deps.fetch)
    const me = await api.call<TgUser>('getMe')
    io.state.set('bot', me.username ?? '')
    io.facts({ 机器人: me.username ? `@${me.username}` : String(me.id) })
    const value = { api, me }
    sessions.set(io, value)
    return value
  }

  const toMessage = (me: TgUser, msg: TgMessage): ChannelMessage | undefined => {
    const from = msg.from
    if (!from) return undefined
    const text = (msg.text ?? msg.caption ?? '').trim()
    return {
      id: msg.message_id,
      chat: { id: msg.chat.id, type: msg.chat.type === 'private' ? 'private' : 'group', ...(msg.chat.title ? { title: msg.chat.title } : {}) },
      ...(msg.message_thread_id ? { topic: msg.message_thread_id } : {}),
      from: { id: from.id, bot: from.is_bot, self: from.id === me.id, ...(from.username ? { username: from.username } : {}), ...(from.first_name ? { name: from.first_name } : {}) },
      text,
      mentioned: Boolean(me.username && text.toLowerCase().includes(`@${me.username.toLowerCase()}`)),
      replyToBot: msg.reply_to_message?.from?.id === me.id,
      files: msg.photo ? [{ kind: 'image' }] : msg.document ? [{ kind: 'file', ...(msg.document.file_name ? { name: msg.document.file_name } : {}) }] : msg.voice ? [{ kind: 'voice' }] : [],
      at: msg.date * 1000,
    }
  }

  async function pollOnce(io: IO, signal?: AbortSignal, timeout = 0): Promise<void> {
    const { api, me } = await session(io)
    const offset = io.state.get<number>('offset')
    const updates = await api.call<{ update_id: number; message?: TgMessage; callback_query?: TgCallback }[]>('getUpdates',
      { timeout, allowed_updates: ['message', 'callback_query'], ...(offset !== undefined ? { offset } : {}) }, signal)
    for (const u of updates) {
      io.state.set('offset', u.update_id + 1)
      const m = u.message && toMessage(me, u.message)
      if (m) await io.message(m)
      const cb = u.callback_query
      if (cb?.data) {
        const toast = await io.action({ data: cb.data, from: { id: cb.from.id, ...(cb.from.username ? { username: cb.from.username } : {}) },
          ...(cb.message ? { chat: { id: cb.message.chat.id } } : {}), ...(cb.message?.message_thread_id ? { topic: cb.message.message_thread_id } : {}) })
        await api.call('answerCallbackQuery', { callback_query_id: cb.id, ...(toast ? { text: toast } : {}) }).catch(() => {})
      }
    }
  }

  const where = (target: { chat: string; topic?: string }) => ({ chat_id: Number(target.chat), ...(target.topic ? { message_thread_id: Number(target.topic) } : {}) })

  return defineChannel<Config>({
    id: 'telegram',
    title: 'Telegram',
    description: '用 Telegram 机器人在手机上指挥家里的电脑：私聊直接对话，群里 @它。到 @BotFather 创建机器人拿到 token，再把你的 Telegram ID 或用户名加入允许列表（给机器人发 /start 可以看到 ID）。',
    capabilities: { inbound: 'longpoll', threads: 'topic', format: 'plain', maxLength: 4000, edit: true, buttons: true, typing: true, proactive: true },
    config: TelegramConfig,
    fields: [
      { key: 'token', type: 'secret', label: 'Bot token', placeholder: '123456:ABC-…' },
      { key: 'apiUrl', type: 'text', label: 'Bot API 地址', advanced: true },
    ],
    idHint: '你的 Telegram ID 或 @用户名',
    async connect(io) {
      while (!io.signal.aborted) {
        await pollOnce(io, AbortSignal.any([io.signal, AbortSignal.timeout(40_000)]), 25)
        io.online()
      }
    },
    poll: io => pollOnce(io),
    async send(io, target, out) {
      const { api } = await session(io)
      try {
        const sent = await api.call<{ message_id: number }>('sendMessage', { ...where(target), text: out.text,
          ...(out.buttons ? { reply_markup: { inline_keyboard: [out.buttons.map(b => ({ text: b.label, callback_data: b.id }))] } } : {}) })
        return { id: String(sent.message_id) }
      } catch (error) {
        const status = (error as ChannelError).status
        if (status === 403 || status === 400) throw new ChannelError((error as Error).message, { status, gone: true })
        throw error
      }
    },
    async edit(io, target, messageId, out) {
      const { api } = await session(io)
      await api.call('editMessageText', { chat_id: Number(target.chat), message_id: Number(messageId), text: out.text })
    },
  })
}

export const telegramPlugin = definePlugin({ id: 'telegram', name: 'Telegram', version: pkg.version, description: '用 Telegram 远程对话', sources: [telegramKind()] })
