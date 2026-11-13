# 架构对照：论文《Super-agent 设计探索》与本项目（2026-11-05）

依据：重读论文全文（第 1–9 节），逐条对照本仓库代码。结论在前：

- 论文的**五个模块**（双层架构、事件驱动、面向人的交互、计算/状态/环境分离、Watchdog）本项目都已实现，结构一一对应。
- 只有两处**刻意的差异**，都来自你的要求：
  - 所有组件都跑在你自己的机器上，没有"云端 Agent Loop + 端侧 daemon"那一层；
  - 允许多个对话。
- 这次对照**发现并修正了 5 处偏差**，见第三节。

## 一、总体结构对应

论文的总图（图中标号 [2]–[6] 对应论文第 2–6 节）：

```
[3] 环境事件 Trigger ──▶ [3] 两级过滤 ──▶ [2] Router 层 ──▶ [4] 多信道交互（IM / GitHub / 邮件）
                              │订阅直通          │
                              ▼                  ▼
                    [2] Worker Session 1 … N ──▶ [5] 执行环境（端侧 daemon）
                              │
[6] Watchdog ┄┄┄┄┄┄▶ [5] Session 数据库（持久化存储所有 Session 状态）
```

本项目里的对应：

| 论文组件 | 本项目 | 代码 |
|---|---|---|
| 环境事件 Trigger | 来源插件把外部事件统一成 `IncomingTrigger`，存进 `triggers` 表。网页消息、定时任务也是 Trigger | `packages/sources/*`、`packages/plugins/*`、`Engine.receive` / `receiveMessage` |
| 两级过滤 | **Fast Path**：程序规则，包括白名单、是否 @ 了它、机器人、来源、忽略账号。**Slow Path**：过滤层模型按你写的自然语言策略判断 | `Engine.receive`、`proactive.ts` 的 `fastPath` 和 `Screener` |
| Router 层 | 常驻的单个 LLM 会话 `ses_router`，没有 shell | `agents.ts` 的 router 定义 |
| 订阅直通 | `subscriptions` 表，任务和线程多对多 | `Engine.receive` / `deliver` |
| Worker Session | 每件事一个隔离会话，有自己的工作目录和工具 | `agents.ts` 的 worker 定义 |
| 多信道交互 | 网页、Telegram、GitHub、Gmail；回复回到消息来的地方 | `Engine.reply`、`SourceRegistry` 的 `reply` |
| 执行环境 | 本机 shell，可选 Docker 沙箱 | `agent-runtime/jobs.ts`、`core/sandbox.ts` |
| Session 数据库 | SQLite：`sessions` / `session_events` / `session_inbox` / `jobs` / `blobs` | `packages/db` |
| Watchdog | 独立会话 `ses_watchdog`，每分钟跑一次探针 | `core/watchdog.ts` |

## 二、逐节对照

| 节 | 论文的设计 | 本项目 | 一致性 |
|---|---|---|---|
| §1 四个特征 | 连续、高效、主动、持久 | **连续**：同一个智能体出现在网页、GitHub、Telegram 里，外部讨论镜像成对话，一件事可以跨线程继续。**高效**：多个 Worker 并行，主 Agent 不会被一件事卡住。**主动**：主动处理。**持久**：后台服务加开机自启，重启后自动恢复 | ✅ |
| §2 双层 | 常驻 Router 负责全局连续性；隔离的 Worker 负责并发执行 | 同左 | ✅ |
| §2 | 让 Session 成为实现细节，不成为用户的负担 | 界面上没有会话、任务、Worker 这些概念，只有对话 | ✅ |
| §2.1 Router | 不执行具体任务，可以不配 Bash；推理期间到达的事件攒到下一轮一起处理（批处理） | 主 Agent 的工具只有回复、开始 / 并入 / 停止、静默工作、忽略、召回、说明、记忆和定时任务，没有 shell。收件箱在每个推理步之间取一次，积压的事件合并成一条消息送进去 | ✅ |
| §2.1 | 规模大了再把 Router 分层或分片 | 没做。论文也说按目前的规模不需要 | ⏸ 不需要 |
| §2.2 Worker | 配最强的模型；不直接跟人说话，推理和工具调用不输出到信道；向 Router 汇报 | Worker 在「设置 → 分层模型」里可以单独配更强的模型。Worker 只能调用 `report`，由主 Agent 统一回复。网页上也不展示工具调用 | ✅ |
| §2.2 | Worker 之间不直接通信；冲突靠订阅同一个线程自然发现 | 同左，同一线程的事件会发给所有订阅它的 Worker | ✅ |
| §2.2 | Worker 内部可以再开 Subagent | `subagent_start` / `subagent_stop`，子任务用自己的模型层 | ✅ |
| §2.2 | 个人助手：一个聊天页，底层每个话题分派一个 Worker | 你要求可以开多个对话；每个对话里仍由主 Agent 按话题分派 Worker | ⚠️ 刻意差异 |
| §3.1 两级过滤 | Fast Path 用程序规则筛掉大部分消息；Slow Path 用提示词写的策略判断，也是给人用自然语言扩展的入口 | **Fast Path**：白名单、是否找它、机器人、来源、忽略账号。**Slow Path**：过滤层模型加你写的策略，没配过滤层时由主 Agent 的模型兼做。你可以在设置里改策略；对主 Agent 说一句，它也能改 | ✅ |
| §3.1 | 通过两级过滤的事件**进入 Router 路由** | 原来自动模式下绕过了主 Agent，直接开工；**已修正**，见第三节 | ✅（已修） |
| §3.2 订阅直通 | 后续事件由程序直接送给已订阅的 Worker；Router 仍能看到所有事件；订阅是多对多；Worker 可以取消订阅或交回 Router | 外部线程的事件发给所有订阅者，主 Agent 收到一条不唤醒它的通知，交回用 `handback`。原来 Worker 没有取消订阅的能力；**已补 `unfollow_thread`** | ✅（已补） |
| §3.2 | （网页聊天） | 一个对话里只有一件事在进行时，你的消息直接交给它；有多件时交给主 Agent 分派。原因是网页对话是多话题的聊天页，正好对应论文"聊天页由 Router 维持连续性"的说法 | ⚠️ 合理变体 |
| §3.3 Inline & Spill | 一开始只给 ID 和摘要，按局部性 Inline 关联信息，超出预算的放到窗口外由模型按需读取 | 最近消息截到 300 字并带上 ID；长输出写进 blob，窗口里只留引用；用 `recall` 按需读取 | ✅ |
| §3.3 链式召回 | 每次召回的结果都带上下一跳的 ID：Trigger → Thread → Worker → 另一个 Thread | `recall` 支持事件、线程、任务、会话、对话和 blob。原来事件里没有带线程 id，链条断在第一步；**已修正** | ✅（已修） |
| §3.4 投机执行 | 后台先试；结果有价值才交付，否则全程保持安静 | 静默工作：只在本地做，不对外发东西，也不请求批准；结果是 dropped 就不出声，是 ready 由主 Agent 判断值不值得告诉你 | ✅ |
| §4.1 全双工 | 耗时命令和子任务都用异步的 `start()` / `stop()`；新输入在当前推理步结束后被处理 | 子任务是 `subagent_start` / `subagent_stop`；后台命令用 `job_stop` 停止；收件箱在推理步之间注入新输入；你一发消息，正在前台跑的命令就转到后台。原来命令只能等超过几秒自动转后台，**已补 `shell(background: true)` 立即返回**，对应 `start()` | ✅（已补） |
| §4.2 多信道 | IM 这类即时通讯：低打扰，单次回复不超过 100 词（硬性规定）。GitHub、邮件：结构化、信息完整 | 网页和 Telegram 的回复超过约 100 词时，回复工具直接拒绝发送；GitHub 和邮件按提示词写结构化长文 | ✅ |
| §5.1 计算与状态分离 | Agent Loop 无状态，会话状态全部持久化 | 每一步都从 SQLite 重建上下文；进程重启后，进行中的会话自动恢复 | ✅ |
| §5.2 计算与执行环境分离（BYOM） | Agent Loop 在云端，用户的机器通过轻量 daemon 接入，可以在多台设备之间切换 | 按你的要求，服务端和执行端都在你自己的机器上，所以没有"云端 Loop + 端侧 daemon"这一层。执行环境分两档：本机目录和 Docker 沙箱 | ⚠️ 刻意差异 |
| §6 Watchdog | 独立会话加定时消息，形成外部控制回路；既管基础设施故障，也由模型判断任务有没有实质进展、方向有没有偏 | 每分钟跑一次探针：卡住、死循环、步数过多、说了继续却没动静、后台队列或来源出错。模型判断后提醒任务、重启任务或通知你 | ✅ |
| §6 | 可以用自然语言问它故障原因，也可以让它在线修正主系统，比如增删提示词、调整触发规则 | 它有自己的对话，可以直接问。它能用 `update_instructions` 改说明，用 `update_proactive` 改主动策略。原来改不了 Fast Path 的规则；**已补**来源范围和忽略账号 | ✅（已补） |
| §7 实验 | 消融实验和批处理实验 | 没有复现。项目里有单元测试和端到端测试，但没有做压测 | ⏸ 未做 |
| §8.2 交互 | 底层会话不再直接对应界面上的会话，交互是一个独立的产品问题 | 界面对标 Muse / Grok Bot：只有对话、活动和成果 | ✅ |
| §8.4 安全 | 外部输入可能是恶意的；模型不应该接触凭据 | 密钥放在钥匙串或加密文件，不进上下文，也会从 Worker 的环境变量里剔除。外部内容一律当数据。有后果的操作经审核层，必要时由你批准。静默工作不能对外发东西 | ✅ |

## 三、这次修正的 5 处偏差

1. **主动事件要经过 Router**（§3.1 图示：两级过滤之后进入 Router 路由）。原来自动模式下，引擎直接开静默工作。现在过滤器选中的事件以 `<proactive>` 送给主 Agent，由它决定用 `start_silent_task` 开工，还是 `ignore`。主 Agent 只能对过滤器选中的事件开静默工作。
2. **链式召回从事件就能开始**（§3.3）。事件卡片和 `recall(trg_…)` 里加上了线程 id。
3. **Worker 可以取消订阅**（§3.2）。新增 `unfollow_thread`。
4. **显式的异步启动**（§4.1 `start()`）。`shell` 加了 `background: true`，调用后立即返回，结果之后作为新消息送达。
5. **Watchdog 能调整触发规则**（§6）。`update_proactive` 现在也能改 Fast Path 的来源范围和忽略账号。

## 四、论文之外、本项目额外有的

| 功能 | 来源 |
|---|---|
| 审核层与批准 | 原型的 Reviewer 加上 Grok Bot 的批准卡片 |
| 三层记忆、说明（带版本） | 原型 004 的可编辑提示词片段 |
| 浏览器接管 | Muse / Grok Bot |
| 定时任务 | Grok Bot 的 routines |
| 插件 SDK、MCP、Telegram / Gmail、桌面端 | 你的需求 |

## 五、模型配置

项目不内置任何供应商的推荐配置，各层模型在「设置 → 分层模型」里选。没单独配置的层沿用主 Agent（或 Worker）的模型。

首次启动时，各层自动用环境变量里第一个供应商实时模型列表中最新的通用对话模型（`pickDefaultModel`）；也可以设置 `NUONUO_MODEL=<模型 id>` 指定。已经配置过任何一层后都不再生效。下面的实测用的是一个测试网关上的 DeepSeek V4.1 Flash，只是测试环境，不代表推荐。

## 六、实测（2026-11-05，所有层都用 V4.1 Flash）

各层都设成同一个测试模型。用量账本里过滤、审核、主 Agent、子任务、摘要、Watchdog、执行七层的调用全部是 `group/deepseek-v4.1-flash`。

| 场景 | 结果 |
|---|---|
| **主动处理**（假 GitHub） | 闲聊帖"周五团建去哪？"被过滤层判为不处理。bug 报告通过过滤后，以 `<proactive>` 交给主 Agent，由它调用 `start_silent_task` 开工（对应 §3.1 的"进入 Router 路由"）。静默工作拿不到仓库代码，报告"卡住"。主 Agent 判断值得告诉你，在网页里发了一条消息，说明已经排除了什么、需要什么权限。GitHub 上没有发任何东西 |
| **子任务**（§2.2 / §4.1） | 让它"分头并行查 3.13 和 3.14"。Worker 调用了两次 `subagent_start`，两个子任务各自调研，结果作为 `<subagent_result>` 送回，Worker 合并成对比文档，附件共 10 个文件 |
| **Watchdog 在线修正**（§6） | 在 Watchdog 的对话里说"交付时要写清楚怎么验证的"。它用 `update_instructions` 写进了"交付要求"（第 1 版，修改人是 Watchdog）。之后那份对比文档的结果消息里专门讲了验证方式 |

实测中发现并修正了两处：

- **凭据安全**（§8.4）：那个静默 Worker 在找代码时执行了 `cat ~/.git-credentials`。现在审核层有一条硬规则：只要命令会读取凭据（SSH 密钥、`.git-credentials`、`.netrc`、`gh auth token`、gh 的 `hosts.yml`、云服务凭据、钥匙串等），就直接拦下，不受任何设置影响。静默工作的提示词也加了限制：不许翻你的磁盘，不许找凭据。
- **卡住时的部分成果**：报告状态为"卡住 / 失败"、但已经产出文件时，这些文件也会作为附件随消息一起交给你。

## 七、可靠性与边界修正（2026-11-11）

对照论文 §2.1（Router 是全局单点）、§5.1（状态全部持久化）、§6（外部控制回路）和 §8.4（安全）复查后修正：

| 问题 | 修正 | 代码 |
|---|---|---|
| 主 Agent 的模型调用挂住时一直停在 running，之后的消息全部排队 | 每个模型步有空闲超时（默认 3 分钟没有任何输出、且没有工具在跑），按断线处理重试；这一步里已经跑过工具时不自动重做 | `agent-runtime/src/runtime.ts` 的 `step` |
| 主 Agent 一轮出错后没人重试，你的消息没人回 | 出错后按 5 秒、10 秒、20 秒重试 3 次；仍失败时在对应对话里告诉你出了什么问题 | `core/src/agents.ts` 的 router `onTurnError` |
| Watchdog 只看任务，不看主 Agent；没配 Watchdog 模型时什么都不做 | 每分钟不花 token 地检查主 Agent：一轮 10 分钟没有进展就中断重试，有消息等了 2 分钟没被处理就重新唤醒 | `core/src/watchdog.ts` 的 `healRouter` |
| 收件箱先标成已取、再写进会话历史，中间崩溃会丢事件 | 先渲染，再在一个事务里标记已取并写入历史；渲染失败时事件留在收件箱，并按退避重试 | `runtime.ts` 的 `runTurn` |
| 一步里的工具先执行、后落库，崩溃后会重做（重复推送、重复发帖） | 每次工具调用前后各记一条标记；重启后把"已开始、没记下结果"的调用告诉模型，让它先检查再决定 | `runtime.ts` 的 `trackTools` / `interruptedCalls` |
| 只有 Worker 汇报的一批输入会沿用上一批"主人原话"的信任级别，外部内容可能直接写进记忆 | 每批重新判断；没有主人原话的批次一律按外部内容处理（进待确认） | `agents.ts` 的 router `formatInbox` |
| 允许的工作目录按字符串前缀比较，符号链接能指到外面 | 先解析真实路径再比较 | `engine.ts` 的 `chooseDirectory` |
| 没有 Docker 沙箱时 shell 能改任何文件 | 命令写到任务目录和"能看能改"的文件夹之外时，按"往外发"的级别交给审核层（启发式，不是沙箱） | `access.ts` 的 `shellWritesOutside`、`review.ts` |
| 开了沙箱后，权限里允许的文件夹在容器里看不到 | 沙箱按权限挂载允许的文件夹（只能看的只读挂载）和附件目录；里面的"永远不碰"目录用空目录盖住 | `sandbox.ts`、daemon `runtime.ts` 的 `sandboxFolders` |
| 运行时自己的数据只增不减（已取的收件箱、命令输出、工具输出 blob、工具调用标记） | 每小时清理：已取收件箱 7 天、结束的命令 30 天、工具调用标记 30 天、溢出的工具输出 90 天。任务、汇报、产物和聊天不动（聊天按「数据和隐私」的保留期） | daemon `data.ts` 的 `pruneRuntime` |
| 第三方插件拿到整个 Engine 和数据库 | 第三方插件的 `ctx.engine` 只剩 receive / follow / followed / threadClosed / mainConversation / conversationOfThread，且只能用自己 `<id>:` 开头的线程；`ctx.store` 不可用 | `sources/src/registry.ts` 的 `outsiderContext` |
| 插件工具与自带工具同名时会顶替自带的（比如一个叫 `shell` 的插件工具绕过审核） | 扩展工具先放、自带工具后放，自带的总是赢；第三方插件工具名必须以 `<id>_` 开头；第三方插件的写操作每次先问你 | `agents.ts`、`registry.ts`、`gate.ts` 的 `ToolGate` |
| 进程崩溃后，后台命令还在跑却被标成已终止 | 记录每条命令的进程号；重启时确认还是原来那条命令（开机之后启动，Linux 上再核对环境变量里的任务号）后杀掉整个进程组 | `agent-runtime/src/jobs.ts` 的 `recover` |
| Windows 上没有 bash 时每条命令都失败 | 有 bash（Git Bash）用 bash，没有就用 PowerShell；终止用 `taskkill /T /F` | `jobs.ts` 的 `shellFor` / `killGroup` |
| 主 Agent 的记忆信任状态是模块级全局变量 | 改为按 Engine 实例保存 | `agents.ts` 的 `routerContextOf` |

还没做：按任务筛选给 Worker 的来源工具（内置来源的工具现在对所有任务可见，这是"帮我看下邮件"这类任务需要的），以及运行指标（可以从用量账本和审计日志里看到大部分）。
