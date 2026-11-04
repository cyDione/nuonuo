# M2 实现说明：外部来源、GitHub、定时任务

## 来源插件协议（`packages/sources`）

一个来源（Source）是一个 `SourceKind`，可以实现以下能力：

| 能力 | 作用 |
|---|---|
| `schema` + `fields` | 配置校验，并自动生成设置表单（设置 → 来源），新增来源不用写界面代码 |
| `start(ctx)` / `poll(ctx)` | 读取事件，翻译成 `IncomingTrigger` 后交给 `engine.receive` |
| `allowed(ctx, actor)` | 判断谁可以通过这个来源派活 |
| `send(ctx, message)` | 回复渠道；由持久化的 `reply` 副作用队列调用，失败按 5 秒到 300 秒退避重试，对方会话已不存在时返回 `gone` |
| `threadInfo` | 生成卡片上显示的线程摘要 |
| `routerPrompt / routerTools` | 给主 Agent 增加提示词和工具 |
| `workerPrompt / workerTools / workerEnv` | 给 Worker 增加提示词、工具和环境变量 |

`SourceRegistry` 负责保存各来源的配置（`kv: source:<id>`）、启停来源、维护健康状态与展示信息，并为 Engine 实现 `SourcePort` 接口，为 Agent 提供扩展。

M4 的 Gmail、Telegram、飞书等插件都按这个协议实现。

## Engine 的通用接收流程（`engine.receive`）

- **幂等**：Trigger 的 id 由来源自己的 id 派生，重复读取不会产生重复事件。
- **扇出**：事件会送到订阅了该线程的所有任务，送达不授予新权限。
  - 允许的人发的消息，会恢复一个已结束、但不是被主人停止的任务。
  - 机器人和 CI 的消息不会恢复已结束的任务。
- **派活的条件**：没有任务接收、且是允许的人在叫智能体时，才作为请求交给主 Agent。
- **其余事件**：记录下处理结果（disposition）后忽略，主 Agent 看不到。
- **镜像对话**：外部线程第一次有内容需要处理时，会自动创建一个镜像对话（`origin=agent`），你在网页上也能看到并参与。
- **回复去向**：
  - 主 Agent 回复时带上 `reply_to`（外部消息）或 `ticket_id`（来自外部的任务），内容会同时发到来源（如 GitHub 评论）。
  - 你在镜像对话里写的消息，主 Agent 的回复只留在网页上。
- **跟随与关闭**：`follow()` / `threadClosed()` 表示任务跟随自己开的 PR；这些 PR 全部合并或关闭后，任务结束，结果记为 `merged` 或 `closed`。

## GitHub 来源

- **身份**：令牌来自 `GITHUB_TOKEN` / `GH_TOKEN`，没有时用本机 `gh auth token`。令牌对应的账号就是主人；另外可以在白名单里加别的账号。Worker 不会拿到这个令牌，它通过本机已登录的 `gh` 和 `git` 操作。
- **轮询**：本机通常没有公网地址，所以用轮询代替 webhook。每个仓库有自己的游标；机器休眠后重新启动，会从游标处接着读取。
  - 新 Issue / PR、对话评论、行内 review 评论
  - 任务跟随的 PR：review 结论、CI（等所有 check 完成后，按 sha + 结果去重，只通知一次）、合并或关闭
- **唤起**：评论里出现唤起词（默认 `@agent`）才算在叫智能体。智能体以主人的账号发言，所以不能用 @ 主人自己来唤起。
- **防回环**：智能体发出的评论末尾带有 `<!-- super-agent -->` 标记，读回时会跳过。
- **Worker 的 GitHub 能力**：
  - 提示词包含：分支命名 `superagent/<任务名>`、PR 正文规范、禁止推送默认分支或自行合并。
  - 工具 `github_follow`：跟随自己开的 PR。
  - 环境变量：`SUPERAGENT_GITHUB_REPO/NUMBER`。

## 定时任务

- **数据**：存在 `routines` 表中；cron 用 5 个字段，按本地时间解析。
- **调度**：调度器每 20 秒检查一次。机器休眠错过的执行，如果是 12 小时内的，醒来后补跑一次；更早的不补跑。
- **执行**：到点时，以主人身份把一条来源为 `cron` 的消息发给主 Agent。每个定时任务有自己的对话，结果出现在那里，左侧显示未读。
- **主 Agent 的管理工具**：`schedule_routine / list_routines / update_routine`。直接在对话里说「每天 9 点…」就能创建。

## 未读与通知

- **未读**：判断依据是对话的 `last_read_at`；之后出现的、不是主人在网页上发的消息计为未读。打开对话即标为已读。
- **主动开对话**：主 Agent 可以用 `new_conversation` 主动开一个新对话。
- **桌面通知**：设置 → 系统 → 桌面通知。页面不在前台时，智能体的新消息会弹出系统通知。

## 验证

- **单元测试**：涵盖权限、自身评论过滤、回复发到 Issue、PR 评审、CI、合并结束任务、cron 解析与补跑。
- **端到端**：真实模型（DeepSeek V4.1 Flash 网关）加本地模拟的 GitHub API。在 Issue 中 @agent 后，智能体在 GitHub 上回复确认；Worker 克隆真实仓库，逐条执行安装命令验证，再把完整草稿贴回 Issue。在对话里说「每天 9 点…」会创建定时任务；立即运行后，结果出现在该定时任务的对话中。
- **未验证**：真实 GitHub API。这个环境的 GitHub 令牌无效，接真实 API 的部分没有测过。
