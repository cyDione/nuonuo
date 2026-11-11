# 插件 SDK

插件给智能体增加**来源**（Source）：一条事件流，加上回到原处的回复渠道。也可以给主 Agent 和 Worker 增加工具、提示词和环境变量。GitHub、定时任务、Telegram、Gmail 都是按这套协议写的；第三方插件和它们用的是同一套接口。

## 安装与启用

1. 把插件文件夹放进 `~/.super-assistant/plugins/<名字>/`。
2. 到「设置 → 插件」里启用它。在启用之前，只会读取它的 `package.json`，**不会执行插件代码**。插件以本机服务的权限运行，所以启用前要确认你信任它。
3. 到「设置 → 来源」里配置并打开它提供的来源。

`package.json`：

```json
{
  "name": "rss-watch",
  "version": "0.1.0",
  "super-assistant": { "plugin": "./index.mjs", "name": "RSS 订阅", "apiVersion": 1 }
}
```

## 最小插件

入口模块默认导出一个函数。函数参数就是 SDK，包括 `definePlugin`、`tool`、`jsonSchema`、`z`，所以插件本身不需要安装任何依赖：

```js
export default function plugin({ definePlugin, z, tool }) {
  return definePlugin({
    id: 'hello',
    sources: [{
      id: 'hello',
      title: '示例来源',
      description: '每小时问一次好',
      schema: z.object({ greeting: z.string().default('你好') }),
      fields: [{ key: 'greeting', type: 'text', label: '问候语' }],
      start(ctx) {
        const timer = setInterval(() => ctx.notify(ctx.config.greeting), 3600_000)
        return () => clearInterval(timer)
      },
    }],
  })
}
```

完整的示例见 [`examples/plugins/rss-watch`](../examples/plugins/rss-watch/index.mjs)。用 TypeScript 写插件时，从 `@super-assistant/plugin-sdk` 导入类型即可。

## SourceKind 接口

| 成员 | 必需 | 作用 |
|---|---|---|
| `id` `title` `description` | ✓ | `id` 只能用小写字母、数字、`-` 和 `_`，不能和已有的来源重名 |
| `schema` `fields` | ✓ | 用 zod 校验配置；`fields` 用来自动生成设置表单（`text` / `number` / `switch` / `select` / `list` / `secret`） |
| `start(ctx)` | ✓ | 开始读取事件，返回一个停止函数 |
| `poll(ctx)` | | 设置页「立即同步」按钮会调用它 |
| `allowed(ctx, actor)` | | 这个账号能不能通过这个来源派活。不实现时，任何人都不能派活 |
| `send(ctx, message)` | | 回复渠道。会话已不存在时返回 `'gone'`；抛出异常则稍后重试（退避 5 秒到 300 秒） |
| `threadInfo` | | 生成卡片上显示的线程摘要 |
| `routerPrompt` / `routerTools` | | 给主 Agent 增加的提示词和工具 |
| `workerPrompt` / `workerTools` / `workerEnv` | | 给 Worker 增加的提示词、工具和环境变量 |
| `actions` + `http` | | 设置卡片上的按钮（例如「授权」），以及插件自己的 HTTP 端点。`public: true` 的端点挂在 `/plugin/<id>/…` 下，不需要令牌，所以插件必须自己校验 state 参数 |

## 上下文 `ctx`

| 成员 | 作用 |
|---|---|
| `config` | 校验后的配置；`secret` 字段的值从钥匙串读出 |
| `engine.receive(trigger)` | 送入一个事件，详见下文。`source` 必须是这个来源的 id，`threadId` 必须以 `<id>:` 开头 |
| `engine.follow / followed / threadClosed` | 任务关注的线程：只能是本来源自己的线程（`<id>:` 开头），`followed()` 也只列出这些 |
| `engine.mainConversation() / conversationOfThread(id)` | 查找主对话、某个线程对应的对话 |
| `state.get/set` | 插件自己的持久化小状态，例如游标、缓存 |
| `secret.get/set/delete` | 运行时拿到的密钥，例如 OAuth 刷新令牌，存在钥匙串里 |
| `notify(text)` | 不经过模型，直接在这个来源自己的对话里通知你 |
| `health(status, detail)` / `facts({...})` | 设置卡片上显示的状态和信息 |
| `signal` | 来源停止时会被触发（abort） |

### 插件能用的接口

第三方插件拿到的 `ctx.engine` 只有上表这几个方法，`ctx.store`（数据库）不可用，调用别的成员会直接报错。这样插件只能经由自己的渠道送事件，不能冒充网页聊天或别的来源、不能结束任务、不能直接写记忆或改数据库。随应用一起发布的内置来源不受这个限制。

## 事件（IncomingTrigger）

```ts
ctx.engine.receive({
  id: 'myapp:msg:123',            // 由来源自己的 id 派生；重复读取同一事件不会产生重复
  source: 'myapp',
  threadId: 'myapp:room-7',       // 同一线程里的后续消息会直接交给正在处理它的任务
  actor: 'alice', human: true,    // 谁说的；机器人消息永远不能派活
  addressed: true,                // 是不是在叫智能体（@它、私聊……）
  text: '帮我…', at: Date.now(), url: 'https://…',
  thread: { title: 'myapp · room 7', url: 'https://…' },
})
```

Engine 处理一个事件的规则：

1. 先把事件交给订阅了这个线程的任务。交给任务只是提供信息，不授予新的权限。
2. 如果没有任务接手，并且是 `allowed` 允许的人在 `addressed` 智能体，就把它交给主 Agent 当作请求处理。
3. 其余事件只记录下来，然后忽略。

第一次需要处理某个外部线程时，会自动为它生成一个镜像对话。主 Agent 回复时带上 `reply_to`，回复就会经由你的 `send` 发回来源。

## 安全

- 插件代码运行在本机服务的进程里，和服务权限相同。所以第三方插件默认不加载，要你手动启用。上面受限的 `ctx` 挡住的是经由接口越权，挡不住恶意代码本身（它仍可以读写文件、发网络请求），只启用你信任的插件。
- 第三方插件的工具名必须以 `<来源 id>_` 开头（例如 `rss_search`），否则会被忽略，这样插件不能顶替应用自带的 `shell`、`reply` 这类工具。
- 第三方插件在 `writes` 里列出的写操作工具，每次调用前都会先问你批准；在「权限」里把来源设为「只能看」时，这些工具直接去掉。
- 令牌、API key 这类配置请用 `secret` 字段：它们存进系统钥匙串，不会写进数据库，设置页只显示「已设置」。
- Worker 的命令行环境里会去掉凭据类的环境变量。插件给 Worker 提供能力时，应该通过工具（在插件进程里拿到凭据），而不是把凭据放进环境变量。
