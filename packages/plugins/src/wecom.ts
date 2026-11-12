/**
 * WeCom (企业微信) intelligent bot (智能机器人) over its long connection: the bot connects out to
 * wss://openws.work.weixin.qq.com with its Bot ID and Secret, so no public URL is needed. Messages arrive as
 * `aibot_msg_callback` frames; replies go out over the same connection (`aibot_send_msg`), so sending needs the
 * connection to be up (a reply waits in the queue until it is). Everything chat apps share comes from the channel layer.
 *
 * Frames are JSON: `{ cmd, headers: { req_id }, body }`; the server answers a request with `{ headers: { req_id }, errcode }`.
 */
import { ChannelError, defineChannel, definePlugin, fetchFile, z, type ChannelIO, type ChannelMessage, type SocketLike } from '@nuonuo/plugin-sdk'
import { createDecipheriv, randomBytes } from 'node:crypto'
import pkg from '../package.json' with { type: 'json' }

export const WeComConfig = z.object({
  botId: z.string().trim().default(''),
  secret: z.string().default(''),
  wsUrl: z.string().url().default('wss://openws.work.weixin.qq.com'),
}).strict()
type Config = z.infer<typeof WeComConfig>
type IO = ChannelIO<Config>

interface WcFrame { cmd?: string; headers?: { req_id?: string }; body?: any; errcode?: number; errmsg?: string }
interface Live { ws: SocketLike; pending: Map<string, { resolve(f: WcFrame): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }> }

const reqId = (prefix: string) => `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`

/** The text of a message: text, mixed (图文), or a note for media. Group messages start with the @mention, which is dropped. */
/** A media item's download link (valid five minutes) and its own key: `ref` for `download()`. */
const media = (o: any) => (typeof o?.url === 'string' ? { ref: { url: o.url, ...(o.aeskey ? { aeskey: String(o.aeskey) } : {}) } } : {})

function contentOf(m: any): { text: string; files: ChannelMessage['files'] } {
  const strip = (t: string) => (m.chattype === 'group' ? t.replace(/^@\S+\s*/, '') : t).trim()
  if (m.msgtype === 'text') return { text: strip(String(m.text?.content ?? '')), files: [] }
  if (m.msgtype === 'mixed') {
    const items: any[] = m.mixed?.msg_item ?? []
    return { text: strip(items.map(i => i.text?.content ?? '').filter(Boolean).join('\n')), files: items.filter(i => i.image).map(i => ({ kind: 'image' as const, ...media(i.image) })) }
  }
  if (m.msgtype === 'image') return { text: '', files: [{ kind: 'image', ...media(m.image) }] }
  // WeCom transcribes voice itself and sends only the text.
  if (m.msgtype === 'voice') return { text: String(m.voice?.content ?? ''), files: m.voice?.content ? [] : [{ kind: 'voice' }] }
  if (m.msgtype === 'file') return { text: '', files: [{ kind: 'file', ...(m.file?.filename ? { name: m.file.filename } : {}), ...media(m.file) }] }
  return { text: `[${m.msgtype}]`, files: [] }
}

/**
 * Media from the long connection is encrypted per file: AES-256-CBC with the base64 `aeskey`, the IV its first 16
 * bytes, PKCS#7 padded to 32-byte blocks (so Node's own 16-byte unpadding is turned off).
 */
export function decryptMedia(data: Uint8Array, aeskey: string): Uint8Array {
  const key = Buffer.from(aeskey, 'base64')
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const out = Buffer.concat([decipher.update(data), decipher.final()])
  const pad = out[out.length - 1] ?? 0
  if (pad < 1 || pad > 32 || pad > out.length) throw new Error('企业微信文件解密失败')
  return new Uint8Array(out.subarray(0, out.length - pad))
}

export function wecomKind(deps: { socket?: (url: string) => SocketLike; fetch?: typeof fetch } = {}) {
  const lives = new WeakMap<object, Live>()

  const request = (live: Live, cmd: string, body: unknown, prefix = cmd, timeoutMs = 15_000) => new Promise<WcFrame>((resolve, reject) => {
    const id = reqId(prefix)
    const timer = setTimeout(() => { live.pending.delete(id); reject(new ChannelError(`企业微信没有回应（${cmd}）`)) }, timeoutMs)
    live.pending.set(id, { resolve, reject, timer })
    try { live.ws.send(JSON.stringify({ cmd, headers: { req_id: id }, ...(body !== undefined ? { body } : {}) })) } catch (error) { clearTimeout(timer); live.pending.delete(id); reject(error as Error) }
  })

  return defineChannel<Config>({
    id: 'wecom',
    title: '企业微信',
    description: '在企业微信里和糯糯对话：单聊直接说，群里 @它。在企业微信管理后台创建「智能机器人」，API 模式选「长连接」，拿到 Bot ID 和 Secret 填在这里。不需要公网地址。',
    capabilities: { inbound: 'websocket', threads: 'none', format: 'markdown', maxLength: 2000, groups: { mention: true, replyToBot: false }, files: { in: true, out: false, maxBytes: 100 * 1024 * 1024 }, proactive: true },
    config: WeComConfig,
    fields: [
      { key: 'botId', type: 'text', label: 'Bot ID' },
      { key: 'secret', type: 'secret', label: 'Secret' },
      { key: 'wsUrl', type: 'text', label: '长连接地址', advanced: true, hint: '私有部署的企业在管理后台查看。' },
    ],
    idHint: '你的企业微信 userid',
    async connect(io) {
      if (!io.config.botId || !io.config.secret) throw new ChannelError('还没有填写 Bot ID 和 Secret', { fatal: true })
      const ws = deps.socket ? deps.socket(io.config.wsUrl) : io.socket(io.config.wsUrl)
      const live: Live = { ws, pending: new Map() }
      let beat: ReturnType<typeof setInterval> | undefined
      let failed: ChannelError | undefined
      try {
        await io.runSocket(ws, {
          open: () => {
            request(live, 'aibot_subscribe', { bot_id: io.config.botId, secret: io.config.secret }).then(() => {
              lives.set(io, live)
              io.facts({ 机器人: io.config.botId })
              io.online()
              beat = setInterval(() => { request(live, 'ping', undefined).catch(() => ws.close(4000)) }, 30_000)
            }, error => { failed = new ChannelError(`企业微信认证失败：${(error as Error).message}`, { fatal: true }); ws.close(4001) })
          },
          immediate: raw => {
            const frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as WcFrame
            if (frame.cmd) return false
            const waiting = live.pending.get(frame.headers?.req_id ?? '')
            if (!waiting) return true
            live.pending.delete(frame.headers!.req_id!)
            clearTimeout(waiting.timer)
            if (frame.errcode && frame.errcode !== 0) waiting.reject(new ChannelError(`${frame.errmsg ?? '出错了'}（${frame.errcode}）`, { status: frame.errcode }))
            else waiting.resolve(frame)
            return true
          },
          message: async raw => {
            const frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as WcFrame
            if (frame.cmd === 'aibot_msg_callback') {
              const m = frame.body ?? {}
              const { text, files } = contentOf(m)
              const group = m.chattype === 'group'
              await io.message({
                id: m.msgid, chat: { id: group ? m.chatid : m.from?.userid, type: group ? 'group' : 'private' },
                from: { id: String(m.from?.userid ?? '') }, text, files,
                mentioned: group, // a group only delivers messages that @ the bot
                at: m.create_time ? Number(m.create_time) * (Number(m.create_time) < 1e12 ? 1000 : 1) : Date.now(),
              })
              return
            }
            if (frame.cmd === 'aibot_event_callback') {
              if (frame.body?.event?.eventtype === 'disconnected_event') { failed = new ChannelError('同一个机器人在别处连上了，这里的连接被断开'); ws.close(4002) }
              return
            }
          },
        })
      } finally {
        clearInterval(beat)
        if (lives.get(io) === live) lives.delete(io)
        for (const w of live.pending.values()) { clearTimeout(w.timer); w.reject(new ChannelError('连接断开了')) }
        live.pending.clear()
      }
      if (failed) throw failed
    },
    async send(io, target, out) {
      const live = lives.get(io)
      if (!live) throw new ChannelError('还没有连上企业微信，稍后重发')
      await request(live, 'aibot_send_msg', { chatid: target.chat, msgtype: 'markdown', markdown: { content: out.text } })
      return {}
    },
    async download(_io, file) {
      const ref = file.ref as { url: string; aeskey?: string }
      // The link came from WeCom's own frame on the bot's authenticated connection, not from what a user typed.
      if (!ref.url.startsWith('https://')) return undefined
      const got = await fetchFile(ref.url, { maxBytes: 100 * 1024 * 1024, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      return { bytes: ref.aeskey ? decryptMedia(got.bytes, ref.aeskey) : got.bytes, ...(file.name ? { name: file.name } : {}) }
    },
  })
}

export const wecomPlugin = definePlugin({ id: 'wecom', name: '企业微信', version: pkg.version, description: '在企业微信里和糯糯对话', sources: [wecomKind()] })
