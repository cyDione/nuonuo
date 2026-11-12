/**
 * DingTalk (钉钉) robot in Stream mode: the app connects out (POST /v1.0/gateway/connections/open returns a WebSocket
 * endpoint and ticket), so no public URL is needed. Robot messages arrive as CALLBACK frames on the topic
 * /v1.0/im/bot/messages/get and are acknowledged at once; replies go out through the robot OpenAPI, one-to-one to a
 * user or into a group. Groups only deliver messages that @ the robot. Everything chat apps share comes from the channel layer.
 */
import { appToken, ChannelError, defineChannel, definePlugin, z, type ChannelIO, type ChannelMessage, type SocketLike } from '@nuonuo/plugin-sdk'
import pkg from '../package.json' with { type: 'json' }

export const DingTalkConfig = z.object({
  clientId: z.string().trim().default(''),
  clientSecret: z.string().default(''),
  apiUrl: z.string().url().default('https://api.dingtalk.com'),
}).strict()
type Config = z.infer<typeof DingTalkConfig>
type IO = ChannelIO<Config>

export const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get'

interface DtFrame { specVersion?: string; type: 'SYSTEM' | 'EVENT' | 'CALLBACK'; headers: { topic?: string; messageId?: string; [k: string]: unknown }; data?: string }

export class DingTalkApi {
  /** The app token, cached until five minutes before it expires (shared `appToken`). */
  readonly accessToken = appToken(async () => {
    const data = await this.call<{ accessToken: string; expireIn: number }>('/v1.0/oauth2/accessToken', { appKey: this.clientId, appSecret: this.clientSecret }, false)
    return { token: data.accessToken, expiresIn: data.expireIn }
  })
  constructor(private base: string, private clientId: string, private clientSecret: string, private fetchImpl: typeof fetch = fetch) {}

  async call<T>(path: string, body: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (auth) headers['x-acs-dingtalk-access-token'] = await this.accessToken()
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    const data = await res.json().catch(() => ({})) as T & { code?: string; message?: string }
    if (!res.ok) {
      const code = String(data.code ?? res.status)
      throw new ChannelError(`钉钉 ${path}: ${data.message ?? code}`, { status: res.status, fatal: res.status === 401 || code === 'invalidClientIdOrSecret', gone: /resource\.not\.found|robot\.not\.in\.group|chatbot.*not.*exist/i.test(code) })
    }
    return data
  }

  endpoint() {
    return this.call<{ endpoint: string; ticket: string }>('/v1.0/gateway/connections/open', {
      clientId: this.clientId, clientSecret: this.clientSecret, ua: 'nuonuo',
      subscriptions: [{ type: 'EVENT', topic: '*' }, { type: 'CALLBACK', topic: DINGTALK_ROBOT_TOPIC }],
    }, false)
  }
}

function contentOf(d: any): { text: string; files: ChannelMessage['files'] } {
  if (d.msgtype === 'text') return { text: String(d.text?.content ?? '').trim(), files: [] }
  if (d.msgtype === 'richText') return { text: (d.content?.richText ?? []).map((n: any) => n.text ?? '').join('').trim(), files: (d.content?.richText ?? []).some((n: any) => n.pictureDownloadCode || n.downloadCode) ? [{ kind: 'image' }] : [] }
  if (d.msgtype === 'picture') return { text: '', files: [{ kind: 'image' }] }
  if (d.msgtype === 'audio') return { text: String(d.content?.recognition ?? ''), files: d.content?.recognition ? [] : [{ kind: 'voice' }] }
  if (d.msgtype === 'file') return { text: '', files: [{ kind: 'file', ...(d.content?.fileName ? { name: d.content.fileName } : {}) }] }
  return { text: `[${d.msgtype}]`, files: [] }
}

export function dingtalkKind(deps: { fetch?: typeof fetch; socket?: (url: string) => SocketLike } = {}) {
  const apis = new WeakMap<object, DingTalkApi>()
  const api = (io: IO) => {
    let a = apis.get(io)
    if (!a) {
      if (!io.config.clientId || !io.config.clientSecret) throw new ChannelError('还没有填写 Client ID 和 Client Secret', { fatal: true })
      a = new DingTalkApi(io.config.apiUrl, io.config.clientId, io.config.clientSecret, deps.fetch)
      apis.set(io, a)
    }
    return a
  }

  return defineChannel<Config>({
    id: 'dingtalk',
    title: '钉钉',
    description: '在钉钉里和糯糯对话：单聊直接说，群里 @它。在钉钉开放平台创建企业内部应用，添加机器人，消息接收模式选「Stream 模式」，再把 Client ID 和 Client Secret 填在这里。不需要公网地址。',
    capabilities: { inbound: 'websocket', threads: 'none', format: 'markdown', maxLength: 3000, groups: { mention: true, replyToBot: false }, proactive: true },
    config: DingTalkConfig,
    fields: [
      { key: 'clientId', type: 'text', label: 'Client ID（AppKey）', links: [{ label: '钉钉开放平台', href: 'https://open-dev.dingtalk.com/' }] },
      { key: 'clientSecret', type: 'secret', label: 'Client Secret（AppSecret）' },
      { key: 'apiUrl', type: 'text', label: 'API 地址', advanced: true },
    ],
    idHint: '你的钉钉 userId（staffId）',
    async connect(io) {
      const { endpoint, ticket } = await api(io).endpoint()
      const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`
      const ws = deps.socket ? deps.socket(url) : io.socket(url)
      const reply = (messageId: unknown, data: unknown) => ws.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data: JSON.stringify(data) }))
      await io.runSocket(ws, {
        open: () => { io.facts({ 应用: io.config.clientId }); io.online() },
        message: async raw => {
          const frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as DtFrame
          if (frame.type === 'SYSTEM') {
            if (frame.headers.topic === 'ping') ws.send(JSON.stringify({ code: 200, headers: frame.headers, message: 'OK', data: frame.data }))
            else if (frame.headers.topic === 'disconnect') ws.close(4000)
            return
          }
          // Acknowledge first, so the platform does not push the same message again within its retry window.
          reply(frame.headers.messageId, frame.type === 'EVENT' ? { status: 'SUCCESS', message: 'success' } : { response: null })
          if (frame.type !== 'CALLBACK' || frame.headers.topic !== DINGTALK_ROBOT_TOPIC || !frame.data) return
          const d = JSON.parse(frame.data)
          const group = String(d.conversationType) === '2'
          const sender = String(d.senderStaffId || d.senderId || '')
          const { text, files } = contentOf(d)
          await io.message({
            id: d.msgId, chat: { id: group ? d.conversationId : `@${sender}`, type: group ? 'group' : 'private', ...(d.conversationTitle ? { title: d.conversationTitle } : {}) },
            from: { id: sender, ...(d.senderNick ? { name: d.senderNick } : {}) },
            text, files, mentioned: group ? d.isInAtList !== false : false, at: Number(d.createAt) || Date.now(),
          })
        },
      })
    },
    async send(io, target, out) {
      const msgParam = JSON.stringify({ title: out.text.replace(/\s+/g, ' ').slice(0, 20) || '糯糯', text: out.text })
      const robotCode = io.config.clientId
      const sent = target.chat.startsWith('@')
        ? await api(io).call<{ processQueryKey?: string }>('/v1.0/robot/oToMessages/batchSend', { robotCode, userIds: [target.chat.slice(1)], msgKey: 'sampleMarkdown', msgParam })
        : await api(io).call<{ processQueryKey?: string }>('/v1.0/robot/groupMessages/send', { robotCode, openConversationId: target.chat, msgKey: 'sampleMarkdown', msgParam })
      return sent.processQueryKey ? { id: sent.processQueryKey } : {}
    },
  })
}

export const dingtalkPlugin = definePlugin({ id: 'dingtalk', name: '钉钉', version: pkg.version, description: '在钉钉里和糯糯对话', sources: [dingtalkKind()] })
