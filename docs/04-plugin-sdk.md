# 插件 SDK

插件给智能体增加**来源**（Source）：一条事件流，加上回到原处的回复渠道。也可以给主 Agent 和 Worker 增加工具、提示词和环境变量。GitHub、定时任务、Telegram、飞书、Discord、企业微信、钉钉、Slack、Gmail 都是按这套协议写的；第三方插件和它们用的是同一套接口。

## 插件能接进哪里

一个插件可以只做其中一件，也可以全都做。除了「自己的页面」，每一项都会在系统里某个固定的位置生效：

| 接入点 | 在 `definePlugin` 里写 | 在系统里的位置 |
|---|---|---|
| 来源 | `sources`（或用 `defineChannel` 接聊天软件） | 事件进 Engine，回复经 `send` 回到原处；设置在「设置 → 来源」 |
| 工具 | `routerTools` / `workerTools`，写操作列进 `writes` | 主 Agent / Worker 的工具表；`writes` 里的每次调用先问你 |
| 提示词 | `routerPrompt` / `workerPrompt` | 系统提示词末尾，插件开着时一直在 |
| 每轮上下文 | `inlineContext` | 主 Agent 每次回答你之前，附在这一轮输入后面 |
| 会做的事 | `skills` | 「它是谁 → 会做的事」，默认关着 |
| MCP 服务 | `mcpServers` | 和你自己的 MCP 服务器一起连接，Worker 调用时过审核 |
| 授权 | `sdk.oauth(...)` / `sdk.appToken(...)` | 来源设置卡片上的「授权」按钮，令牌进钥匙串 |
| 设置 | package.json `nuonuo.settings` | 插件窗口的「设置」页，按字段自动生成；代码里 `ctx.settings.get` |
| 自己的页面 | package.json `nuonuo.window` + `windowCalls` | 插件页上的「打开」，页面完全由插件自己写 |

插件只通过这些接入点和系统打交道，拿不到数据库，也不能冒充别的来源或内置工具（见最后的「安全」）。内置的「个性与心境」就是只用 `inlineContext`、`routerTools` 和插件状态拼出来的，见 [`packages/plugins/src/mood.ts`](../packages/plugins/src/mood.ts)。

## 安装与启用

1. 安装：调用 `POST /api/plugins/install`，`source` 可以是
   - 本机文件夹：`/path/to/plugin`、`~/dev/plugin`
   - GitHub 仓库：`owner/repo`、`github:owner/repo#v1.0`、`https://github.com/owner/repo/tree/main/plugins/rss`（仓库里的子目录）
   - npm 包：`nuonuo-rss`、`@me/nuonuo-rss@1.2.0`
   - `.tgz` 的 https 网址

   也可以直接把插件文件夹放进 `~/.nuonuo/plugins/<名字>/`。两种方式装进来的插件都**默认关着，不会执行插件代码**，只读取 `package.json`。
2. 到「设置 → 插件」里启用它。插件在单独的受限进程里运行（见下面的「安全」），但启用前仍要确认你信任它。
3. 到「设置 → 来源」里配置并打开它提供的来源。

安装时会自动装好 `package.json` 里的 `dependencies`（不装 `devDependencies`），直接从 npm 下载，不需要电脑上装了 npm。为了安全，**依赖的安装脚本不会运行**：需要编译原生模块的包装不上，插件页会提示；这类依赖请打包进插件。依赖的版本必须是 npm 版本号，`github:`、`file:` 这类写法会被拒绝。插件文件夹里已经带了 `node_modules` 时不会重新安装。

其他接口：

| 接口 | 作用 |
|---|---|
| `GET /api/plugins` | 列出插件，带 `origin`（从哪里装的）、`sources`、`mcpServers` |
| `POST /api/plugins/:id` `{enabled}` | 启用 / 停用 |
| `POST /api/plugins/:id/update` | 从原来的地址装最新版；启用中的插件会自动重新加载。手动放进文件夹的插件没有地址，不能自动更新 |
| `POST /api/plugins/:id/reload` | 改了插件文件后重新执行它的代码 |
| `DELETE /api/plugins/:id` | 卸载：停掉、删除文件夹，并清掉它的来源设置、状态和密钥字段 |

`package.json`：

```json
{
  "name": "rss-watch",
  "version": "0.1.0",
  "nuonuo": { "plugin": "./index.mjs", "name": "RSS 订阅", "apiVersion": 1 }
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

完整的示例见 [`examples/plugins/rss-watch`](../examples/plugins/rss-watch/index.mjs)。用 TypeScript 写插件时，从 `@nuonuo/plugin-sdk` 导入类型即可。

**接聊天软件**（微信、飞书、Discord、Slack……）不要从 `SourceKind` 写起，用 SDK 里的 `defineChannel`：准入名单、群里 @、`/new`、长消息切分、在聊天里回答确认、断线重连都已经写好，适配器只管连接和翻译消息。见 [聊天渠道](12-channels.md)。

## 工具、提示词和会做的事

不需要事件来源的插件，可以直接给智能体加工具和提示词，也可以带上「会做的事」（技能）：

```js
export default ({ definePlugin, tool, z }) => definePlugin({
  id: 'calc',
  routerTools: ctx => ({
    calc_add: tool({ description: '加法', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => a + b }),
  }),
  workerTools: ctx => ({ calc_save: tool({ /* … */ }) }),
  writes: ['calc_save'],                 // 每次调用前先问你
  routerPrompt: '算钱的时候用 calc_add。',
  workerPrompt: ctx => '…',
  skills: [{ name: '算账', when: '要算钱的时候', steps: '- 先用 calc_add 加总\n- 再…' }],
})
```

- 工具名必须以 `<插件 id>_` 开头，否则会被忽略。
- `ctx` 有 `id`、`dir`（插件文件夹）、`state.get/set`（插件自己的小状态）、`settings.get`（你在插件设置里填的值，含密钥）和 `log`。
- `inlineContext(ctx, { text, scope })`：主 Agent 每次回答你的新消息前调用，返回的文字附在这批输入的后面（在召回的记忆之后），而不是放进系统提示词，所以每轮都变也不会打破提示词缓存。`text` 是这批新消息的原文，`scope` 是所属项目。要在 1.5 秒内返回，超时或出错就跳过这一轮；最多 2,000 字。内置的「心境」就是这样写的，见 [`packages/plugins/src/mood.ts`](../packages/plugins/src/mood.ts)。
- 插件带来的会做的事出现在「它是谁 → 会做的事」里，**默认关着**，你打开后才生效；插件停用时它们也不生效，卸载插件时一起删掉。

## 设置和窗口

插件可以在 package.json 里声明自己的**设置**和**窗口**。它们写在清单里而不是代码里，所以插件还没打开时，插件页就能显示设置、打开窗口。

```json
"nuonuo": {
  "plugin": "./index.mjs",
  "settings": [
    { "key": "shareWithAgent", "label": "让糯糯看到便签", "type": "switch" },
    { "key": "limit", "label": "最多几条", "type": "number", "min": 1, "max": 50 },
    { "key": "token", "label": "令牌", "type": "secret" }
  ],
  "window": { "page": "ui/index.html", "title": "便签", "width": 420, "height": 520 }
}
```

- `settings` 的字段和来源的设置表单一样：`switch`、`number`、`text`、`list`、`select`（`options`）、`secret`。`secret` 存进钥匙串，界面上只显示“已设置”。可以写 `default` 作为默认值。代码里用 `ctx.settings.get('limit')` 读。
- `window.page` 是插件文件夹里的一个 html 文件。它和同一文件夹（及子文件夹）里的文件一起，在一个**隔离的框**里打开：没有同源权限，不能联网，也碰不到糯糯的接口。
- 页面里引入 `<script src="__nuonuo.js"></script>`，就能用 `await nuonuo.call(name, input)` 找插件，由插件的 `windowCalls[name](ctx, input)` 回答（返回普通 JSON；抛出的错误会变成 reject）。`nuonuo.close()` 关窗口，`nuonuo.theme` 是 `light` 或 `dark`，`<html data-theme>` 会跟着变。
- 插件没打开时窗口也能看，但 `nuonuo.call` 会报「插件没开」。

### 写一个自己的页面

页面就是普通的 html、css 和 js，用什么框架都行（打包好放进文件夹即可）。最小的一套：

```html
<!-- ui/index.html -->
<!doctype html>
<html>
<head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><script src="__nuonuo.js"></script></head>
<body>
  <button id="go">刷新</button> <span id="out"></span>
  <script src="app.js"></script>
</body>
</html>
```

```js
// ui/app.js
const show = async () => { const { count } = await nuonuo.call('stats', null); out.textContent = `共 ${count} 条` }
go.onclick = () => show().catch(e => { out.textContent = e.message })
show()
```

```js
// index.mjs
export default ({ definePlugin }) => definePlugin({
  id: 'counter',
  windowCalls: {
    stats: ctx => ({ count: ctx.state.get('count') ?? 0 }),
  },
})
```

要注意的几点：

- **数据放在插件里，不放在页面里。** 页面没有同源权限，`localStorage`、cookie 都用不了；要存的东西经 `nuonuo.call` 交给插件，用 `ctx.state` 存。
- **页面不能联网。** 内容安全策略禁止了 `fetch`、外部脚本和外部图片。要访问网络，就在插件代码里做（插件进程可以联网），再把结果交给页面。
- **能加载的文件**：页面所在文件夹及其子文件夹里的 html、js/mjs、css、json、svg、png、jpg、gif、webp、ico、woff/woff2、txt。插件的其他文件（包括入口代码和 package.json）页面拿不到。
- **深浅色**：`nuonuo.theme` 是打开时的主题，`<html data-theme="light|dark">` 会跟着应用切换；需要自己处理时监听 `nuonuo:theme` 事件。用 `[data-theme=dark]` 写深色样式即可。
- **窗口大小**：`width` 320 ~ 1200，`height` 240 ~ 900，默认 520 × 600；手机上全屏显示。
- `windowCalls` 的函数可以是 async；输入和返回值都要能 JSON 化。页面能调用的只有 `windowCalls` 里列出的名字。

完整例子见 [`examples/plugins/notes`](../examples/plugins/notes)：一个便签本，页面里增删便签，设置里能限制条数，并可以选择让糯糯在聊天时看到这些便签（`routerPrompt`）。

## `definePlugin` 成员一览

| 成员 | 作用 |
|---|---|
| `id` | 必需。小写字母、数字、`-`、`_`，写成和 package.json 的 `name`（或 `nuonuo.id`）一样 |
| `name` `version` `description` | 显示在插件页上 |
| `sources` | 事件来源，见下面的 SourceKind 接口 |
| `routerTools(ctx)` / `workerTools(ctx)` | 给主 Agent / Worker 的工具，名字以 `<插件 id>_` 开头 |
| `writes` | 有后果的工具名，每次调用前问你 |
| `routerPrompt` / `workerPrompt` | 字符串，或 `ctx => 字符串`（返回 `undefined` 就不加） |
| `inlineContext(ctx, { text, scope })` | 每轮上下文，1.5 秒、2,000 字以内 |
| `skills` | 会做的事：`{ name, when, steps }` |
| `mcpServers` | MCP 服务器 |
| `windowCalls` | 自己的页面能调用的函数 |

工具、提示词、`inlineContext` 和 `windowCalls` 收到的 `ctx` 是同一个：`id`、`dir`、`state.get/set`、`settings.get`、`log`。来源的 `ctx` 不一样，见下面的「上下文 `ctx`」。

## 开发和调试

1. 新建一个文件夹，放 `package.json`（带 `nuonuo.plugin`）和入口文件，直接放进 `~/.nuonuo/plugins/<名字>/`，或者用 `POST /api/plugins/install` 装本机路径。
2. 在「设置 → 插件」里打开它；有窗口或设置的话，点「打开」。
3. 改了代码以后点 ⋯ →「重新加载」；只改了页面文件的话，关掉窗口再打开就行。改了 package.json 里的 `settings` / `window` 也要重新加载。
4. `ctx.log(...)` 和报错会打印在服务的日志里；加载失败的原因显示在插件页上。调试时可以设置 `NUONUO_PLUGIN_SANDBOX=off`，让插件直接在服务进程里运行。
5. 页面本身用浏览器开发者工具调试即可：它就是插件窗口里的一个 iframe。

## 授权

要登录第三方账号的来源，不要自己写 OAuth。用 SDK 里的 `oauth` 声明一下，授权按钮、回调、刷新令牌、断开授权（以及到对方那里撤销）都由共用实现处理：

```js
export default sdk => {
  const auth = sdk.oauth({
    flow: 'code',                       // 'code'：跳到对方页面登录后回到 /plugin/<id>/oauth/callback（带 PKCE）
                                        // 'device'：显示一个验证码让你去对方页面输入，不需要回调地址
    label: 'Notion',                    // 按钮上显示「授权 Notion」
    clientId: config => config.clientId,
    clientSecret: config => config.clientSecret,
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    onGrant: async (ctx, token) => ({ 账号: (await whoami(token)).name }),  // 返回的内容显示在设置卡片上
  })
  return sdk.definePlugin({ id: 'notion', name: 'Notion', version: '0.1.0', sources: [auth.source({ id: 'notion', /* … */ })] })
}
```

调用接口时用 `await auth.accessToken(ctx)` 拿令牌，过期了会自动刷新；没授权时会抛出 `status: 401` 的错误。对方给了 refresh token 时只存 refresh token，access token 只放在内存里；没给时存 access token 本身。

飞书、钉钉这类「应用凭证换 token」的接口用 `sdk.appToken(async () => ({ token, expiresIn }))`：拿到的令牌会缓存到过期前五分钟，同时发起的请求共用一次获取；遇到 401 时调用 `.reset()`。

## MCP 服务器

插件也可以带上 MCP 服务器，启用插件后它们和「设置 → MCP」里你自己的服务器一起连接：

```js
definePlugin({
  id: 'notes',
  mcpServers: [{ name: 'files', transport: 'stdio', command: 'node', args: ['server.mjs'], roles: ['worker'] }],
})
```

- 服务名会变成 `<插件 id>_<name>`（上例是 `notes_files`）；和你自己的服务器重名时，用你自己的。
- stdio 服务在插件自己的文件夹里启动，所以 `args` 可以写相对路径。
- `roles` 默认只给 Worker。Worker 调用插件的 MCP 工具时，**总会经过审核层**。

## SourceKind 接口

| 成员 | 必需 | 作用 |
|---|---|---|
| `id` `title` `description` | ✓ | `id` 只能用小写字母、数字、`-` 和 `_`，不能和已有的来源重名 |
| `schema` `fields` | ✓ | 用 zod 校验配置；`fields` 用来自动生成设置表单（`text` / `number` / `switch` / `select` / `list` / `secret`） |
| `start(ctx)` | ✓ | 开始读取事件，返回一个停止函数 |
| `poll(ctx)` | | 设置页「立即同步」按钮会调用它 |
| `allowed(ctx, actor)` | | 这个账号能不能通过这个来源派活。不实现时，任何人都不能派活 |
| `send(ctx, message)` | | 回复渠道。会话已不存在时返回 `'gone'`；抛出异常则稍后重试（退避 5 秒到 300 秒） |
| `capabilities` | | 聊天软件的能力声明，`defineChannel` 会填好（见 [聊天渠道](12-channels.md)） |
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

第三方插件拿到的 `ctx.engine` 只有上表这几个方法，`ctx.store`（数据库）不可用，调用别的成员会直接报错。这样插件只能经由自己的渠道送事件，不能冒充网页聊天或别的来源、不能结束任务、不能直接写记忆或改数据库。随应用一起发布的内置来源不受这个限制。在沙箱里，`receive`、`follow`、`threadClosed` 是送出去就返回的（`receive` 的返回值只是占位），`followed()`、`conversationOfThread()` 读的是服务每隔几秒同步过来的副本。

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

- **沙箱**：每个第三方插件运行在自己的 Node 进程里，用 Node 的权限模型限制：只能读写插件自己的文件夹，不能读写别的文件，不能启动其他程序、线程或原生模块；可以联网。进程拿不到服务的环境变量（API key 之类）。插件进程崩溃不影响主服务，插件页会显示「加载失败：插件进程退出了」，点「重新加载」再启动。
- 插件和服务之间只通过上面列出的接口通信，所以 `ctx` 的限制在沙箱里同样有效。同步的接口（`allowed`、`authorized`、提示词、工具列表、`threadInfo`）由插件进程随时把最新结果报给服务：`allowed` 以插件送来事件时的判断为准，`workerPrompt` / `workerTools` / `workerEnv` 收到的 ticket 是一个空的占位。
- 沙箱里的插件自带 stdio MCP 服务时，只能写成 `command: 'node', args: ['<插件文件夹里的文件>', …]`，它也在同样的限制下运行；其他命令会被忽略。HTTP 的 MCP 服务不受影响。
- 开发插件时可以设置环境变量 `NUONUO_PLUGIN_SANDBOX=off`，让插件直接在服务进程里运行，方便调试。
- 第三方插件的工具名必须以 `<来源 id>_` 或 `<插件 id>_` 开头（例如 `rss_search`），否则会被忽略，这样插件不能顶替应用自带的 `shell`、`reply` 这类工具。
- 第三方插件在 `writes` 里列出的写操作工具，每次调用前都会先问你批准；在「权限」里把来源设为「只能看」时，这些工具直接去掉。
- 令牌、API key 这类配置请用 `secret` 字段：它们存进系统钥匙串，不会写进数据库，设置页只显示「已设置」。
- Worker 的命令行环境里会去掉凭据类的环境变量。插件给 Worker 提供能力时，应该通过工具（在插件进程里拿到凭据），而不是把凭据放进环境变量。
