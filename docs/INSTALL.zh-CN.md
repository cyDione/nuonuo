# 安装与部署教程

[English](INSTALL.md) | **简体中文** · [返回中文 README](../README.zh-CN.md)

糯糯的服务、SQLite 状态库、文件和本地执行都运行在你自己的机器上。默认仅监听 `127.0.0.1:7420`，不对外开放公网端口，模型使用你自己的 API Key。

## 目录

- [安装包安装（推荐）](#安装包安装推荐)
  - [macOS 桌面端](#macos-桌面端)
  - [Windows 桌面端](#windows-桌面端)
  - [Linux / 无桌面服务器](#linux--无桌面服务器)
- [从源码部署与开发](#从源码部署与开发)
- [首次启动与模型配置](#首次启动与模型配置)
- [局域网与远程访问](#局域网与远程访问)
- [执行隔离与云电脑](#执行隔离与云电脑)
- [升级与旧版迁移](#升级与旧版迁移)
- [完整命令行参考](#完整命令行参考)
- [数据目录与安全机制](#数据目录与安全机制)
- [常见问题排查](#常见问题排查)

---

## 安装包安装（推荐）

每个 [GitHub Release](https://github.com/cyDione/nuonuo/releases) 都提供开箱即用的完整包，已内置 Node.js，无需另行安装运行环境：

| 平台 | CPU 架构 | 安装包文件 | 形态 |
| --- | --- | --- | --- |
| **macOS** | Apple Silicon (`arm64`)、Intel (`x64`) | `nuonuo-<版本>-mac-<arm64\|x64>.dmg`（或 `.zip`） | 桌面应用（内置服务，可在设置中开启网页访问） |
| **Windows** | `x64`、`arm64` | `nuonuo-<版本>-win-<x64\|arm64>-setup.exe`（或免安装 `.zip`） | 桌面应用（内置服务，可在设置中开启网页访问） |
| **Linux（服务器 / 无桌面）** | `x64`（amd64）、`arm64`（aarch64） | `nuonuo-<版本>-linux-<x64\|arm64>.tar.gz` | 后台守护服务 + 网页界面 |

### macOS 桌面端

**一行命令安装 / 升级**（自动识别 Apple Silicon / Intel，即便在 Rosetta 终端中也会安装原生版本，直接装入 `/Applications` 或 `~/Applications`）：

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

- 安装完成后可从**启动台**打开，或运行 `open /Applications/Nuonuo.app`。
- 后续升级时先从菜单栏图标退出糯糯，再次运行同一条命令即可（数据目录 `~/.nuonuo` 不会被覆盖）。
- 如需指定版本：`NUONUO_VERSION=v0.3.12 curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash`。
- 通过 `curl` 下载的文件不带浏览器隔离标记，在仓库尚未配置 Apple 开发者公证证书前也能直接打开。

**手动下载 `.dmg` 安装**：

从 [Releases](https://github.com/cyDione/nuonuo/releases) 下载对应芯片的 `.dmg`。若系统提示「无法验证开发者」或「已损坏」，在打开前清除隔离标记即可：

```sh
xattr -cr ~/Downloads/nuonuo-<版本>-mac-<芯片>.dmg
# 如果已经拖入「应用程序」：
xattr -dr com.apple.quarantine /Applications/Nuonuo.app
```

**桌面端使用小贴士**：
- 关闭主窗口后，糯糯会常驻菜单栏 / 系统托盘继续处理后台任务。
- 任意界面按 `⌘⇧Space`（Windows 为 `Ctrl+Shift+Space`）即可唤起快捷提问窗口。
- 桌面端默认仅允许应用窗口访问；如需用浏览器或局域网手机打开，到 **设置 → 系统 → 网页访问** 勾选「允许在浏览器里打开」，选择「仅本机」或「局域网」并重启服务。

### Windows 桌面端

1. 从 [Releases](https://github.com/cyDione/nuonuo/releases) 下载 `nuonuo-<版本>-win-<x64|arm64>-setup.exe`（或免安装 `.zip`）。
2. 双击安装。如遇 Windows SmartScreen 拦截（未配置商业代码签名），点击 **更多信息 → 仍要运行**。
3. 从开始菜单打开 **Nuonuo** 即可，应用内已自带后台服务与 Node.js。

### Linux / 无桌面服务器

**一行命令安装**（自动识别 `x64` / `arm64`，安装至 `~/.local/share/nuonuo`，并将命令软链至 `~/.local/bin/nuonuo`）：

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

> 若提示找不到 `nuonuo` 命令，请将 `export PATH="$HOME/.local/bin:$PATH"` 写入 `~/.bashrc` 或 `~/.zshrc`。
> 支持通过 `NUONUO_PREFIX`、`NUONUO_BIN_DIR` 自定义目录，或通过 `NUONUO_VERSION=v0.3.12` 固定版本。

**后台启动服务**：

```sh
nuonuo start -d
```

启动后会输出带一次性登录令牌的访问地址：

```text
http://127.0.0.1:7420/auth?token=...
```

用浏览器打开该链接即可进入界面。随时检查环境或重新获取链接：

```sh
nuonuo doctor
nuonuo token
```

**配置开机自启（systemd 用户服务）**：

```sh
nuonuo service install
loginctl enable-linger "$USER"   # 退出 SSH / 无桌面登录时也保持常驻
```

> [!IMPORTANT]
> 请勿使用 `root` 身份运行服务。建议为糯糯使用普通系统用户，或在 **设置 → 安全和执行** 中开启 Docker 沙箱以获得更强隔离。

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

### 启动服务

```sh
node apps/daemon/dist/cli.mjs doctor
node apps/daemon/dist/cli.mjs start
```

建议添加 shell 别名方便日常使用：

```sh
alias nuonuo="node ~/nuonuo/apps/daemon/dist/cli.mjs"
```

### 从源码启动桌面端

```sh
pnpm build
cd apps/desktop && pnpm start
```

### 本地热更新开发

```sh
pnpm dev     # 同时启动 daemon（数据目录 ./.nuonuo-dev）与 Vite（http://localhost:5173）
pnpm check   # 完整执行类型检查、单元/集成测试与生产构建
```

---

## 首次启动与模型配置

首次打开界面时，糯糯会直接在 **主聊** 中用对话卡片带你完成 4 步初始化（无需跳转复杂表单）：

1. **接入模型供应商**：填入你自己的 API Key，或接入本地 Ollama / LM Studio。内置预设包括：
   - **Anthropic**、**OpenAI**、**Google Gemini**、**DeepSeek**
   - **OpenRouter**、**通义千问 DashScope**、**Moonshot Kimi**、**智谱 GLM**、**SiliconFlow**
   - **Ollama**（`http://127.0.0.1:11434/v1`）、**LM Studio**（`http://127.0.0.1:1234/v1`），以及任意**自定义 OpenAI 兼容网关**
   - **TypeSafe Jev**（可选决策模型，专用于审核层）
2. **可选：通过 `~/.nuonuo/env` 配置密钥**（开机自启服务读不到 shell 的 `export`，服务器环境推荐写入此文件）：

   ```sh
   mkdir -p ~/.nuonuo
   printf 'OPENAI_API_KEY=sk-...\n' > ~/.nuonuo/env
   chmod 600 ~/.nuonuo/env
   ```

   支持 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY` 及对应 `*_BASE_URL`，也可用 `NUONUO_MODEL=<模型 ID>` 指定首次自动选用的默认模型。
3. **12 层精细模型路由**（**设置 → 分层模型**）：可为 `router`（主 Agent）、`voice`（声带层）、`worker`（执行）、`subagent`（子任务）、`filter`（过滤）、`reviewer`（审核）、`watchdog`（看门狗）、`summarizer`（摘要）、`embedding`（向量）、`vision`（视觉）、`transcribe`（听写）、`speech`（朗读）分别指定主模型、备用链、推理强度与每日 Token / 费用上限。未单独配置的层自动按继承链沿用。
4. **连接常用来源与设定主动程度**：按需启用 Telegram、飞书、Discord、企业微信、钉钉、Slack、GitHub、Gmail，并可一键导入你在其他 AI 中攒下的长期记忆。

---

## 局域网与远程访问

服务默认只监听 `127.0.0.1:7420`。

### 方式一：SSH 端口转发（远程服务器最安全）

```sh
ssh -L 7420:127.0.0.1:7420 user@your-server
```

转发后直接在本机浏览器打开 `http://127.0.0.1:7420/auth?token=...`。

### 方式二：可信局域网访问

```sh
# 临时指定监听所有网卡
nuonuo start -d --host 0.0.0.0 --port 7420

# 持久化保存到 ~/.nuonuo/config.json
nuonuo config --host 0.0.0.0 --port 7420
nuonuo restart
```

优先级顺序：命令行参数（`--host` / `--port`）> 环境变量（`NUONUO_HOST` / `NUONUO_PORT`）> `~/.nuonuo/config.json` > 默认 `127.0.0.1:7420`。

> [!WARNING]
> 登录链接中的令牌等同于访问密码且为明文 HTTP。仅建议在可信局域网内监听 `0.0.0.0`；如需公网远程访问，请务必放在 HTTPS 反向代理之后或使用 SSH 隧道。

### 方式三：通过聊天软件或配对设备遥控

- 启用 **Telegram / 飞书 / Discord / 企业微信 / 钉钉 / Slack**（均采用出站长连接 / 长轮询 / Stream 模式，无需公网 IP 或开放端口），出门直接用手机指挥家里的电脑。
- 使用 `nuonuo pair` 生成配对码，通过 `/client/v1` [客户端接入协议](11-client-protocol.md) 与 [`@nuonuo/client`](../packages/client) 接入自定义手机 App、手表、音箱或脚本。

---

## 执行隔离与云电脑

- **目录与凭据硬边界**：在右侧栏 **权限** 中为本地文件夹设置「只能看 / 能改 / 永远不碰」。符号链接会在校验前解析真实路径，`~/.ssh`、`~/.gnupg` 与系统钥匙串默认锁死禁入。
- **Docker 沙箱**：在 **设置 → 安全和执行** 中将 Docker 沙箱设为「仅外部任务」或「所有任务」，容器内仅挂载已授权目录并自动遮蔽禁入子路径。
- **云电脑独立图形桌面（如 Instabox）**：让 Worker 在云端独立 Linux、`1280×800` 图形桌面和常驻有头 Chromium 浏览器里跑任务，完全不碰你本机磁盘；右侧栏 **浏览器** 支持 60fps 实时画面与一键接管登录/验证。在 **设置 → 插件 → 安装插件** 输入：
  ```text
  cyDione/nuonuo/tree/main/plugins/instabox
  ```
  完整说明见 [云电脑文档](13-computers.md)。

---

## 升级与旧版迁移

- **Linux 安装包用户**：
  ```sh
  nuonuo update --check   # 检查是否有新版本
  nuonuo update           # 自动下载安装（如使用 systemd 服务会自动重启）
  ```
  也可在网页端 **设置 → 系统 → 版本更新** 一键升级；在 `~/.nuonuo/env` 中写入 `NUONUO_UPDATE_CHECK=0` 可关闭后台自动检查。
- **macOS 桌面端**：先退出应用，再重新执行上方 `curl ... install.sh | bash` 一行命令，或下载新版 `.dmg` 覆盖安装。
- **Windows 桌面端**：下载最新 `setup.exe` 直接覆盖安装。
- **源码部署用户**：
  ```sh
  cd ~/nuonuo && git pull && pnpm install && pnpm build
  nuonuo restart   # 或重新执行 nuonuo service install
  ```
- **从旧版 `super-assistant`（`<= v0.2.4`）升级**：新版本会自动把 `~/.super-assistant` 迁移至 `~/.nuonuo` 并保留兼容软链，同步迁移密钥与 systemd 单元，`SUPER_ASSISTANT_*` 环境变量继续兼容。
- **国内网络插件加速**：安装插件依赖若较慢，可在 `~/.nuonuo/env` 中添加 `NUONUO_NPM_REGISTRY=https://registry.npmmirror.com`。

---

## 完整命令行参考

| 命令 | 说明 |
| --- | --- |
| `nuonuo start [-d] [-H <地址>] [-p <端口>] [--no-open]` | 启动服务（`-d` 后台运行，日志位于 `~/.nuonuo/logs/daemon.log`） |
| `nuonuo stop` / `nuonuo restart` | 停止 / 重启后台服务 |
| `nuonuo status` | 查看进程 PID、监听地址、版本、运行时长与副作用队列健康状态 |
| `nuonuo config [-H <地址>] [-p <端口>] [--web on\|off]` | 查看或保存默认监听地址、端口及桌面端网页访问开关 |
| `nuonuo doctor` | 诊断 Node.js、密钥存储、模型配置、git/gh 与 Docker 环境 |
| `nuonuo token [--rotate]` | 打印登录链接（加 `--rotate` 轮换令牌，重启服务生效） |
| `nuonuo pair [--name <名>] [--approvals] [--no-notices]` | 生成 10 分钟有效的一次性设备配对码（`/client/v1`） |
| `nuonuo devices [list \| revoke <id>]` | 查看或吊销已配对设备 |
| `nuonuo channel presets` / `channel new <名> [--preset <预设>]` | 生成新聊天渠道插件适配器脚手架 |
| `nuonuo update [--check]` | 检查并安装 Linux 新版本 |
| `nuonuo service install \| uninstall` | 安装 / 卸载开机自启服务（macOS `launchd` / Linux `systemd --user`） |

---

## 数据目录与安全机制

- **数据目录**：默认 `~/.nuonuo/`（可通过 `NUONUO_HOME` 修改），包含 `state.db`（SQLite 数据库）、`token`（权限 `0600`）、`config.json`、`env`、`work/`、`memory/`、`secrets/` 与 `logs/`。
- **API Key 加密存储**：密钥绝不写入 SQLite、日志、模型上下文或 Worker 环境变量。macOS 默认存入加密文件 `secrets/secrets.enc`（AES-256-GCM，密钥文件 `master.key` 权限 `0600`）以避免每次启动弹出钥匙串密码框；Linux / Windows 优先使用系统钥匙串，无桌面环境自动回落到加密文件（可用 `NUONUO_SECRETS=file|keychain` 强制指定）。
- **严格访问鉴权**：所有接口均校验访问令牌（`HttpOnly; SameSite=Strict` Cookie 或 `Bearer` 请求头），并校验 `Host` 与 `Origin` 防止 DNS rebinding 与跨站伪造请求。

---

## 常见问题排查

- **macOS 提示「已损坏」或「无法验证开发者」**：运行 `xattr -dr com.apple.quarantine /Applications/Nuonuo.app`，或改用 `install.sh` 一行安装。
- **忘记登录链接**：终端运行 `nuonuo token` 重新打印；怀疑泄露可运行 `nuonuo token --rotate` 轮换令牌。
- **服务启动异常**：查看 `~/.nuonuo/logs/daemon.log` 并执行 `nuonuo doctor` 检查环境依赖。
- **进阶运维与打包签名**：详见 [部署与运维（进阶）](deploy.md) 与 [OAuth 授权应用配置](10-oauth.md)。
