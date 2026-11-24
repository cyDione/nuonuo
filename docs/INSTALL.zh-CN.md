# 安装与部署教程

[English](INSTALL.md) | **简体中文** · [返回中文 README](../README.zh-CN.md)

从 **v0.4** 开始，糯糯采用**端服解耦架构**：将**独立 Headless `/v1` 服务端**与**轻量客户端**（macOS 桌面应用、网页端、自定义设备）彻底分离。服务端、SQLite 状态库、Markdown 记忆与任务执行均运行在你自己的设备上，默认仅监听 `127.0.0.1:7420`，模型使用你自己的 API Key。

## 目录

- [安装包安装（推荐）](#安装包安装推荐)
  - [独立服务端（Linux 与 macOS CLI）](#独立服务端linux-与-macos-cli)
  - [Docker 一键部署](#docker-一键部署)
  - [轻量 macOS 桌面端](#轻量-macos-桌面端)
- [从源码部署与开发](#从源码部署与开发)
- [认证方式与设备配对](#认证方式与设备配对)
- [首次启动与模型配置](#首次启动与模型配置)
- [局域网与远程访问](#局域网与远程访问)
- [执行隔离与云电脑](#执行隔离与云电脑)
- [升级与旧版迁移](#升级与旧版迁移)
- [完整命令行参考](#完整命令行参考)
- [数据目录与安全机制](#数据目录与安全机制)
- [常见问题排查](#常见问题排查)

---

## 安装包安装（推荐）

每个 [GitHub Release](https://github.com/cyDione/nuonuo/releases) 提供开箱即用的独立服务端压缩包（已内置 Node.js 运行时）与轻量桌面端安装包：

| 平台 | CPU 架构 | 安装包文件 | 形态 |
| --- | --- | --- | --- |
| **Linux（独立服务端）** | `x64`（amd64）、`arm64`（aarch64） | `nuonuo-<版本>-linux-<x64\|arm64>.tar.gz` | Headless `/v1` 后台服务 + 可选 `--web` 网页界面（内置 Node.js） |
| **macOS（独立服务端 CLI）** | Apple Silicon (`arm64`)、Intel (`x64`) | `nuonuo-<版本>-darwin-<arm64\|x64>.tar.gz` | Headless `/v1` 后台服务 + 可选 `--web` 网页界面（内置 Node.js） |
| **macOS（轻量桌面客户端）** | Apple Silicon (`arm64`)、Intel (`x64`) | `nuonuo-<版本>-mac-<arm64\|x64>.dmg`（或 `.zip`） | 纯客户端 Electron 应用（不含 Node.js 与服务端，支持远程连接与按需本机部署） |

> 说明：`v0.4.0` 已发布 Linux/macOS 服务端与 macOS 桌面端安装包；Windows 等其他桌面端可按需通过 `pnpm --filter @nuonuo/desktop dist:win` 从源码打包。

### 独立服务端（Linux 与 macOS CLI）

**Linux（`x64` / `arm64`）一行命令安装**：
```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

**macOS 独立服务端 CLI（`arm64` / `x64`）一行命令安装**：
```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash -s -- --server
```

> 默认安装至 `~/.local/share/nuonuo`，并将命令软链至 `~/.local/bin/nuonuo`。若找不到 `nuonuo` 命令，请将 `export PATH="$HOME/.local/bin:$PATH"` 写入 `~/.bashrc` 或 `~/.zshrc`。
> 可通过 `NUONUO_PREFIX`、`NUONUO_BIN_DIR` 自定义目录，或通过 `NUONUO_VERSION=v0.4.0` 固定版本。

**后台启动服务端**：
```sh
# 默认纯 Headless /v1 API 模式（配合桌面端 / 手机 / SDK 连接）
nuonuo start -d

# 或同时开启内置 WebUI（http://127.0.0.1:7420）
nuonuo start -d --web
```

**签发一次性配对码与二维码**：
```sh
nuonuo pair --admin --qr
```

**配置开机自启**：
```sh
nuonuo service install           # macOS launchd / Linux systemd --user
loginctl enable-linger "$USER"   # Linux：退出 SSH 后保持后台常驻
```

> [!IMPORTANT]
> 请勿以 `root` 身份运行服务端。建议使用普通系统用户，并在 **设置 → 安全和执行** 中开启 Docker 沙箱以获得更强文件系统隔离。

### Docker 一键部署

使用仓库根目录自带的 `Dockerfile` 与 `docker-compose.yml` 一键拉起独立服务端：

```sh
# 默认纯 Headless API；设 NUONUO_WEB=1 开启内置 WebUI
NUONUO_WEB=1 docker compose up -d

# 在容器内签发一次性管理员配对码
docker exec -it nuonuo-server nuonuo pair --admin --qr
```

数据默认持久化到宿主机的 `${NUONUO_DATA_DIR:-~/.nuonuo}`（挂载至容器 `/data`），容器环境自动启用 `NUONUO_SECRETS=file` 加密文件存储。

### 轻量 macOS 桌面端

**一行命令安装 / 升级**（自动识别 Apple Silicon / Intel，即便在 Rosetta 终端也会安装原生版本，装入 `/Applications` 或 `~/Applications`）：

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

- 安装完成后可从**启动台**打开，或运行 `open /Applications/Nuonuo.app`。
- 输入任意糯糯服务端地址与配对码（或点击**扫码** / 直接打开 `nuonuo://pair?...` 链接）即可安全连接。
- 本机尚未运行服务端时，可直接点击连接页底部的**「一键部署到本机」**，按需拉起本机 CLI 或 Docker 服务并自动完成配对。
- 后续升级时先从菜单栏图标退出糯糯，再次运行同一条 `curl` 命令即可。
- 如需指定版本：`NUONUO_VERSION=v0.4.0 curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash`。

**手动下载 `.dmg` 安装**：

从 [Releases](https://github.com/cyDione/nuonuo/releases) 下载对应芯片的 `.dmg`。若在未配置 Apple 公证证书前系统提示「无法验证开发者」或「已损坏」，清除隔离标记即可：

```sh
xattr -cr ~/Downloads/nuonuo-<版本>-mac-<芯片>.dmg
# 若已拖入「应用程序」：
xattr -dr com.apple.quarantine /Applications/Nuonuo.app
```

**桌面端使用小贴士**：
- 关闭主窗口后，糯糯会常驻菜单栏 / 系统托盘继续接收通知与徽标更新。
- 任意界面按 `⌘⇧Space` 唤起快捷提问窗口（`Alt+Space` 唤起主窗口）。
- macOS 桌面端刷新令牌默认使用 `AES-256-GCM` + 同目录 `0600` 随机密钥文件（`vault.key`）加密存储，且默认禁用 Chromium OSCrypt 钥匙串查询，**彻底告别每次重启/重装弹出 macOS 钥匙串密码框**（若未来正式签名环境需要改用钥匙串，可设置 `NUONUO_MAC_KEYCHAIN=1`）。

---

## 从源码部署与开发

### 环境准备

- **Node.js** `>= 22.12`
- **pnpm** `10.x`
- **git**
- 可选：`gh`（GitHub CLI）、**Docker**（沙箱隔离）、**Chrome / Chromium**（本机浏览器工具）

### 克隆并构建

```sh
git clone https://github.com/cyDione/nuonuo.git ~/nuonuo
cd ~/nuonuo
pnpm install
pnpm build
```

### 从源码启动服务端

```sh
node apps/daemon/dist/cli.mjs doctor
node apps/daemon/dist/cli.mjs start --web
# 另一个终端签发一次性配对码：
node apps/daemon/dist/cli.mjs pair --admin --qr
```

建议添加 shell 别名：
```sh
alias nuonuo="node ~/nuonuo/apps/daemon/dist/cli.mjs"
```

### 从源码启动轻量桌面端

```sh
pnpm build
cd apps/desktop && pnpm start
```

### 本地热更新开发与验收

```sh
pnpm dev     # 并行启动 daemon（数据目录 ./.nuonuo-dev）与 Vite 热更新（http://localhost:5173）
pnpm check   # 完整运行 11 个工作区类型检查、Vitest 护栏/单元测试与生产构建
pnpm eval    # 运行零 Token 离线 Prompt / 声带 / 安全护栏回归评测集
```

---

## 认证方式与设备配对

统一 `/v1/*` 协议 2.0 支持三种认证方式，均签发短时效 HMAC Access Token（`nna_…`，15 分钟）与一次性轮换 Refresh Token（`nnr_…`，30 天），一旦检测到旧令牌重放立即吊销整个令牌家族：

1. **一次性配对码与二维码（默认）**：
   ```sh
   nuonuo pair --admin --qr
   ```
   有效期 10 分钟（连续 10 次错误自动锁定）。输入配对码、扫码或直接点击 `nuonuo://pair?...` 链接即可完成接入。
2. **Owner 密码登录（`scrypt`）**：
   ```sh
   nuonuo auth set-password "你的强密码"
   ```
   开启后可在连接中心直接用密码登录（带防伪造 IP 限流保护）。
3. **WebAuthn Passkey**：
   在 `localhost` 或 HTTPS 环境下配对后，可在 **设置 → 系统 → 设备与安全** 注册 Touch ID / Face ID / 硬件密钥，实现无密码快速认证。

随时管理已连接设备与活跃会话：
```sh
nuonuo devices list
nuonuo devices revoke <device-id>
nuonuo sessions list
nuonuo sessions revoke <session-id>
```

---

## 首次启动与模型配置

首次接入后，糯糯会在 **主聊** 中用对话卡片带你完成 4 步初始化：

1. **接入模型供应商**：填入你自己的 API Key 或接入本地 Ollama / LM Studio。内置预设包括 **Anthropic**、**OpenAI**、**Google Gemini**、**DeepSeek**、**OpenRouter**、**通义千问 DashScope**、**Moonshot Kimi**、**智谱 GLM**、**SiliconFlow**、**Ollama**（`http://127.0.0.1:11434/v1`）、**LM Studio**（`http://127.0.0.1:1234/v1`）、**TypeSafe Jev**（可选审核决策模型）及任意 OpenAI 兼容网关。
2. **可选：通过 `~/.nuonuo/env` 配置密钥**（开机自启后台服务不读取 shell `export`，服务器环境推荐写入此文件）：
   ```sh
   mkdir -p ~/.nuonuo
   printf 'OPENAI_API_KEY=sk-...\n' > ~/.nuonuo/env
   chmod 600 ~/.nuonuo/env
   ```
   支持 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY` 及对应 `*_BASE_URL`，也可用 `NUONUO_MODEL=<模型 ID>` 指定默认模型。
3. **12 层精细模型路由**（**设置 → 分层模型**）：可为 `router`、`voice`、`worker`、`subagent`、`filter`、`reviewer`、`watchdog`、`summarizer`、`embedding`、`vision`、`transcribe`、`speech` 分别指定主模型、备用链、推理强度与每日限额。
4. **连接常用来源与设定主动程度**：按需启用 Telegram、飞书、Discord、企业微信、钉钉、Slack、GitHub、Gmail，并可导入你在其他 AI 中的记忆。

---

## 局域网与远程访问

服务端默认仅监听 `127.0.0.1:7420`。

### 方式一：SSH 端口转发（远程服务器最安全）

```sh
ssh -L 7420:127.0.0.1:7420 user@your-server
```

转发后在桌面端或本机浏览器连接 `http://127.0.0.1:7420`，配合 `nuonuo pair --admin --qr` 完成配对。

### 方式二：可信局域网或 HTTPS 反向代理

```sh
# 持久化保存到 ~/.nuonuo/config.json
nuonuo config --host 0.0.0.0 --port 7420 --web on
nuonuo restart
```

配置优先级：命令行参数（`--host` / `--port` / `--web`）> 环境变量（`NUONUO_HOST` / `NUONUO_PORT` / `NUONUO_WEB`）> `~/.nuonuo/config.json` > 默认 `127.0.0.1:7420`（Headless）。

> [!WARNING]
> 直接监听 `0.0.0.0` 为明文 HTTP，仅建议在可信局域网使用；如需公网远程访问，请务必放在 HTTPS 反向代理（Caddy / Nginx / Cloudflare Tunnel / Tailscale Serve）之后或使用 SSH 隧道。

### 方式三：聊天软件与自定义 `/v1/*` 设备

- **Telegram / 飞书 / Discord / 企业微信 / 钉钉 / Slack** 均走主动出站长连接 / 长轮询 / Stream 模式，无需公网 IP 或开放入站端口。
- 通过 `nuonuo pair` + [`@nuonuo/client`](../packages/client) 基于统一 [`/v1/*`](11-client-protocol.md) 协议接入手机 App、手表或脚本。

---

## 执行隔离与云电脑

- **目录与凭据硬边界**：在右侧栏 **权限** 中为本地文件夹设置「只能看 / 能改 / 永远不碰」。符号链接在校验前先解析真实路径，`~/.ssh`、`~/.gnupg` 与系统钥匙串默认锁死禁入。
- **Docker 沙箱**：在 **设置 → 安全和执行** 中将 Docker 沙箱设为「仅外部任务」或「所有任务」，容器内仅挂载已授权目录。
- **云电脑独立图形桌面（如 Instabox）**：让 Worker 在云端独立 Linux、`1280×800` 图形桌面与常驻有头 Chromium 中执行，完全不碰本机磁盘，右侧「浏览器」栏支持 60fps 实时画面与一键接管。在 **设置 → 插件 → 安装插件** 输入：
  ```text
  cyDione/nuonuo/tree/main/plugins/instabox
  ```
  完整说明见 [云电脑文档](13-computers.md)。

---

## 升级与旧版迁移

- **独立服务端安装包用户**：
  ```sh
  nuonuo update --check   # 检查新版本
  nuonuo update           # 自动下载安装（systemd 服务会自动平滑重启）
  ```
  也可在网页端 **设置 → 系统 → 版本更新** 一键升级（`~/.nuonuo/env` 中设 `NUONUO_UPDATE_CHECK=0` 可关闭自动检查）。
- **轻量 macOS 桌面端**：先退出应用，再重新运行上方 `install.sh` 一行命令，或下载新版 `.dmg` 覆盖安装。
- **源码部署用户**：
  ```sh
  cd ~/nuonuo && git pull && pnpm install && pnpm build
  nuonuo restart
  ```
- **从旧版 `super-assistant`（`<= v0.2.4`）升级**：自动将 `~/.super-assistant` 迁移至 `~/.nuonuo` 并保留兼容软链及替换 systemd 单元。
- **国内网络插件加速**：在 `~/.nuonuo/env` 中添加 `NUONUO_NPM_REGISTRY=https://registry.npmmirror.com`。

---

## 完整命令行参考

| 命令 | 说明 |
| --- | --- |
| `nuonuo start [-d] [-H <地址>] [-p <端口>] [--web \| --no-web]` | 启动服务（默认纯 Headless；`-d` 后台运行，日志位于 `~/.nuonuo/logs/daemon.log`） |
| `nuonuo stop` / `nuonuo restart` | 停止 / 重启后台服务 |
| `nuonuo status` | 查看进程 PID、监听地址、WebUI 状态、版本、运行时长与副作用队列健康度 |
| `nuonuo config [-H <地址>] [-p <端口>] [--web on\|off]` | 查看或保存默认监听地址、端口及 WebUI 开关至 `config.json` |
| `nuonuo pair [--admin] [--qr] [--json] [--scopes ...]` | 生成 10 分钟有效的一次性设备配对码与二维码（统一 `/v1/*`） |
| `nuonuo auth status \| set-password \| clear-password \| rotate-local-key` | 管理 Owner `scrypt` 密码与本机 `local-admin.key` |
| `nuonuo devices [list \| revoke <id>]` | 查看或吊销已配对客户端设备 |
| `nuonuo sessions [list \| revoke <id>]` | 查看或立即踢下线活跃会话 |
| `nuonuo doctor` | 诊断 Node.js、密钥存储、模型配置、`git`/`gh` 与 Docker 环境 |
| `nuonuo channel presets` / `channel new <名> [--preset <预设>]` | 生成新聊天渠道插件适配器脚手架 |
| `nuonuo update [--check]` | 检查并安装最新独立服务端版本 |
| `nuonuo service install \| uninstall` | 安装 / 卸载开机自启服务（macOS `launchd` / Linux `systemd --user`） |

---

## 数据目录与安全机制

- **服务端数据目录**：默认 `~/.nuonuo/`（可通过 `NUONUO_HOME` 修改），包含 `state.db`（SQLite 数据库）、`local-admin.key`（权限 `0600`，仅本机回环 CLI 管理用）、`config.json`、`env`、`work/`、`memory/`、`secrets/` 与 `logs/`。
- **服务端 API Key 加密存储**：密钥绝不写入 SQLite、日志、模型上下文或 Worker 环境变量。macOS 默认存入 `secrets/secrets.enc`（`AES-256-GCM`，密钥文件 `master.key` 权限 `0600`）避免钥匙串弹窗；Linux / Windows 优先使用系统钥匙串，无桌面环境自动回落到加密文件（`NUONUO_SECRETS=file|keychain` 可强制指定）。
- **桌面端刷新令牌凭据库**：存于 Electron userData 目录下的 `vault.json`。macOS 默认使用 `AES-256-GCM` + `0600` 权限 `vault.key` 加密并禁用 Chromium OSCrypt 钥匙串查询（`NUONUO_MAC_KEYCHAIN=1` 可按需切回钥匙串）；Windows / Linux 使用系统 `safeStorage`。

---

## 常见问题排查

- **macOS 提示「已损坏」或「无法验证开发者」**：运行 `xattr -dr com.apple.quarantine /Applications/Nuonuo.app`，或改用 `install.sh` 一行安装。
- **换了设备或忘记配对信息**：在服务端终端运行 `nuonuo pair --admin --qr` 重新签发 10 分钟一次性配对码。
- **服务启动异常**：查看 `~/.nuonuo/logs/daemon.log` 并执行 `nuonuo doctor` 检查运行环境。
- **进阶运维、签名公证与 OAuth**：详见 [部署与运维（进阶）](deploy.md) 与 [OAuth 授权应用配置](10-oauth.md)。
