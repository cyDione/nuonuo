# 聊天渠道（Channel 层）

糯糯接聊天软件时，每个软件不再完整写一套。所有聊天软件都需要的东西写在 **Channel 层**里，一次写好；每个软件只写一个**适配器**：说清楚这个软件能做什么，连上去，把消息翻译进来，把回复翻译出去。

Channel 层在 [`packages/sources/src/channel.mjs`](../packages/sources/src/channel.mjs)，类型在 `channel.d.mts`。它是不依赖任何包的普通 JavaScript，所以第三方插件在沙箱里也能直接用。`defineChannel` 生成的是普通的 `SourceKind`（见 [插件 SDK](04-plugin-sdk.md)），引擎、设置页和沙箱都不用为它特殊处理。

内置的 Telegram、飞书、Discord、企业微信、钉钉、Slack 都是这样写的：[`packages/plugins/src`](../packages/plugins/src)。

## Channel 层替每个软件做的事

| 事 | 做法 |
|---|---|
| 谁能派活 | 自动加上「允许派活的账号」字段，认 ID，也认 @用户名。陌生人发 `/start` 时告诉他自己的 ID |
| 是不是在叫糯糯 | 私聊总是；群里按能力声明里的 `groups`：@它，或回复它的消息 |
| 话题 | 线程 id 统一是 `<来源>:<聊天>[:<话题>]:<epoch>`；`/new` 换一个 epoch，开始新对话 |
| 长消息 | 按 `maxLength` 在段落、换行、空格处切开 |
| 格式 | `format: 'plain'` 的软件会把模型写的 Markdown 转成纯文本 |
| 要不要做的确认 | 见下文「在聊天软件里回答确认」 |
| 连接 | `connect()` 断了就按退避重连（2 秒起，最长 60 秒）；令牌无效等情况把来源标成出错 |
| 给模型的提示 | 从能力声明生成 `threadInfo`（格式、长度），不用各写各的 |
| 去重 | 事件 id 由来源、聊天和消息 id 组成，同一条消息读两次也只算一次 |

## 用脚手架起步

```bash
nuonuo channel presets                       # 看有哪些能力预设
nuonuo channel new matrix --preset matrix    # 生成 ./matrix：package.json、index.mjs、README.md
```

预设就是一份能力声明加上连接方式：`websocket`、`longpoll`、`webhook` 是通用的；`matrix`、`mattermost`、`qq`、`line`、`whatsapp`、`wechat-mp`（公众号）按这些软件官方机器人接口的能力填好了。生成的插件不改也能装上、启用，设置页里有准入名单和确认开关；剩下的只有 `index.mjs` 里带 `TODO` 的地方：鉴权、连接地址、消息字段、发消息（能改消息时还有改消息）。写好后在「设置 → 插件」里从本机文件夹安装。

能力值发布前请对照官方文档再核对一遍，限额会变。

## 写一个适配器

```js
export default ({ definePlugin, defineChannel, ChannelError, z }) => definePlugin({
  id: 'mychat',
  sources: [defineChannel({
    id: 'mychat',
    title: 'MyChat',
    description: '在 MyChat 里和糯糯对话。',
    capabilities: { inbound: 'websocket', threads: 'none', format: 'markdown', maxLength: 4000, edit: true, buttons: true },
    config: z.object({ token: z.string().default('') }),          // allowed、approvals 由 Channel 层加上
    fields: [{ key: 'token', type: 'secret', label: 'Bot token' }],
    idHint: '你的 MyChat 用户 ID',

    // 连上去，一直读到连接断开（正常返回）或失败（抛异常）
    async connect(io) {
      const ws = io.socket('wss://mychat.example/gateway')
      await io.runSocket(ws, {
        open: () => io.online(),
        message: async raw => {
          const m = JSON.parse(raw)
          if (m.type === 'message') await io.message({
            id: m.id, chat: { id: m.chat, type: m.dm ? 'private' : 'group' },
            from: { id: m.user.id, username: m.user.name, bot: m.user.bot, self: m.user.id === m.me },
            text: m.text, mentioned: m.mentionsMe,
          })
          if (m.type === 'button') await io.action({ data: m.value, from: { id: m.user.id }, chat: { id: m.chat } })
        },
      })
    },

    // 发一条（已经切好、转好格式）。聊天不存在了就抛 ChannelError({ gone: true })
    async send(io, target, out) {
      const res = await fetch(`https://mychat.example/api/chats/${target.chat}/messages`, {
        method: 'POST', headers: { authorization: `Bot ${io.config.token}` },
        body: JSON.stringify({ text: out.text, buttons: out.buttons?.map(b => ({ label: b.label, value: b.id })) }),
      })
      if (res.status === 404) throw new ChannelError('聊天不存在', { gone: true })
      return { id: (await res.json()).id }
    },

    // capabilities.edit 为 true 时需要：用来把已回答的确认卡片标上「已同意」并去掉按钮
    async edit(io, target, messageId, out) { /* … */ },
  })],
})
```

只能回调公网地址的软件（`inbound: 'webhook'`）不写 `connect`，写 `webhook(io, request, path)`：软件调 `https://<公网地址>/plugin/<id>/<path>`，这个地址不需要糯糯的登录令牌，所以**一定要校验软件的签名**，然后把消息交给 `io.message`。脚手架的 `webhook` 预设里有 HMAC 校验的写法。

适配器只写 API 调用。`io` 上有：`config`、`state`、`secret`、`log`、`facts`、`online()`、`sleep()`、`socket(url)`、`runSocket(ws, handlers)`、`message(m)`、`action(a)`。

### 能力声明

| 字段 | 取值 | 影响 |
|---|---|---|
| `inbound` | `longpoll` / `websocket` / `webhook` | `webhook` 表示软件要回调一个公网地址；糯糯通常在家里的电脑上，所以优先用长轮询或长连接 |
| `threads` | `none` / `reply` / `topic` | 有话题时，线程 id 带上话题，回复回到同一个话题 |
| `groups` | `{ mention, replyToBot }` | 群里怎样算在叫糯糯 |
| `format` | `plain` / `markdown` / `html` | `plain` 时 Markdown 转纯文本 |
| `maxLength` | 数字 | 一条消息最多多少字，超过就切开 |
| `edit` | 布尔 | 能不能改已发的消息（需要 `edit()`） |
| `buttons` | 布尔 | 确认用按钮还是回复文字 |
| `typing`、`files`、`proactive` | | 先声明，后面的版本会用上 |

## 在聊天软件里回答确认

任务需要你点头（比如要删文件）时，如果这个任务是从某个聊天软件派的，而且你在「设置 → 来源 → 这个软件」里打开了**允许在这里回答「要不要做」**，确认也会发到派活的那个聊天里：

- 软件支持按钮（Telegram、飞书、Discord）：消息下面有「同意 / 拒绝」按钮。
- 不支持按钮：回复「同意」或「拒绝」（也认 1 / 2）。
- 只有允许列表里的账号能回答，而且只能回答这个来源自己的任务。
- 在网页或其他设备上回答了，聊天里的卡片会标上「已同意 / 已拒绝」，按钮去掉。

这个开关默认关着：打开后，谁拿到你的聊天账号，谁就能批准命令。

## 内置渠道

| 渠道 | 收消息 | 话题 | 按钮 | 设置 |
|---|---|---|---|---|
| Telegram | Bot API 长轮询 | 论坛群话题 | inline keyboard | @BotFather 拿 token |
| 飞书 / Lark | 长连接（不需要公网地址） | 话题回复 | 消息卡片 | 开放平台创建企业自建应用，开启机器人；事件订阅选「长连接」，订阅 `im.message.receive_v1`；卡片回调也选长连接 |
| Discord | Gateway WebSocket | thread 是独立频道 | components | Developer Portal 创建机器人，打开 MESSAGE CONTENT 权限 |
| 企业微信 | 智能机器人长连接（不需要公网地址） | 没有 | 没有，回复「同意 / 拒绝」 | 管理后台创建「智能机器人」，API 模式选「长连接」，填 Bot ID 和 Secret。群里只会收到 @它的消息 |
| 钉钉 | Stream 模式（不需要公网地址） | 没有 | 没有，回复「同意 / 拒绝」 | 开放平台创建企业内部应用，添加机器人，消息接收模式选「Stream 模式」，填 Client ID 和 Client Secret |
| Slack | Socket Mode（不需要公网地址） | 回复线程 | Block Kit 按钮 | api.slack.com 创建应用，打开 Socket Mode（xapp- 开头的 App token），订阅 `message.im`、`app_mention`，装到工作区拿 xoxb- 开头的 Bot token |

飞书、企业微信、钉钉同一个机器人的长连接只有一个客户端能收到消息（企业微信会把旧的连接踢掉），所以同一个机器人不要同时接两台糯糯。

## 以后

- 下一期：个人微信 ClawBot（官方插件仍在灰度，先评估；不使用非官方协议）、QQ、Matrix，以及只支持 webhook 的软件（LINE、WhatsApp、公众号）配合公网隧道（适配器已经能用脚手架生成，缺的是不暴露家里电脑的公网入口）。
- 收发图片和文件（`files` 能力），以及设置页上的能力标签（先出 Figma）。
- 原生手机 / 手表 / 音箱 App 暂缓，以后走 [客户端接入协议](11-client-protocol.md)。
