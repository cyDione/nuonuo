# @nuonuo/client

Nuonuo（糯糯）[客户端接入协议 v1](../../docs/11-client-protocol.md) 的 SDK。零依赖，只用 `fetch`、`ReadableStream` 和 `TextDecoder`，Node 18+、Deno、Bun、浏览器、React Native，以及手表、电视、车机上的 webview 都能直接用。

```ts
import { NuonuoClient } from '@nuonuo/client'

// 1. 在电脑上运行 `nuonuo pair` 得到配对码，然后在设备上：
const { token } = await NuonuoClient.pair('http://192.168.1.5:7420', 'K7QF-2M9D', { name: '客厅音箱', kind: 'speaker' })
// 把 token 存进钥匙串或加密存储

// 2. 之后：
const nuonuo = new NuonuoClient({ baseUrl: 'http://192.168.1.5:7420', token })
const hello = await nuonuo.hello()            // 协议版本、糯糯的名字和头像、这台设备的权限

const reply = await nuonuo.ask('明天要带伞吗？', { onProgress: m => speak(m.text) })
speak(reply.text)                               // 等的是最终回答（final: true）

for await (const e of nuonuo.events()) {        // 自动重连
  if (e.type === 'reply.delta') render(e.text)  // 到目前为止的全文
  if (e.type === 'message') show(e.message)
  if (e.type === 'notice') notify(e.notice.title, e.notice.body)
  if (e.type === 'approval' && e.op === 'requested') askOwner(e.approval)  // 配对时需带 --approvals
}
```

| 方法 | 说明 |
|---|---|
| `NuonuoClient.pair(baseUrl, code, device)` | 用配对码换设备令牌 |
| `hello()` | 握手：协议版本、`features`、主对话 id |
| `conversations()` / `createConversation(title?)` | 话题列表 / 新话题 |
| `messages(conversation = 'main', { after, limit })` | 历史消息；`after` 用于断线后补齐 |
| `send(text, { conversation, attachments, clientId })` | 发消息（自动带幂等键） |
| `ask(text, { onProgress, timeoutMs })` / `waitForReply(message)` | 发送并等最终回答 |
| `upload(blob, name)` / `attachmentUrl(id)` | 附件 |
| `approvals()` / `decide(id, approve, note?)` | 回答「要不要做」 |
| `markRead(conversation)` / `forget()` | 标记已读 / 退出配对 |
| `events({ conversation, signal })` | 实时事件（SSE，基于 fetch，可带鉴权头） |

出错时抛 `NuonuoError`，带 `status` 和 `code`（见协议文档的错误表）。401 表示设备已被移除，需要重新配对。
