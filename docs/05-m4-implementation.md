# M4 实现说明：插件生态、MCP、Telegram / Gmail、桌面端

## 插件 SDK（`packages/sources/src/plugins.ts`、`packages/plugin-sdk`）

- **第三方插件**：放在 `<home>/plugins/<名字>/`，由 `package.json` 的 `superagent.plugin` 字段指定入口文件。
  - 列表只读取 manifest，不执行代码；你启用之后才 `import`。
  - 加载出错只影响这个插件本身，不会拖垮服务。
  - 来源 id 不能和已有的重复。
  - 停用插件时，会注销它提供的来源。
- **内置插件**：Telegram 和 Gmail 用 `registerBuiltIn` 注册，和第三方插件走完全相同的接口。
- **新增的框架能力**：
  - `secret` 配置字段：值存在钥匙串里，设置页只显示「已设置」。
  - `ctx.secret`：插件在运行时保存密钥，例如 OAuth 刷新令牌。
  - `ctx.notify`：不经过模型，直接给你发通知。
  - `actions` + `http`：设置卡片上的按钮，以及插件自己的 HTTP 端点（包括不需要令牌的 OAuth 回调）。
- **示例插件**：`examples/plugins/rss-watch`（RSS 订阅）。命中关键词时可以选择「通知我」或「交给智能体处理」。
- 文档见 [04-plugin-sdk.md](04-plugin-sdk.md)。

## MCP（`packages/agent-runtime/src/mcp.ts`）

- **连接方式**：支持 stdio 命令和 Streamable HTTP 两种。
  - stdio 服务用最小环境变量启动；配置里写的 `${NAME}` 从本机服务的环境变量读取，所以密钥不用写进设置。
  - 测试验证过：MCP 服务进程看不到 `OPENAI_API_KEY` 这类 API key 变量。
- **工具暴露**：工具以 `mcp_<服务>_<工具>` 的名字交给 Worker，也可以选择交给主 Agent。主 Agent 的提示词里会列出 Worker 能用哪些 MCP 工具。端到端测试中发现，不列出来时，主 Agent 会直接回答「没有这个工具」。
- **审核**：标记了「先经过审核」的服务，Worker 的每次调用都按对外操作走审核层。审核结果交给你时，你批准后由已注册的执行器完成调用，结果送回 Worker。

## Telegram 插件

- **连接**：Bot API 长轮询，不需要公网地址。
- **谁能派活**：允许列表里的账号（Telegram ID 或 @用户名）。私聊里发的消息都算在叫智能体；在群里要 @机器人 或回复它的消息。
- **命令**：`/start` 会显示你的 ID，方便加进允许列表；`/new` 开始一个新话题，对应一个新的镜像对话。
- **回复**：用纯文本，超过 4000 字自动拆成多条。

## Gmail 插件（按 Muse 的方式：只写草稿，从不发信）

- **授权**：使用你自己的 OAuth「桌面应用」客户端。授权页面跳回 `127.0.0.1` 上的回调地址，回调会校验 state，刷新令牌存进钥匙串。
- **读信**：用 History API 从游标处增量读取；游标过期时重置。
- **谁的邮件会交给智能体**：
  - 来自允许地址的邮件（你自己的地址自动允许）。
  - 你打上派活标签（默认 `superagent`）的邮件。打标签是你做的动作，所以这个事件以你的名义发出。
  - 其余邮件只记录，不处理。
- **回复**：在同一个邮件线程里存成草稿回复（带 `In-Reply-To`）。
- **Worker 工具**：`gmail_search` / `gmail_read` / `gmail_draft`。

## Electron 桌面端（`apps/desktop`）

- **连接服务**：连接已经在运行的本机服务；没有的话，用系统的 Node 启动它（`SUPERAGENT_NODE` / `SUPERAGENT_CLI` 可以指定）。服务以 detached 方式运行，关掉窗口或退出 App 后，定时任务和各来源照常工作。之所以不把服务放进 Electron 里跑：SQLite 和钥匙串是原生模块，会遇到 Electron ABI 不兼容的问题。
- **窗口**：直接加载本机服务的网页界面。外部链接用系统浏览器打开；关闭窗口只是隐藏到托盘。
- **托盘**：显示待处理事项的数量；菜单里有「新对话」「开机时启动」「设置」，退出时可选保留或停止后台服务。macOS 上还会显示 Dock 角标。
- **系统通知**：订阅服务的事件流，窗口不在前台时，智能体的新消息会弹出系统通知，点击直达对应的对话。网页版检测到运行在桌面端时，不再弹浏览器通知，避免重复。
- **全局快捷键**：`Cmd/Ctrl+Shift+Space`，呼出窗口或打开新对话。
- **打包**：`electron-builder` 配置了 macOS（dmg / zip）和 Linux（AppImage），会把 `apps/daemon/dist` 一起打进去。运行仍然需要本机安装 Node 22 及以上版本。

## 验证

- **单元测试**：75 个。
  - 插件：加载与卸载、出错隔离、id 冲突、secret 字段。
  - RSS 示例插件：真实的 HTTP 订阅源，两种模式都测了。
  - MCP：真实的 stdio 服务；环境隔离；审核 → 批准 → 执行器执行。
  - Telegram 和 Gmail：模拟 API；覆盖 OAuth 授权、游标增量读取、打标签派活、草稿回复。
- **桌面端冒烟测试**（虚拟显示 xvfb）：自动启动服务、窗口加载界面、托盘和全局快捷键注册成功；退出 App 后服务仍在运行。
- **端到端**：真实模型 + 模拟的 Telegram API + 真实的 MCP 服务。你在 Telegram 上让它「用 calc 工具算」，主 Agent 开任务并在 Telegram 上确认，Worker 调用 MCP 工具（审核模型放行，记入审计），结果回复到 Telegram。
- **没有验证过的**：
  - 真实的 Telegram 和 Gmail 服务：需要你的 Bot token 和 OAuth 客户端。
  - macOS 上的打包与实际运行。
  - 桌面系统通知的实际弹出：这台测试机上没有通知服务。
