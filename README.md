<div align="center">

<img src="docs/assets/mascot.svg" width="96" alt="Super-assistant" />

# Super-assistant

[![CI](https://github.com/cyDione/super-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/cyDione/super-assistant/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/cyDione/super-assistant)](https://github.com/cyDione/super-assistant/releases)
![Node version](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

跑在你自己电脑上的个人助理：你说一句话，它在后台把事办完，再用一句话告诉你结果。

[功能](#功能) · [快速开始](#快速开始) · [使用](#使用) · [设计理念](#设计理念) · [工作原理](#工作原理) · [参考](#参考)

<img src="docs/assets/demo.gif" alt="运行演示：说一句话，它接下任务、在后台做完，把成果交给你" width="860" />

</div>

Super-assistant 是一个**常驻的个人助理**，不是写代码的 Agent。服务和执行都在你自己的机器上。你在网页、桌面端、Telegram、GitHub 或邮件里交代一件事，它分派给后台的执行者去做：查资料、排行程、整理文件、盯一个 PR、每天早上给你一份摘要。做完以后它只回你一句话，完整的成果放在「成果」里。

上面的动图是一次真实运行的录屏，等待的部分做了快进。你说「帮我排一下周末去杭州的行程」，它先回一句，然后在后台查天气和开放时间，写成一份网页；做完回你一段话，网页在「成果」里直接打开。

## 功能

- **像跟人聊天**：一个主对话加侧聊。对话里只有你和它说的话，工具调用和执行过程放在任务详情里。执行中途可以随时插话。
- **多件事并行**：每件事交给一个独立的 Worker，互不阻塞。「今天」面板列出正在做的事、需要你处理的事和接下来的定时任务。
- **在哪都能找它**：网页、桌面端、Telegram、GitHub（在 Issue / PR 里 @它就能派活）、Gmail，回复回到你找它的地方。
- **主动但安静**：没人找它的外部事件，先经过程序规则，再由过滤模型按你用自然语言写的策略判断。它可以先在本地悄悄做，有价值才告诉你。
- **定时任务**：说一句「每天 9 点……」就能创建。
- **记忆与说明**：记忆带来源、置信度和有效期，可以查看和修改；对它说「以后……」，会记进带版本的说明。
- **安全可控**：有后果的动作要经过审核层，高风险的先问你。凭据不进模型上下文，所有决定都记入审计。可选 Docker 沙箱；遇到需要登录的网页，由你接管浏览器。
- **自带模型（BYOK）**：主 Agent、Worker、过滤、审核等各层可以分别选模型，并设置用量预算。
- **可扩展**：插件 SDK、MCP 工具。
- **一直在线**：重启后自动恢复进行中的任务；Watchdog 盯着卡住和空转的任务；支持在线自动更新。

## 快速开始

**Linux 服务器 / 无桌面**（x64、arm64 自动识别，不需要登录 GitHub）：

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/super-assistant/main/install.sh | bash
super-assistant start -d
```

`start -d` 在后台启动服务，并打印一个登录链接（`http://127.0.0.1:7420/auth?token=…`）。

**macOS / Windows 桌面端**：从 [Releases](https://github.com/cyDione/super-assistant/releases) 下载对应系统和芯片的安装包（macOS arm64 / x64，Windows x64 / arm64）。应用自带服务和 Node.js。

打开登录链接，在「设置 → 模型供应商」填上你自己的 API key，就可以开始用了。

> [!TIP]
> 想让局域网里的其他设备访问：Linux 运行 `super-assistant start -d --host 0.0.0.0 --port 8080`；桌面端在「设置 → 系统 → 网页访问」里开启。

> [!WARNING]
> 任务的命令以运行服务的用户身份执行。不要以 root 运行；建议用单独的普通用户，或在「设置 → 执行环境」里把 Docker 沙箱设为「全部」。监听非本机地址时，登录链接就相当于密码，只在可信的局域网里这样用。

从源码部署、开机自启、升级、远程访问、GitHub / Gmail 授权，见 [部署与运维](docs/deploy.md)。

## 使用

直接用说话的方式交代事情，例如：

- 「帮我比较几款降噪耳机，整理成表格」
- 「每天早上 9 点整理一下 Hacker News 热门」
- 「这个仓库有新 Issue 先帮我看一下，值得处理再告诉我」

常用命令：

| 命令 | 作用 |
|---|---|
| `super-assistant start [-d] [--host 地址] [--port 端口]` | 启动服务，加 `-d` 在后台运行 |
| `super-assistant stop` / `restart` / `status` | 停止 / 重启服务，查看运行状态 |
| `super-assistant config --host 地址 --port 端口` | 保存默认的监听地址和端口 |
| `super-assistant token [--rotate]` | 重新打印登录链接，加 `--rotate` 时轮换令牌 |
| `super-assistant service install` | 开机自启（macOS 用 launchd，Linux 用 systemd） |
| `super-assistant update [--check]` | 检查并安装新版本 |
| `super-assistant doctor` | 检查运行环境 |

完整的命令说明见 [部署与运维](docs/deploy.md#命令行)。

## 设计理念

**助理，而不是工具。** 编码 Agent 的界面是一条长长的执行轨迹，需要你一直盯着。个人助理应该像一个靠谱的人：你交代一句，它说「好」，然后去做。所以对话里不出现工具调用；只有需要你批准、回答或接管浏览器时，才弹出一张用大白话写的卡片。它有自己的名字、头像和性格，头像会随状态变化。

**人的注意力才是瓶颈。** 一个人同时只跟得住三五个会话。所以「会话」只是实现细节：你面对的始终是一个助理，它背后同时跑着很多个 Worker。

**连续、高效、主动、持久。** 这四点是 DeepSeek《Super-agent 设计探索》提出的目标，也是这个项目的验收标准。连续：在哪里找它都是同一个它。高效：多件事并行。主动：没人叫它，也能发现该做的事。持久：一直在线，出了问题能自己恢复。

**安静是默认值。** 打扰是有成本的。即时通讯渠道的回复有硬性长度上限（约 100 字）；主动处理不对外发任何东西；后台做完的事如果没有价值，就不出声。

**本地优先，你说了算。** 服务和执行都在你的机器上，模型用你自己的 key。凭据存在系统钥匙串或加密文件里，模型永远看不到。有后果的动作要经过审核。外部来源（例如邮件、别人的评论）的内容只能进「等你确认」，不能直接写进记忆。

**用结构约束，而不是靠提示词。** 重要的规则写在代码里，不写在提示词里：主 Agent 没有 shell，只能派活；谁的话能直接写进记忆，由代码按来源和信任级别判断；后台静默做事时，结构上就没有对外发送的工具。

## 工作原理

整个系统是一个本机进程：一个 Node 服务、一个 SQLite 文件，加一个可以直接用文本编辑器查看的数据目录。

```mermaid
flowchart TB
  subgraph IN["来源（回复也回到这里）"]
    direction LR
    web["网页 / 桌面端"] ~~~ tg["Telegram"] ~~~ gh["GitHub"] ~~~ gm["Gmail"] ~~~ cron["定时任务"] ~~~ plug["第三方插件"]
  end

  subgraph FILTER["两级过滤"]
    direction LR
    fast["Fast Path<br/>程序规则"] --> slow["Slow Path<br/>过滤模型 + 你写的主动策略"]
  end

  router["主 Agent（Router）<br/>常驻 · 没有 shell<br/>分派 · 回复 · 记忆"]

  subgraph WORK["Worker（并行）"]
    direction LR
    w1["Worker 1"] ~~~ w2["Worker 2"] ~~~ wn["Worker N"]
    w1 -.-> sub["子任务"]
  end

  review{"审核层<br/>规则 + 审核模型"}
  you(["你：批准 / 回答 / 接管浏览器"])

  subgraph ENV["执行环境（你的电脑）"]
    direction LR
    sh["Shell<br/>可选 Docker 沙箱"] ~~~ br["浏览器"] ~~~ mcp["MCP 工具"] ~~~ fs["文件 / 网页"]
  end

  subgraph BASE["底座"]
    direction LR
    db[("SQLite<br/>会话 · 事件 · 任务 · 记忆 · 审计")] ~~~ wd["Watchdog<br/>每分钟巡检"]
  end

  IN -- "你直接说的话" --> router
  IN -- "其他事件" --> FILTER --> router
  router <-- "开工 · 汇报" --> WORK
  WORK --> review
  review -- "放行" --> ENV
  review -- "高风险" --> you
  you -- "批准" --> ENV
  ENV ~~~ BASE
```

- **主 Agent 和 Worker 分开**：主 Agent 常驻，负责分派和回复，用快而便宜的模型；Worker 每件事一个，用最强的模型，只向主 Agent 汇报。
- **事件驱动**：网页消息、GitHub 评论、邮件、定时任务都统一成 Trigger。一件事开工后，同一线程的后续事件由程序直接送给负责它的 Worker，不再经过主 Agent（订阅直通）。
- **无状态循环**：每一步都从 SQLite 重建上下文，进程随时可以重启。长输出存到窗口外，窗口里只留引用，需要时用 `recall` 取回。
- **全双工**：新消息在推理步之间注入；耗时命令自动转到后台，跑完再继续。
- **外部 Watchdog**：一个独立的会话每分钟巡检一次，发现卡住或死循环的任务，就提醒它、重启它，或者告诉你。

<details>
<summary>代码布局</summary>

```
apps/daemon             本机服务：Hono API、SSE、CLI
apps/web                前端：React 19 + Vite + Tailwind 4
apps/desktop            Electron 桌面端
packages/core           领域层：Trigger / Thread / Ticket / 订阅 / 汇报，主 Agent 与 Worker，审核、记忆、Watchdog
packages/agent-runtime  Agent 运行时：事件日志、步间注入、后台命令、文件 / Shell / 网页工具、recall
packages/sources        来源插件协议、GitHub 来源、定时任务
packages/plugins        内置插件：Telegram、Gmail
packages/plugin-sdk     插件 SDK
packages/models         供应商、密钥存储、分层模型、用量账本
packages/db             SQLite + Drizzle、迁移、持久化副作用队列
```

开发：`pnpm install && pnpm dev` 同时启动服务和 Vite，`pnpm check` 跑类型检查、测试和构建。

</details>

## 参考

| 来源 | 借鉴了什么 |
|---|---|
| DeepSeek《Super-agent 设计探索：迈向更自主的 Agent 系统》 | 整体架构：Router / Worker 双层、两级过滤、订阅直通、Inline & Spill、投机执行、全双工交互、计算与状态分离、外部 Watchdog。逐节对照见 [07-architecture](docs/07-architecture.md) |
| [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT） | 领域模型：Source / Trigger / Thread / Ticket / Subscription / Report，Policy 门控、持久化副作用队列。领域层按 MIT 协议移植改写，运行时、模型层、插件层和前端是自己写的。调研见 [00-research](docs/00-research.md) |
| Grok Bot | 常驻的具名助理、批准卡片、定时任务（routines）、自然语言规则加审核 Agent、记忆系统 |
| [Muse](https://muse.ai/blog/how-we-designed-muse) | 主对话加侧聊、交出目标后在后台推进、助理的个性、成果在对话里直接预览。见 [09-m6](docs/09-m6-muse-and-memory.md) |

技术栈：Node.js 22、[Hono](https://hono.dev)、SQLite + [Drizzle](https://orm.drizzle.team)、React 19、Vite、Tailwind 4、[Vercel AI SDK](https://ai-sdk.dev)、[MCP](https://modelcontextprotocol.io)、Playwright、Electron。

各阶段的设计记录在 [docs/](docs/) 里。
