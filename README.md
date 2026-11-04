# Super-agent

一个**完全运行在你自己电脑上**的个人 Super-agent。设计依据见 [docs/00-research.md](docs/00-research.md)，参照的是 DeepSeek《Super-agent 设计探索》和 `dsh-superagent-prototype`；交互方式对标 Grok Bot / Muse。

> 当前进度：**M0 骨架**。已可用的功能：本机服务、BYOK、分层模型配置、用量统计，以及「直连预览」对话（直接和主 Agent 层的模型聊天）。
> 任务执行（Router / Worker）、GitHub、后台推进会在 M1–M3 陆续加入。

## 快速开始

需要 Node.js ≥ 22.12 和 pnpm，支持 macOS 或 Linux。

```bash
pnpm install
pnpm build
pnpm start            # 等同于 superagent start：只监听 127.0.0.1:7420，并自动打开登录链接
```

首次使用的步骤：

1. **设置 → 模型供应商**：添加 API key。支持 Anthropic、OpenAI、Gemini、DeepSeek，以及 OpenRouter / 通义 / Kimi / 智谱 / SiliconFlow / Ollama / LM Studio / 任意 OpenAI 兼容接口。
2. **设置 → 分层模型**：给「主 Agent」选择模型。其余层不配置时，会沿用上一层的模型。
3. 回到对话页开始聊天。

## 命令行

| 命令 | 作用 |
|---|---|
| `superagent start [-p 端口] [--no-open]` | 启动本机服务 |
| `superagent status` | 查看是否在运行，以及后台队列是否健康 |
| `superagent doctor` | 检查运行环境（Node、钥匙串、模型配置、git/gh/Docker） |
| `superagent token [--rotate]` | 打印登录链接；加 `--rotate` 时轮换访问令牌 |
| `superagent service install / uninstall` | 开机自启（macOS 用 launchd，Linux 用 systemd 用户服务） |

在仓库内开发时，可以用 `node apps/daemon/dist/cli.mjs <命令>` 代替 `superagent`。

## 开发

```bash
pnpm dev     # daemon（tsx watch，数据目录为 ./.superagent-dev）+ Vite（http://localhost:5173）
pnpm check   # 类型检查 + 测试 + 构建
```

开发模式下，daemon 会打印指向 `localhost:5173` 的登录链接；Vite 会把 `/api` 和 `/auth` 代理到 daemon。

## 数据与安全

- **数据目录**：默认是 `~/.superagent/`，可用 `SUPERAGENT_HOME` 修改。里面包括：`state.db`（SQLite）、`token`（访问令牌，权限 0600）、`work/`、`memory/`、`logs/`。
- **API key 存放位置**：只存在系统钥匙串里（macOS Keychain / Linux Secret Service），不进数据库、不进日志，也不会进入模型上下文。如果钥匙串不可用（例如无桌面的 Linux），会自动改用 `secrets/secrets.enc`（AES-256-GCM，密钥 `master.key` 的权限为 0600）。`SUPERAGENT_SECRETS=file|keychain` 可以强制指定其中一种。
- **网络访问控制**：服务只监听 `127.0.0.1`。所有 API 都需要访问令牌（HttpOnly + SameSite=Strict 的 cookie，或 Bearer 头），并校验 `Host` 与 `Origin`，防止 DNS rebinding 和其他网页伪造请求。

## 代码结构

```
apps/daemon     本机服务：Hono API、SSE、CLI、组合根
apps/web        React 19 + Vite + Tailwind 4 前端（构建后由 daemon 托管）
packages/db     SQLite + Drizzle、迁移、持久化副作用队列 Effects
packages/models 供应商、BYOK 密钥存储、分层模型解析（继承 / 备用链 / 预算）、用量账本
docs/           调研与设计文档
```

## 路线图

- **M1**：主 Agent + Worker 双层架构、异步 job、任务卡片、「待你处理」
- **M2**：GitHub 插件、定时任务（Routine）、Agent 主动发起对话
- **M3**：Reviewer 审核与规则、三层记忆、Watchdog、浏览器接管、Docker 沙箱
- **M4**：插件 SDK、MCP、Gmail / Telegram、Electron

## 许可

领域设计参考了 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）。后续移植的代码会在对应文件中保留原版权声明。
