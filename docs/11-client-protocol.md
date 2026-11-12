# 客户端接入协议 v1

糯糯跑在你的电脑（或一台小服务器）上。**任何智能设备**都可以作为它的客户端：手机 App、手表、智能音箱、车机、电视、眼镜、快捷指令、Home Assistant 自动化、一段脚本……它们都说同一套协议。

- 协议地址：`http://<糯糯所在机器>:<端口>/client/v1`（默认端口 7420）
- 传输方式：HTTPS/HTTP + JSON；实时事件用 SSE（Server-Sent Events）
- 认证方式：每台设备有自己的**设备令牌**，靠一次性配对码换取
- SDK：[`@nuonuo/client`](../packages/client)（TypeScript，零依赖）；其他语言照这份文档直接调 HTTP 就行，见 [示例](../examples/clients)

> 网页界面用的 `/api` 是内部接口，会随界面一起改，**设备不要用它**。`/client/v1` 是对外承诺的稳定接口。

## 1. 版本规则

| 规则 | 说明 |
|---|---|
| 主版本在路径里 | `/client/v1`。有不兼容的改动时才会出 `/client/v2`，而且 v1 会继续保留一段时间。 |
| 次版本在 `hello` 和响应头里 | `protocol: "1.0"`，每个响应都带 `x-nuonuo-protocol: 1.0`。 |
| v1 内只做加法 | 只会新增字段、接口、事件类型和 `features`。客户端**必须忽略不认识的字段和事件**。 |
| 用 `features` 判断能力 | 不要靠版本号猜测某个功能在不在，看 `hello.features` 里有没有。 |

## 2. 接入步骤

```
设备                                   糯糯（电脑）
 │                                      │  主人运行 nuonuo pair → 得到配对码 K7QF-2M9D
 │── POST /client/v1/pair {code, device} ─▶│
 │◀──────── {token: "nnd_…", device} ─────│  配对码作废（只能用一次，10 分钟有效）
 │── GET /client/v1/hello  (Bearer nnd_…) ▶│
 │── GET /client/v1/events  (SSE，常连) ──▶│
 │── POST /conversations/main/messages ──▶│
 │◀──── event: message (糯糯的回答) ─────│
```

### 2.1 让设备连得上

糯糯默认只监听本机（127.0.0.1），其他设备连不上。两种办法：

- 在桌面应用的「设置 → 系统 → 网页访问」开启局域网访问，或运行 `nuonuo config --host 0.0.0.0` 后重启。
- 要在外网用，不要直接暴露端口：放在 HTTPS 反向代理之后，或者用 Tailscale / ZeroTier / SSH 隧道。

### 2.2 生成配对码（在电脑上）

```bash
nuonuo pair                    # 默认权限：chat + notices
nuonuo pair --approvals        # 还允许这台设备回答「要不要做」
nuonuo pair --name 客厅音箱     # 由电脑这边指定设备名
nuonuo devices                 # 查看已配对的设备
nuonuo devices revoke dev_xxx  # 移除设备，它的令牌立刻失效
```

主人也可以直接调接口（用主人令牌）：`POST /api/devices/pair`、`GET /api/devices`、`PATCH /api/devices/:id`、`DELETE /api/devices/:id`。

### 2.3 配对（在设备上）

```http
POST /client/v1/pair
Content-Type: application/json

{ "code": "K7QF-2M9D",
  "device": { "name": "客厅音箱", "kind": "speaker", "platform": "esp32-s3", "display": "none" } }
```

```json
201 { "token": "nnd_8xW…", "device": { "id": "dev_…", "name": "客厅音箱", "kind": "speaker", "display": "none",
       "scopes": ["chat", "notices"], "createdAt": 1762912000000, "lastSeenAt": 1762912000000 }, "protocol": "1.0" }
```

- 配对码不分大小写，`-` 和空格可省略。
- `kind`：`phone` `tablet` `watch` `speaker` `car` `tv` `glasses` `desktop` `bot` `other`。
- `display`：`full`（普通聊天屏）、`small`（手表大小）、`none`（没有屏幕，回答会被念出来）。不填时按 `kind` 推断：音箱、车机为 `none`，手表、眼镜为 `small`，其余为 `full`。糯糯会按它调整回答：`none` 时用简短口语、不出表格和链接；`small` 时一两句话。
- 令牌只返回这一次。设备要自己安全地保存（钥匙串、Keystore、加密存储）。
- 10 分钟内错 10 次，所有待用的配对码作废，需在电脑上重新生成。

之后每个请求都带上：`Authorization: Bearer nnd_…`

## 3. 权限（scopes）

| scope | 允许 | 默认 |
|---|---|---|
| `chat` | 看对话、发消息、传附件、收消息事件 | 总是有 |
| `notices` | 收到电脑上会弹出的通知（`notice` 事件） | 有 |
| `approvals` | 看并回答「要不要做」的确认（`approval` 事件、`/approvals`） | 需 `--approvals` |

设备令牌**只能**访问 `/client/v1`，打不开 `/api`，也碰不到设置、密钥、记忆、插件。主人令牌不会离开电脑。

## 4. 接口

所有错误都是同一个格式：

```json
{ "error": { "code": "unauthorized", "message": "设备令牌无效或已被移除：请重新配对" } }
```

| 状态码 | code | 含义 |
|---|---|---|
| 400 | `invalid` / `too_large` | 请求不对 |
| 401 | `unauthorized` / `invalid_code` | 令牌无效（设备被移除）或配对码不对 → 重新配对 |
| 403 | `forbidden` | 这台设备没有对应 scope |
| 404 | `missing` / `not_found` | 对话、消息或接口不存在 |
| 409 | `no_model` / `conflict` | 糯糯还没配模型；或者状态不允许 |
| 429 | `too_many_attempts` | 配对码试错太多 |

### `GET /hello`

握手。连上后先调一次，确认版本和能力。

```json
{ "protocol": "1.0",
  "server": { "name": "nuonuo", "version": "0.2.5" },
  "assistant": { "name": "糯糯", "avatar": "🍡", "color": "#FF7A59", "language": "zh" },
  "device": { "id": "dev_…", "name": "客厅音箱", "kind": "speaker", "display": "none", "scopes": ["chat", "notices"], … },
  "mainConversationId": "cnv_…",
  "features": ["messages", "events.sse", "reply.delta", "uploads", "notices", "idempotency"],
  "limits": { "maxUpload": 52428800, "maxText": 100000 } }
```

### 对话

对话 id 的位置都可以写 `main`，表示主对话（和糯糯的那条长聊天）。

| 接口 | 说明 |
|---|---|
| `GET /conversations` | `{ conversations: [{ id, title, main, pinned, updatedAt, unread, lastMessage }] }` |
| `POST /conversations` `{ title? }` | 新开一个话题 |
| `GET /conversations/:id/messages?after=<消息id>&limit=50` | 不带 `after` 是最新的 `limit` 条；带 `after` 是那条之后的（断线后补齐用），最多 200 |
| `POST /conversations/:id/messages` | 发消息，见下 |
| `POST /conversations/:id/read` | 标记已读 |

**消息**的结构：

```json
{ "id": "msg_…", "conversationId": "cnv_…", "role": "user" | "assistant" | "system", "text": "…",
  "createdAt": 1762912000000, "attachments": [{ "id": "upl_…", "name": "a.jpg", "mime": "image/jpeg", "size": 12345 }],
  "taskId": "tkt_…" | null, "task": { "id": "tkt_…", "title": "查上海明天天气", "state": "working" | "waiting" | "done" } | null,
  "final": true, "device": { "id": "dev_…", "name": "客厅音箱", "kind": "speaker" } | null, "recalled": false }
```

**`final`（只对糯糯的消息有意义）**：糯糯遇到要花时间的事，会先回一句「好，我查一下」，然后开一个任务去做，做完再发真正的回答。前一条 `final: false`（它的 `task.state` 是 `working`），后一条 `final: true`。只能说一句话的设备（音箱、快捷指令）应该等 `final: true` 的那条；有屏幕的设备两条都可以显示。任务卡住要问你时（`task.state: "waiting"`），那条问话也是 `final: true`。

**发消息**：

```http
POST /client/v1/conversations/main/messages
{ "text": "明天要带伞吗？", "attachments": ["upl_…"], "clientId": "7b0c…" }
```

返回 `201 { message }`，就是刚存下的这条（`role: "user"`）。糯糯的回答稍后以 `message` 事件到达，或者轮询 `messages?after=<这条的 id>`，直到出现 `final: true` 的糯糯消息。

`clientId` 是幂等键：网络断了重发时带同一个 `clientId`，不会发出两条（返回 `200 { message, duplicate: true }`）。

### 附件

| 接口 | 说明 |
|---|---|
| `POST /uploads`（multipart，字段 `file`） | `201 { upload: { id, name, mime, size } }`，最大 50 MB。然后把 `id` 放进发消息的 `attachments` |
| `GET /uploads/:id` | 下载 |

### 语音（需 `chat`；`hello.features` 里有 `speech` / `transcribe` 才可用）

| 接口 | 说明 |
|---|---|
| `POST /transcribe`（multipart，字段 `file`） | `{ text, language? }`，用「设置 → 模型 → 听写」的模型；最大 25 MB |
| `POST /speech` `{ text, voice?, format? }` | 返回音频（`content-type` 是音频格式），用「设置 → 模型 → 朗读」的模型 |

主人没设置对应的模型时这两个接口返回 `409 unavailable`，`features` 里也不会有它们。这时设备可以自己做语音识别和合成，和糯糯之间只传文字。

### 确认（需 `approvals`）

| 接口 | 说明 |
|---|---|
| `GET /approvals` | `{ approvals: [{ id, taskId, task, tool, action, risk, reason, createdAt }] }` |
| `POST /approvals/:id` `{ approve: true/false, note? }` | 回答一次（只对这一次有效；「以后都允许」只能在电脑上设） |

### `DELETE /session`

设备自己退出配对，令牌立刻失效。

## 5. 实时事件 `GET /events`

SSE 长连接，每台设备一条。`?conversation=<id|main>` 只收某个对话的消息事件。每 20 秒一个 `ping`。

```
event: ready
id: 0
data: {"protocol":"1.0","device":"dev_…"}

event: message
id: 1
data: {"op":"created","message":{ …消息… }}
```

| event | data | 需要 |
|---|---|---|
| `ready` | `{ protocol, device }` | — |
| `message` | `{ op: "created" \| "updated", message }` | chat |
| `reply.delta` | `{ conversationId, replyId, text }`：糯糯正在写的回答，`text` 是**到目前为止的全文**；写完后会来一条 `message` | chat |
| `conversation` | `{ conversationId }`：标题等变了 | chat |
| `notice` | `{ id, kind, title, body, silent }` | notices |
| `approval` | `{ op: "requested", approval }` 或 `{ op: "resolved", id }` | approvals |
| `ping` | `{}` | — |

规则：

- **事件不重放**。断线重连后，用 `GET /conversations/:id/messages?after=<最后看到的消息 id>` 补齐。
- 设备被移除后，连接会在下一个事件或 ping 时断开，重连得到 401。
- 不支持长连接的设备（比如很省电的单片机），只发消息再轮询 `messages?after=` 就够了，SDK 的 `ask()` 就是这么做的。

## 6. 浏览器里的客户端

`/client/v1` 允许任何来源跨域调用（CORS `*`），因为设备令牌只放在 `Authorization` 头里，不是 Cookie，别的网页拿不到。注意：浏览器原生的 `EventSource` 不能加请求头，请用 SDK 的 `events()`（基于 `fetch` 读流）。

## 7. SDK

```ts
import { NuonuoClient } from '@nuonuo/client'

// 第一次：配对，保存 token
const { token } = await NuonuoClient.pair('http://192.168.1.5:7420', 'K7QF-2M9D', { name: '客厅音箱', kind: 'speaker' })

const nuonuo = new NuonuoClient({ baseUrl: 'http://192.168.1.5:7420', token })
const hello = await nuonuo.hello()

// 一问一答（音箱、快捷指令、脚本）
const reply = await nuonuo.ask('明天要带伞吗？')
console.log(reply.text)

// 实时（手机、手表、车机）
for await (const e of nuonuo.events()) {
  if (e.type === 'reply.delta') render(e.text)
  if (e.type === 'message' && e.message.role === 'assistant') speak(e.message.text)
  if (e.type === 'notice') notify(e.notice.title, e.notice.body)
}
```

其他方法：`conversations()` `createConversation()` `messages()` `send()` `waitForReply()` `markRead()` `upload()` `attachmentUrl()` `approvals()` `decide()` `forget()`。

## 8. 安全要点

- 设备令牌 = 这台设备的钥匙。丢了就在电脑上 `nuonuo devices revoke`。
- 令牌在服务端只存 sha256，配对码只在内存里（服务重启就作废）。
- 局域网里是明文 HTTP；跨网络请一定加 HTTPS（反向代理）或走 VPN。
- 设备发来的消息会标上来源设备（`message.device`），便于追查是哪台设备说的。

## 9. 以后会加的（都在 v1 内，以 `features` 宣布）

- 设置页里的「设备」管理界面（先出 Figma 设计）
- 局域网自动发现（mDNS，`_nuonuo._tcp`）
- 扫码配对（二维码里放地址 + 配对码）
- WebSocket 传输（给不方便用 SSE 的平台）
- 推送（APNs / FCM），让手机 App 在后台也能收到通知
