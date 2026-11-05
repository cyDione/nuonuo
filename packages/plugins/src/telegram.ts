/**
 * Telegram: talk to your own computer from your phone. A bot you create with @BotFather long-polls the Bot API (no public
 * URL needed); messages from allowed accounts become requests, and the agent answers in the same chat.
 * Private chats always address the agent; in groups, mention the bot or reply to it. `/new` starts a fresh topic.
 */
import { definePlugin, z, type SourceContext, type SourceKind } from '@super-assistant/plugin-sdk'
import pkg from '../package.json' with { type: 'json' }

export const TelegramConfig = z.object({
  token: z.string().default(''),
  allowed: z.array(z.string().trim().min(1)).default([]),
  apiUrl: z.string().url().default('https://api.telegram.org'),
}).strict()
type Config = z.infer<typeof TelegramConfig>
type Ctx = SourceContext<Config>

interface TgUser { id: number; is_bot: boolean; username?: string; first_name?: string }
interface TgMessage {
  message_id: number; date: number; text?: string; caption?: string; from?: TgUser
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string; first_name?: string }
  message_thread_id?: number; reply_to_message?: { from?: TgUser }; photo?: unknown[]; document?: { file_name?: string }; voice?: unknown
}

export class TelegramApi {
  constructor(private base: string, private token: string, private fetchImpl: typeof fetch = fetch) {}
  async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(40_000),
    })
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` })) as { ok: boolean; result?: T; description?: string; error_code?: number }
    if (!data.ok) throw Object.assign(new Error(`Telegram ${method}: ${data.description ?? res.status}`), { status: data.error_code ?? res.status })
    return data.result as T
  }
}

const label = (u?: TgUser) => (u?.username ? `@${u.username}` : u?.first_name ?? String(u?.id ?? ''))

export function telegramKind(deps: { fetch?: typeof fetch } = {}): SourceKind<Config> {
  const sessions = new WeakMap<object, { api: TelegramApi; me: TgUser }>()
  const session = async (ctx: Ctx) => {
    const known = sessions.get(ctx)
    if (known) return known
    if (!ctx.config.token) throw new Error('还没有填写 Bot token')
    const api = new TelegramApi(ctx.config.apiUrl, ctx.config.token, deps.fetch)
    const me = await api.call<TgUser>('getMe')
    ctx.state.set('bot', me.username ?? '')
    ctx.facts({ 机器人: label(me) })
    const value = { api, me }
    sessions.set(ctx, value)
    return value
  }
  const allowed = (ctx: Ctx, actor: string) => {
    const username = ctx.state.get<string>(`user:${actor}`)
    return ctx.config.allowed.some(a => a === actor || (username && a.replace(/^@/, '').toLowerCase() === username.toLowerCase()))
  }
  const topicOf = (ctx: Ctx, chatId: number, threadId?: number) => `telegram:${chatId}${threadId ? `:${threadId}` : ''}:${ctx.state.get<number>(`epoch:${chatId}`) ?? 0}`
  const parse = (id: string) => {
    const m = /^telegram:(-?\d+)(?::(\d+))?:(\d+)$/.exec(id)
    return m ? { chatId: Number(m[1]), threadId: m[2] ? Number(m[2]) : undefined } : undefined
  }

  async function handle(ctx: Ctx, api: TelegramApi, me: TgUser, msg: TgMessage): Promise<void> {
    const from = msg.from
    if (!from || from.id === me.id) return
    const actor = String(from.id)
    if (from.username) ctx.state.set(`user:${actor}`, from.username)
    const text = (msg.text ?? msg.caption ?? '').trim()
    const extra = msg.photo ? '[图片]' : msg.document ? `[文件 ${msg.document.file_name ?? ''}]` : msg.voice ? '[语音]' : ''
    const reply = (t: string) => api.call('sendMessage', { chat_id: msg.chat.id, text: t, ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}) })
    if (text === '/start' || text.startsWith('/start ')) {
      await reply(allowed(ctx, actor) ? '你好！直接发消息给我就行，我会在你的电脑上处理。/new 开始一个新话题。'
        : `这是一个私人智能体。如果你是它的主人，请把你的 Telegram ID ${actor} 加到 设置 → 来源 → Telegram 的允许列表里。`)
      return
    }
    if (text === '/new' || text.startsWith('/new@')) {
      if (!allowed(ctx, actor)) return
      ctx.state.set(`epoch:${msg.chat.id}`, Date.now())
      await reply('好的，开始一个新话题。')
      return
    }
    const mention = me.username ? text.toLowerCase().includes(`@${me.username.toLowerCase()}`) : false
    const addressed = msg.chat.type === 'private' || mention || msg.reply_to_message?.from?.id === me.id
    const chatName = msg.chat.type === 'private' ? `私聊 ${label(from)}` : msg.chat.title ?? String(msg.chat.id)
    ctx.engine.receive({
      id: `telegram:${msg.chat.id}:${msg.message_id}`, source: 'telegram', threadId: topicOf(ctx, msg.chat.id, msg.message_thread_id),
      actor, human: !from.is_bot, addressed, text: [text, extra].filter(Boolean).join(' ') || '（空消息）', at: msg.date * 1000,
      meta: { chatId: msg.chat.id, messageId: msg.message_id, from: label(from) },
      thread: { title: `Telegram · ${chatName}`, meta: { chatId: msg.chat.id } },
    })
  }

  async function pollOnce(ctx: Ctx, signal?: AbortSignal, timeout = 0): Promise<void> {
    const { api, me } = await session(ctx)
    const offset = ctx.state.get<number>('offset')
    const updates = await api.call<{ update_id: number; message?: TgMessage; edited_message?: TgMessage }[]>('getUpdates',
      { timeout, allowed_updates: ['message'], ...(offset !== undefined ? { offset } : {}) }, signal)
    for (const u of updates) {
      ctx.state.set('offset', u.update_id + 1)
      if (u.message) await handle(ctx, api, me, u.message)
    }
  }

  return {
    id: 'telegram',
    title: 'Telegram',
    description: '用 Telegram 机器人在手机上指挥家里的电脑：私聊直接对话，群里 @它。到 @BotFather 创建机器人拿到 token，再把你的 Telegram ID 或用户名加入允许列表（给机器人发 /start 可以看到 ID）。',
    schema: TelegramConfig,
    fields: [
      { key: 'token', type: 'secret', label: 'Bot token', placeholder: '123456:ABC-…' },
      { key: 'allowed', type: 'list', label: '允许派活的账号', placeholder: '你的 Telegram ID 或 @用户名', hint: '每行一个。其他人发来的消息会被忽略。' },
      { key: 'apiUrl', type: 'text', label: 'Bot API 地址', advanced: true },
    ],
    poll: ctx => pollOnce(ctx),
    start(ctx) {
      let stopped = false
      const loop = async () => {
        let failures = 0
        while (!stopped && !ctx.signal.aborted) {
          try {
            await pollOnce(ctx, AbortSignal.any([ctx.signal, AbortSignal.timeout(40_000)]), 25)
            failures = 0
            ctx.health('ok', '在线')
          } catch (error) {
            if (ctx.signal.aborted) break
            failures++
            const status = (error as { status?: number }).status
            if (failures >= 3 || status === 401 || status === 404) ctx.health('error', (error as Error).message)
            await new Promise(r => setTimeout(r, Math.min(60_000, 2_000 * 2 ** failures)))
          }
        }
      }
      void loop()
      return () => { stopped = true }
    },
    allowed,
    async send(ctx, message) {
      const target = parse(message.threadId)
      if (!target) return 'gone'
      const { api } = await session(ctx)
      // Plain text (Telegram's Markdown dialects reject much of what models write); split at the 4096-character limit.
      for (let i = 0; i < message.text.length; i += 4000) {
        try {
          await api.call('sendMessage', { chat_id: target.chatId, text: message.text.slice(i, i + 4000), ...(target.threadId ? { message_thread_id: target.threadId } : {}) })
        } catch (error) {
          const status = (error as { status?: number }).status
          if (status === 403 || status === 400) return 'gone'
          throw error
        }
      }
      return {}
    },
    threadInfo(_ctx, id) {
      const t = parse(id)
      return t ? `Telegram chat ${t.chatId}${t.threadId ? ` topic ${t.threadId}` : ''} (replies are plain text, keep them short)` : undefined
    },
  }
}

export const telegramPlugin = definePlugin({ id: 'telegram', name: 'Telegram', version: pkg.version, description: '用 Telegram 远程对话', sources: [telegramKind()] })
