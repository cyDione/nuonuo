# AGENTS.md — Nuonuo 开发与架构护栏

本文件是 AI 编程助手与协作者进入本仓库的入口约束；详细设计请按需查阅 `docs/`。

## 1. Monorepo 分层与依赖方向

依赖必须严格单向向下，禁止逆向依赖，禁止 `apps/web` / `apps/desktop` / `packages/client` 引入后端 Node 包（由 `apps/daemon/src/harness.test.ts` 自动守卫）：

- `packages/db` — SQLite + Drizzle ORM、迁移、持久化副作用队列（无内部依赖）
- `packages/models` — 模型供应商、加密凭据存储、12 层模型路由、用量账本（→ `db`）
- `packages/agent-runtime` — 无状态会话事件流、步间收件箱注入、后台进程、Blob/recall、浏览器与 MCP（→ `db`, `models`）
- `packages/core` — Engine、Router/Worker/Subagent 定义、Prompt、脑声分相声带层、审核门禁、记忆、目标、点子、Watchdog（→ `db`, `models`, `agent-runtime`）
- `packages/sources` — 来源/渠道协议、GitHub、Routines、插件沙箱、云电脑共用层（→ `db`, `models`, `agent-runtime`, `core`）
- `packages/plugin-sdk` — 第三方插件 SDK（→ `core`, `sources`）
- `packages/plugins` — 内置渠道与心境插件（→ `db`, `models`, `agent-runtime`, `core`, `sources`, `plugin-sdk`）
- `packages/client` — 统一公开协议 `/v1/*` 独立 TypeScript SDK（无内部依赖）
- `apps/daemon` — 独立服务端：统一 `/v1/*` HTTP API + RBAC 认证内核（配对码/QR、scrypt 密码、WebAuthn Passkey、轮换 Refresh Token）、SSE、CLI，默认纯 Headless 模式（加 `--web` / `NUONUO_WEB=1` 开启内置 WebUI）（→ 全部 `@nuonuo/*`）
- `apps/web` — React 19 + Vite + Tailwind CSS 4 解耦前端（零 `@nuonuo/*` 依赖；统一通过 `connection.ts` 走 `/v1/*` + Bearer + `fetch` SSE，严禁硬编码 `/api/` 或原生 `EventSource`）
- `apps/desktop` — 轻量 Electron 纯客户端（零 `@nuonuo/*` 依赖，不打包 daemon 与 Node.js；内置 `web` 静态包、`safeStorage` 加密多服务凭据库、扫码/配对与按需本机/Docker 一键部署）

## 2. 不可突破的架构红线

1. **Router 结构性无执行工具**：常驻主 Agent（`router`）永不挂载 `shell`、`job_*`、文件读写或 `web_fetch` 工具；任何需要工具执行的工作必须通过 `start_task` 派发给隔离 Worker。
2. **安全边界写死在代码层，不靠 Prompt 自觉**：权限校验、凭据路径/命令拦截（`packages/core/src/review.ts`）、花钱审批、即时通讯长度上限（`packages/core/src/agents.ts`）必须在代码里强制卡控；API Key 与凭据禁止进入模型上下文或 Worker 环境变量。
3. **扩展工具不能覆盖内置工具**：`registerAgents` 中始终先展开扩展工具、后展开内置工具，确保内置工具（如 `reply`、`shell`）不可被插件顶替。
4. **记忆信任隔离**：非主人直聊（GitHub、邮件、静默任务、汇报批次）以及高情绪吐槽（heated turn）写入记忆必须进 `pending` 队列，不得直接写入 `active` 长期记忆。
5. **数据库变更必须可迁移**：修改 `packages/db/src/schema.ts` 时必须在 `packages/db/src/migrations.ts` 增加向后兼容迁移，禁止假设从空库重建。
6. **Prompt 与代码分工**：`packages/core/src/prompts.ts` 与 `packages/core/src/voice.ts` 管语感、节奏、决策倾向；输出格式（`structured.ts` + Zod）、安全红线与重试恢复由代码负责。

## 3. 跨端与日常开发约定

- **前端双语 i18n**：`apps/web/src` 新增中文界面文案必须用 `tx('...')` 包裹，并在 `apps/web/src/i18n.en.ts` 同步补齐英文翻译（占位符 `{0}`、`{1}` 数量与编号须完全一致）。
- **跨端镜像类型与路由同步**：修改 `ProviderKind`、`RoleId`、`FeedIcon`、`LocalApp`、`ModelType` 或设置页签 `SETTINGS_TABS` 时，须同步更新 `apps/web/src/api.ts`、`apps/web/src/settings/hooks.ts`、`apps/web/src/route.ts` 及 `packages/core/src/agents.ts` 的 `OpenLink`（由 `web-types.test.ts` 与 `harness.test.ts` 守卫）。
- **改动核心机制前先读对应文档**：
  - 核心双层架构与可靠性：`docs/07-architecture.md`
  - 记忆、灵魂与主聊/侧聊交互：`docs/09-m6-muse-and-memory.md`
  - 插件 / 渠道 / 云电脑 / 客户端协议：`docs/04-plugin-sdk.md`、`docs/12-channels.md`、`docs/13-computers.md`、`docs/11-client-protocol.md`

## 4. 验证与常用命令

- `pnpm check` — **每次改动完成必跑**：完整运行 11 个工作区 `typecheck` + 全部 Vitest 单元测试（含架构/i18n 护栏与前端纯逻辑测试）+ `web` 与 `daemon` 生产构建。
- `pnpm eval` — 修改 `prompts.ts`、`voice.ts` 或路由/设置决策规则后必跑（默认零 token 离线回归检查；配置模型 Key 后可用 `NUONUO_EVAL_LIVE=1 pnpm eval` 跑真实模型评测）。
- `pnpm dev` — 并行启动后端服务与前端 Vite 热更新。
