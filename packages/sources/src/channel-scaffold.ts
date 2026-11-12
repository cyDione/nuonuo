/**
 * `nuonuo channel new`: writes the skeleton of a chat-app adapter from what the app's API can do. A preset is a
 * capability declaration plus the shape of its connection (connect out over a WebSocket, poll, or receive webhooks);
 * the generated plugin loads as it is (the shared fields, allow list and approvals come from the channel layer) and
 * leaves only the app's own API calls as TODOs.
 */
import type { ChannelCapabilities } from './channel.mjs'

type Inbound = ChannelCapabilities['inbound']
type Caps = Partial<ChannelCapabilities> & Pick<ChannelCapabilities, 'inbound'>

export interface ChannelPreset {
  title: string
  /** One line for `nuonuo channel presets`. */
  summary: string
  capabilities: Caps
  idHint: string
  /** Setup steps for the README, one per line. */
  setup: string[]
  /** The app's API base, for the config default. */
  apiUrl: string
}

/**
 * Meta keeps a Graph API version for about two years (v26.0: July 2026 → mid 2028). The generated plugin keeps it in its
 * apiUrl field, so an owner can move to a newer version without regenerating; bump this when Meta retires it.
 */
const GRAPH_VERSION = 'v26.0'

const generic = (inbound: Inbound, summary: string): ChannelPreset => ({
  title: 'MyChat', summary, capabilities: { inbound, threads: 'none', format: 'markdown', maxLength: 4000, buttons: false, edit: false, proactive: true },
  idHint: '你的用户 ID', setup: ['在软件的开发者后台创建机器人，拿到 token。'], apiUrl: 'https://chat.example.com/api',
})

/**
 * Presets for apps without a built-in channel yet. The capability values are what each app's official bot API offers;
 * check them against the docs before publishing (limits change).
 */
export const CHANNEL_PRESETS: Record<string, ChannelPreset> = {
  websocket: generic('websocket', '通用：机器人主动连上软件的长连接（不需要公网地址）'),
  longpoll: generic('longpoll', '通用：机器人定时向软件拉新消息（不需要公网地址）'),
  webhook: generic('webhook', '通用：软件回调一个公网地址（需要公网地址或隧道）'),
  matrix: {
    title: 'Matrix', summary: 'Matrix（/sync 长轮询，回复线程，可以改消息）',
    capabilities: { inbound: 'longpoll', threads: 'reply', format: 'html', maxLength: 16000, edit: true, buttons: false, groups: { mention: true, replyToBot: true }, proactive: true },
    idHint: '你的 Matrix ID（@你:服务器）', apiUrl: 'https://matrix.org',
    setup: ['给机器人注册一个 Matrix 账号，用 /_matrix/client/v3/login 拿到 access token。', '把机器人拉进房间；私聊直接邀请它。'],
  },
  mattermost: {
    title: 'Mattermost', summary: 'Mattermost（WebSocket，回复线程，可以改消息）',
    capabilities: { inbound: 'websocket', threads: 'reply', format: 'markdown', maxLength: 16000, edit: true, buttons: false, groups: { mention: true, replyToBot: false }, proactive: true },
    idHint: '你的 Mattermost 用户名', apiUrl: 'https://mattermost.example.com/api/v4',
    setup: ['系统控制台 → 集成 → 机器人账号，创建机器人，拿到 access token。', '长连接地址是 wss://<你的服务器>/api/v4/websocket。'],
  },
  qq: {
    title: 'QQ 机器人', summary: 'QQ 官方机器人（webhook 回调，被动回复有时间窗口）',
    capabilities: { inbound: 'webhook', threads: 'none', format: 'plain', maxLength: 2000, edit: false, buttons: false, groups: { mention: true, replyToBot: false }, proactive: false },
    idHint: '你的 QQ openid', apiUrl: 'https://api.sgroup.qq.com',
    setup: ['在 QQ 开放平台（q.qq.com）创建机器人，拿到 AppID 和 AppSecret。', '回调地址填 https://<你的公网地址>/plugin/<插件 id>/events，按文档校验签名。'],
  },
  line: {
    title: 'LINE', summary: 'LINE Messaging API（webhook 回调，postback 按钮）',
    capabilities: { inbound: 'webhook', threads: 'none', format: 'plain', maxLength: 5000, edit: false, buttons: true, groups: { mention: true, replyToBot: false }, proactive: true },
    idHint: '你的 LINE userId（U…）', apiUrl: 'https://api.line.me/v2/bot',
    setup: ['在 LINE Developers 创建 Messaging API channel，拿到 channel access token 和 channel secret。', 'Webhook URL 填 https://<你的公网地址>/plugin/<插件 id>/events，用 channel secret 校验 x-line-signature。'],
  },
  whatsapp: {
    title: 'WhatsApp', summary: 'WhatsApp Cloud API（webhook 回调，24 小时内才能回复）',
    capabilities: { inbound: 'webhook', threads: 'none', format: 'plain', maxLength: 4096, edit: false, buttons: true, groups: { mention: false, replyToBot: false }, proactive: false },
    idHint: '你的手机号（国家码开头，不带 +）', apiUrl: `https://graph.facebook.com/${GRAPH_VERSION}`,
    setup: ['在 Meta for Developers 创建应用并添加 WhatsApp，拿到 access token 和 phone number id。', 'Webhook 回调地址填 https://<你的公网地址>/plugin/<插件 id>/events，校验 x-hub-signature-256。'],
  },
  'wechat-mp': {
    title: '微信公众号', summary: '微信公众号（webhook 回调，48 小时内才能用客服消息回复）',
    capabilities: { inbound: 'webhook', threads: 'none', format: 'plain', maxLength: 600, edit: false, buttons: false, groups: { mention: false, replyToBot: false }, proactive: false },
    idHint: '你在公众号下的 openid', apiUrl: 'https://api.weixin.qq.com/cgi-bin',
    setup: ['公众号后台 → 设置与开发 → 基本配置，拿到 AppID、AppSecret，设置 Token。', '服务器地址填 https://<你的公网地址>/plugin/<插件 id>/events，按文档校验 signature。'],
  },
}

export interface ScaffoldOptions {
  /** Plugin and source id: lowercase letters, digits and dashes. */
  name: string
  preset?: string
  title?: string
}

const NAME = /^[a-z][a-z0-9-]{1,39}$/

/** The files of a new channel plugin, by relative path. */
export function scaffoldChannel(opts: ScaffoldOptions): Record<string, string> {
  if (!NAME.test(opts.name)) throw new Error('名字只能用小写字母、数字和 -，以字母开头，2 到 40 个字符')
  const presetId = opts.preset ?? 'websocket'
  const preset = CHANNEL_PRESETS[presetId]
  if (!preset) throw new Error(`没有这个预设：${presetId}。可选：${Object.keys(CHANNEL_PRESETS).join('、')}`)
  const id = opts.name
  const title = opts.title ?? (preset.title === 'MyChat' ? id : preset.title)
  const pkg = {
    name: `nuonuo-${id}`, version: '0.1.0', description: `在 ${title} 里和糯糯对话`, type: 'module', license: 'MIT',
    nuonuo: { id, plugin: './index.mjs', name: title, apiVersion: 1 },
  }
  return {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'index.mjs': indexMjs(id, title, preset, presetId),
    'README.md': readme(id, title, preset, presetId),
    '.gitignore': 'node_modules\n',
  }
}

/** A JS string literal in the generated code's style (single quotes). */
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
/** An object literal in the generated code's style: `{ inbound: 'websocket', maxLength: 4000 }`. */
const literal = (v: unknown): string => (v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${literal(x)}`).join(', ')} }` : typeof v === 'string' ? q(v) : String(v))

function indexMjs(id: string, title: string, preset: ChannelPreset, presetId: string): string {
  const caps = preset.capabilities
  const L: string[] = []
  L.push(`/**`)
  L.push(` * ${title} 渠道（由 \`nuonuo channel new --preset ${presetId}\` 生成）。`)
  L.push(` * 准入名单、群里 @、/new、长消息切分、确认、断线重连都由 Channel 层做好；这里只写 ${title} 的 API。`)
  L.push(` * 带 TODO 的地方换成 ${title} 官方文档里的接口。`)
  L.push(` */`)
  L.push(`export default ({ definePlugin, defineChannel, ChannelError, z }) => {`)
  L.push(`  /** 调一次 ${title} 的 HTTP 接口。 */`)
  L.push(`  async function api(io, method, path, body) {`)
  L.push(`    // TODO: 换成 ${title} 的鉴权方式`)
  L.push(`    const res = await fetch(\`\${io.config.apiUrl.replace(/\\/$/, '')}/\${path}\`, {`)
  L.push(`      method, headers: { authorization: \`Bearer \${io.config.token}\`, 'content-type': 'application/json' },`)
  L.push(`      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),`)
  L.push(`    })`)
  L.push(`    const data = await res.json().catch(() => ({}))`)
  L.push(`    if (!res.ok) throw new ChannelError(\`${title} \${path}：\${data.message ?? res.status}\`, { status: res.status, gone: res.status === 404, fatal: res.status === 401 })`)
  L.push(`    return data`)
  L.push(`  }`)
  L.push(``)
  L.push(`  /** 把 ${title} 的一条消息翻译成 Channel 层的形状。 */`)
  L.push(`  // TODO: 按 ${title} 的消息结构改字段名`)
  L.push(`  const toMessage = (m, me) => ({`)
  L.push(`    id: m.id,`)
  L.push(`    chat: { id: m.chat_id, type: m.is_private ? 'private' : 'group' },`)
  if (caps.threads !== 'none') L.push(`    ...(m.thread_id ? { topic: m.thread_id } : {}),`)
  L.push(`    from: { id: String(m.user_id), username: m.username, bot: Boolean(m.is_bot), self: m.user_id === me },`)
  L.push(`    text: m.text ?? '',`)
  L.push(`    mentioned: Boolean(m.mentions_me),`)
  if (caps.groups?.replyToBot !== false) L.push(`    replyToBot: m.reply_to_user_id === me,`)
  L.push(`    at: m.timestamp ? Number(m.timestamp) : Date.now(),`)
  L.push(`  })`)
  L.push(``)
  L.push(`  return definePlugin({`)
  L.push(`    id: ${q(id)},`)
  L.push(`    sources: [defineChannel({`)
  L.push(`      id: ${q(id)},`)
  L.push(`      title: ${q(title)},`)
  L.push(`      description: ${q(`在 ${title} 里和糯糯对话。${caps.inbound === 'webhook' ? '需要一个公网地址给它回调。' : '不需要公网地址。'}`)},`)
  L.push(`      // ${title} 能做什么。Channel 层只看这里：按钮决定确认怎么问，maxLength 决定怎么切长消息。`)
  L.push(`      capabilities: ${literal(caps)},`)
  L.push(`      // allowed（允许派活的账号）和 approvals（在这里回答确认）由 Channel 层加上`)
  L.push(`      config: z.object({`)
  L.push(`        token: z.string().default(''),`)
  if (caps.inbound === 'webhook') L.push(`        signingSecret: z.string().default(''),`)
  L.push(`        apiUrl: z.string().url().default(${q(preset.apiUrl)}),`)
  L.push(`      }),`)
  L.push(`      fields: [`)
  L.push(`        { key: 'token', type: 'secret', label: 'Token' },`)
  if (caps.inbound === 'webhook') L.push(`        { key: 'signingSecret', type: 'secret', label: '回调签名密钥' },`)
  L.push(`        { key: 'apiUrl', type: 'text', label: 'API 地址', advanced: true },`)
  L.push(`      ],`)
  L.push(`      idHint: ${q(preset.idHint)},`)
  L.push(``)
  if (caps.inbound === 'websocket') {
    L.push(`      // 连上长连接，一直读到断开（正常返回）或失败（抛异常）；断了 Channel 层会退避重连。`)
    L.push(`      async connect(io) {`)
    L.push(`        if (!io.config.token) throw new ChannelError('还没有填写 token', { fatal: true })`)
    L.push(`        // TODO: 换成 ${title} 拿长连接地址和自己身份的接口`)
    L.push(`        const me = (await api(io, 'GET', 'me')).id`)
    L.push(`        const { url } = await api(io, 'POST', 'connections/open')`)
    L.push(`        const ws = io.socket(url)`)
    L.push(`        await io.runSocket(ws, {`)
    L.push(`          open: () => io.online(),`)
    L.push(`          message: async raw => {`)
    L.push(`            const frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))`)
    L.push(`            // TODO: ${title} 要求回执、心跳时在这里回`)
    L.push(`            if (frame.type === 'message') await io.message(toMessage(frame.data, me))`)
    if (caps.buttons) L.push(`            if (frame.type === 'button') await io.action({ data: frame.data.value, from: { id: String(frame.data.user_id) }, chat: { id: frame.data.chat_id } })`)
    L.push(`          },`)
    L.push(`        })`)
    L.push(`      },`)
  } else if (caps.inbound === 'longpoll') {
    L.push(`      // 一直拉新消息；出错就抛，Channel 层会退避重连。`)
    L.push(`      async connect(io) {`)
    L.push(`        if (!io.config.token) throw new ChannelError('还没有填写 token', { fatal: true })`)
    L.push(`        // TODO: 换成 ${title} 拿自己身份和拉消息的接口`)
    L.push(`        const me = (await api(io, 'GET', 'me')).id`)
    L.push(`        io.online()`)
    L.push(`        while (!io.signal.aborted) {`)
    L.push(`          const since = io.state.get('cursor')`)
    L.push(`          const page = await api(io, 'GET', \`updates?timeout=30\${since ? \`&since=\${encodeURIComponent(since)}\` : ''}\`)`)
    L.push(`          for (const m of page.messages ?? []) await io.message(toMessage(m, me))`)
    if (caps.buttons) L.push(`          for (const b of page.buttons ?? []) await io.action({ data: b.value, from: { id: String(b.user_id) }, chat: { id: b.chat_id } })`)
    L.push(`          if (page.next) io.state.set('cursor', page.next)`)
    L.push(`          if (!(page.messages ?? []).length) await io.sleep(1_000)`)
    L.push(`        }`)
    L.push(`      },`)
  } else {
    L.push(`      // ${title} 回调 https://<公网地址>/plugin/${id}/events。不用糯糯的登录令牌，所以一定要校验签名。`)
    L.push(`      async webhook(io, request, path) {`)
    L.push(`        if (path !== 'events') return undefined`)
    L.push(`        const body = await request.text()`)
    L.push(`        // TODO: 按 ${title} 的文档校验签名（通常是用 signingSecret 对 body 做 HMAC-SHA256）`)
    L.push(`        if (!io.config.signingSecret || !(await verify(io.config.signingSecret, body, request.headers.get('x-signature') ?? ''))) return new Response('bad signature', { status: 401 })`)
    L.push(`        const event = JSON.parse(body)`)
    L.push(`        // TODO: ${title} 要求先回 200 再处理时，把下面放到后台`)
    L.push(`        if (event.type === 'message') await io.message(toMessage(event.data, event.bot_id))`)
    if (caps.buttons) L.push(`        if (event.type === 'button') await io.action({ data: event.data.value, from: { id: String(event.data.user_id) }, chat: { id: event.data.chat_id } })`)
    L.push(`        return new Response('ok')`)
    L.push(`      },`)
  }
  L.push(``)
  L.push(`      // 发一条（Channel 层已经切好、转好格式）。聊天没了抛 ChannelError({ gone: true })。`)
  L.push(`      async send(io, target, out) {`)
  L.push(`        // TODO: 换成 ${title} 发消息的接口`)
  L.push(`        const sent = await api(io, 'POST', 'messages', {`)
  L.push(`          chat_id: target.chat, text: out.text,`)
  if (caps.threads !== 'none') L.push(`          ...(target.topic ? { thread_id: target.topic } : {}),`)
  if (caps.buttons) L.push(`          ...(out.buttons?.length ? { buttons: out.buttons.map(b => ({ label: b.label, value: b.id })) } : {}),`)
  L.push(`        })`)
  L.push(`        return { id: String(sent.id) }`)
  L.push(`      },`)
  if (caps.edit) {
    L.push(``)
    L.push(`      // 把已经回答的确认标上「已同意 / 已拒绝」，去掉按钮。`)
    L.push(`      async edit(io, target, messageId, out) {`)
    L.push(`        // TODO: 换成 ${title} 改消息的接口`)
    L.push(`        await api(io, 'PUT', \`messages/\${encodeURIComponent(messageId)}\`, { chat_id: target.chat, text: out.text })`)
    L.push(`      },`)
  }
  L.push(`    })],`)
  L.push(`  })`)
  L.push(`}`)
  if (caps.inbound === 'webhook') {
    L.push(``)
    L.push(`/** HMAC-SHA256(secret, body) 的十六进制，和请求头比较。 */`)
    L.push(`async function verify(secret, body, signature) {`)
    L.push(`  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])`)
    L.push(`  const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('hex')`)
    L.push(`  return mac.length === signature.length && mac === signature.toLowerCase()`)
    L.push(`}`)
  }
  return `${L.join('\n')}\n`
}

function readme(id: string, title: string, preset: ChannelPreset, presetId: string): string {
  const caps = preset.capabilities
  const yes = (b?: boolean) => (b ? '能' : '不能')
  return `# ${title} 渠道

在 ${title} 里和糯糯对话。由 \`nuonuo channel new ${id} --preset ${presetId}\` 生成，基于糯糯的 Channel 层。

## 能力

| | |
|---|---|
| 收消息 | ${caps.inbound === 'websocket' ? '长连接（不需要公网地址）' : caps.inbound === 'longpoll' ? '长轮询（不需要公网地址）' : 'webhook 回调（需要公网地址）'} |
| 话题 | ${caps.threads === 'none' ? '没有' : caps.threads === 'topic' ? '话题' : '回复线程'} |
| 格式 | ${caps.format ?? 'plain'}，每条最多 ${caps.maxLength ?? 4000} 字 |
| 按钮 | ${yes(caps.buttons)}${caps.buttons ? '（确认是「同意 / 拒绝」按钮）' : '（确认时回复「同意」或「拒绝」）'} |
| 改消息 | ${yes(caps.edit)} |
| 主动发消息 | ${yes(caps.proactive)} |

能力值来自 ${title} 的官方机器人接口，发布前请对照官方文档再核对一遍。

## 还要写的

\`index.mjs\` 里带 \`TODO\` 的地方：鉴权、${caps.inbound === 'webhook' ? '校验回调签名' : '拿连接地址'}、消息字段、发消息${caps.edit ? '、改消息' : ''}。其他的（谁能派活、群里 @、\`/new\`、长消息切分、确认、断线重连）Channel 层都做好了，见 [聊天渠道](https://github.com/cyDione/nuonuo/blob/main/docs/12-channels.md)。

## 设置

${preset.setup.map(s => `1. ${s.replace(/<插件 id>/g, id)}`).join('\n')}
1. 在糯糯的「设置 → 插件」里从本机文件夹安装这个文件夹，启用它。
1. 到「设置 → 来源 → ${title}」填好，把你自己的 ID 加进「允许派活的账号」（不知道 ID 就给机器人发 \`/start\`）。
`
}
