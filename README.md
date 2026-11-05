# Super-assistant

一个**完全运行在你自己电脑上**的个人 Super-assistant。设计依据见 [docs/00-research.md](docs/00-research.md)，参照的是 DeepSeek《Super-agent 设计探索》和 `dsh-superagent-prototype`；交互方式对标 Grok Bot / Muse。

> 当前进度：**M5**（M1–M4 的内容见下，M5 的改动见最后一组）。
> - **双层架构**：主 Agent 负责路由和对话；Worker 在本机执行任务，多个任务并行。
> - **执行中途可以插话**：对话里只有一个进行中的任务时，你的消息直接交给它。
> - **后台运行**：耗时命令自动转到后台，跑完后再继续处理。
> - **重启后自动恢复**进行中的工作。
> - **其他**：BYOK、分层模型配置、用量统计。
>
> - **M2 新增**：
>   - **GitHub**：在 Issue 或 PR 里 @agent 就能派活；智能体在原处回复，并跟进评审、CI 和合并结果。
>   - **定时任务**：直接说「每天 9 点…」即可创建。
>   - **未读与桌面通知**。
>   - **来源插件协议**：后续的插件（例如 Gmail）都按这套协议接入。
>
> - **M3 新增**：
>   - **审核层**：规则加审核模型；高风险操作一律问你；你批准后命令才执行；所有决定都记入审计。
>   - **三层记忆**：用户 / 智能体 / 项目，存成可直接编辑的 Markdown 文件。
>   - **Watchdog**：发现卡住、空转的任务会提醒或重启；你也可以在它的专属对话里问它。
>   - **浏览器**：智能体用持久化配置的浏览器；遇到需要登录的网页，你在网页里的远程画面上接管，完成后交还。
>   - **Docker 沙箱**：可选，开启后任务命令在容器里执行。
>
> - **M4 新增**：
>   - **插件 SDK**：第三方插件放进 `~/.super-assistant/plugins/`，你启用后才运行。
>   - **MCP 工具**：可以选择让调用先经过审核。
>   - **Telegram**：在手机上远程指挥家里的电脑。
>   - **Gmail**：智能体读邮件、写草稿，发送由你决定。
>   - **Electron 桌面端**：托盘、系统通知、全局快捷键、开机启动。
>
> - **M5：按文章重新对齐**（审查见 [06-audit](docs/06-audit.md)）：
>   - **对话像跟人聊天**：对话里只有你和它的消息；工具调用、命令、执行轨迹都不出现。做事时只有一行「正在处理：…」；做完只回一句结果，完整结果、文件和过程放在任务详情和「成果」页里；需要你点头、回答或接管浏览器时，才出现一张大白话卡片。
>   - **「活动」和「成果」**：背后发生的一切（需要你的事、正在做的、接下来的定时任务、主动留意到的事、每条外部事件的去向）放在「活动」；交给你的文件放在「成果」。
>   - **主动处理**（文章 §3.1 / §3.4）：没人找它的事件先过程序规则，再由过滤层按你写的自然语言策略判断；分关闭 / 观察 / 自动三种模式。自动模式下在本地悄悄做，过程中不打扰你、不对外发任何东西，有价值才告诉你。
>   - **说明（带版本）**：沟通方式 / 做事边界 / 交付要求，对它说「以后……」会自动记下；Watchdog 也能在线修正说明和主动策略。
>   - **子任务**：Worker 可以异步分出子任务并行做（`subagent_start` / `subagent_stop`）。
>   - **链式召回**：可以从线程追到上面的工作，再追到它的执行记录。
>
> - **M6：Muse 式交互 + Grok Bot 式记忆**（见 [09](docs/09-m6-muse-and-memory.md)）：
>   - **主对话**：一个长对话加侧聊；助手有自己的名字、头像和性格；头像下显示它在做什么，点开是活动面板。
>   - **批准**：可以选"这件事里都同意"；成果在对话里直接预览，HTML 可以交互。
>   - **记忆**：重做成带来源、信任级别、置信度和有效期的记忆系统。后台自动整理；外部来源的内容只能进"等你确认"；记忆按侧聊或仓库绑定到项目。
>   - **设置**：按组归类。
>
> 设计和实现细节见 docs/ 下的 [01-m1](docs/01-m1-implementation.md)、[02-m2](docs/02-m2-implementation.md)、[03-m3](docs/03-m3-implementation.md)、[04-plugin-sdk](docs/04-plugin-sdk.md)、[05-m4](docs/05-m4-implementation.md)、[06-audit](docs/06-audit.md)、[07-architecture](docs/07-architecture.md)（论文架构逐节对照）、[08-industry-review](docs/08-industry-review.md)（业界解读查漏补缺）、[09-m6](docs/09-m6-muse-and-memory.md)。

## 部署（自己的 Mac 或 Linux 电脑）

服务和执行都在你自己的机器上，只监听 `127.0.0.1`，不对外开放端口。

**1. 准备**：Node.js ≥ 22.12、pnpm、git。可选：`gh`（GitHub）、Docker（沙箱）、Chrome/Chromium（浏览器工具）。

```bash
git clone https://github.com/cyDione/super-assistant.git ~/super-assistant
cd ~/super-assistant
pnpm install
pnpm build
```

**2. 填 API key**（二选一）：
- 启动后在网页的「设置 → 模型供应商」里填写，key 存进系统钥匙串；
- 或写进数据目录的 `env` 文件。开机自启的服务读不到 shell 里的 `export`，用这个文件最稳：

```bash
mkdir -p ~/.super-assistant
printf 'OPENAI_API_KEY=sk-...\n' > ~/.super-assistant/env   # 每行 KEY=value；换成你用的供应商，也可放 *_BASE_URL、GITHUB_TOKEN 等
chmod 600 ~/.super-assistant/env
```

各层用哪个模型在「设置 → 分层模型」里选。想跳过这一步（比如测试），在 `env` 里加一行 `SUPER_ASSISTANT_MODEL=<模型 id>`，各层都用 `env` 里第一个供应商的这个模型；这只在首次启动、还没配置过任何层时生效。

**3. 启动，检查**：

```bash
node apps/daemon/dist/cli.mjs doctor          # 检查环境
node apps/daemon/dist/cli.mjs start           # 打印并打开登录链接（http://127.0.0.1:7420/auth?token=…）
```

可以加个别名：`alias super-assistant="node ~/super-assistant/apps/daemon/dist/cli.mjs"`。登录链接丢了，用 `super-assistant token` 重新打印。

**4. 开机自启**（macOS 用 launchd，Linux 用 systemd 用户服务）：

```bash
super-assistant service install        # 写入并启动；super-assistant service uninstall 移除
loginctl enable-linger $USER      # 仅 Linux：没登录桌面时也保持运行
```

**5. 可选**：
- **桌面端**：`cd apps/desktop && pnpm start`，或先在仓库根目录 `pnpm build`，再用 `pnpm dist:mac` / `pnpm dist:linux` 打包。Linux 服务器可以用不带桌面端的包：`pnpm build && bash scripts/package-linux.sh`，或在 GitHub Actions 里手动运行 “Package Linux x64” 工作流；包里自带 Node.js，解压后运行 `./bin/super-assistant start`。

  一键安装到 Linux x64（仓库是私有的，需要已登录的 `gh`，或在 `GITHUB_TOKEN` 里放一个能读本仓库的令牌）：

  ```sh
  gh api repos/cyDione/super-assistant/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
  ```

  会从最新的 GitHub Release 下载包，装到 `~/.local/share/super-assistant`，命令链接到 `~/.local/bin/super-assistant`；重复运行即升级。推送 `v*` 标签时工作流会自动发布 Release。发版前先用 `pnpm set-version 0.1.4` 把所有包改成同一个版本号并提交，再打 `v0.1.4` 标签；标签和版本号不一致时，工作流会报错并且不发布。
- **在外面用**：启用 Telegram 插件，用手机指挥家里的电脑，不需要开放端口。或者用 SSH 端口转发 `ssh -L 7420:127.0.0.1:7420 你的电脑`，再在本地打开登录链接。
- **GitHub**：在「设置 → 来源 → GitHub」点「授权 GitHub」，页面会给出一个验证码，在 github.com/login/device 输入并同意即可（设备码授权，不需要回调地址，通过 SSH 端口转发访问也能用）；再填写要监听的仓库。授权后智能体的 `gh` 和 git 也用这个授权。没有授权时仍会退回到 `env` 里的 `GITHUB_TOKEN` 或本机 `gh auth login`。
- **Gmail**：启用 Gmail 插件，在「设置 → 来源 → Gmail」点「授权 Gmail」，用 Google 账号登录并同意，浏览器会跳回本机服务（经 `ssh -L` 转发也可以）。随时可以点「断开授权」，会同时在 Google 那边撤销。
- 两个授权用到的 OAuth 应用怎么建，见 [docs/10-oauth.md](docs/10-oauth.md)。

**升级**：

用安装包（`install.sh`）装的：服务每天检查两次有没有新的 Release，有的话侧栏「设置」旁会显示「有更新」，在「设置 → 系统 → 版本更新」点「立即更新」即可，装完服务自动重启。命令行也可以：

```bash
super-assistant update --check   # 只检查
super-assistant update           # 下载并安装最新版本；systemd 服务会自动重启
```

检查和下载需要 GitHub 访问（已登录的 `gh`，或数据目录 `env` 文件里的 `GITHUB_TOKEN`）。不想后台检查，在 `env` 里写 `SUPER_ASSISTANT_UPDATE_CHECK=0`。

v0.1.0 还没有自动更新功能：从 v0.1.0 升级，需要手动再运行一次上面的 `install.sh` 安装命令，之后的版本就可以用「立即更新」或 `super-assistant update` 了。

从源码运行的：

```bash
cd ~/super-assistant && git pull && pnpm install && pnpm build
```

升级后重启服务：`super-assistant service install`，或者停掉再 `start`。数据目录 `~/.super-assistant/` 不受影响，数据库会自动迁移。

**从旧名 superagent 升级**：项目改名后，命令、数据目录、环境变量和服务名都换了，旧名不再识别。已经部署过的话，按顺序做一次：

```bash
# 1. 先用旧版本停掉并移除旧服务（git pull 之前）
superagent service uninstall      # 或手动：launchctl unload -w ~/Library/LaunchAgents/dev.superagent.daemon.plist
                                  #        systemctl --user disable --now superagent.service
# 2. 拉新代码并构建
cd ~/super-assistant && git pull && pnpm install && pnpm build
# 3. 搬数据目录，改 env 文件里的变量名
mv ~/.superagent ~/.super-assistant
sed -i.bak 's/^\(export \)\{0,1\}SUPERAGENT_/\1SUPER_ASSISTANT_/' ~/.super-assistant/env
# 4. 用新命令装服务（别名也改成 super-assistant）
super-assistant service install
```

另外：存在系统钥匙串里的 API key 换了钥匙串条目名，需要在「设置 → 模型供应商」里重新填一次（放在 `env` 文件里的不受影响）；第三方插件 `package.json` 里的 `"superagent"` 字段改成 `"super-assistant"`；Gmail 派活标签的默认值变成 `super-assistant`，在用默认值的话把邮箱里的标签也改名。

**安全建议**：任务的命令以运行服务的用户身份执行。建议用一个单独的普通用户运行，或在「设置 → 执行环境」里把 Docker 沙箱设为「全部」。不要以 root 运行。

## 桌面端

```bash
pnpm build                      # 先构建服务和网页
cd apps/desktop && pnpm start   # 已有服务时直接连接；没有的话用系统 Node 启动它
```

- 关闭窗口时，应用会留在托盘里。
- 按 `Cmd/Ctrl+Shift+Space` 随时呼出窗口或打开新对话。
- 打包：`pnpm dist:mac` 或 `pnpm dist:linux`（需要本机安装 Node 22 及以上版本）。

## 命令行

| 命令 | 作用 |
|---|---|
| `super-assistant start [-p 端口] [--no-open]` | 启动本机服务 |
| `super-assistant status` | 查看是否在运行，以及后台队列是否健康 |
| `super-assistant doctor` | 检查运行环境（Node、钥匙串、模型配置、git/gh/Docker） |
| `super-assistant token [--rotate]` | 打印登录链接；加 `--rotate` 时轮换访问令牌 |
| `super-assistant service install / uninstall` | 开机自启（macOS 用 launchd，Linux 用 systemd 用户服务） |

在仓库内开发时，可以用 `node apps/daemon/dist/cli.mjs <命令>` 代替 `super-assistant`。

## 开发

```bash
pnpm dev     # daemon（tsx watch，数据目录为 ./.super-assistant-dev）+ Vite（http://localhost:5173）
pnpm check   # 类型检查 + 测试 + 构建
```

开发模式下，daemon 会打印指向 `localhost:5173` 的登录链接；Vite 会把 `/api` 和 `/auth` 代理到 daemon。

## 数据与安全

- **数据目录**：默认是 `~/.super-assistant/`，可用 `SUPER_ASSISTANT_HOME` 修改。里面包括：`state.db`（SQLite）、`token`（访问令牌，权限 0600）、`work/`、`memory/`、`logs/`。
- **API key 存放位置**：只存在系统钥匙串里（macOS Keychain / Linux Secret Service），不进数据库、不进日志，也不会进入模型上下文。如果钥匙串不可用（例如无桌面的 Linux），会自动改用 `secrets/secrets.enc`（AES-256-GCM，密钥 `master.key` 的权限为 0600）。`SUPER_ASSISTANT_SECRETS=file|keychain` 可以强制指定其中一种。
- **网络访问控制**：服务只监听 `127.0.0.1`。所有 API 都需要访问令牌（HttpOnly + SameSite=Strict 的 cookie，或 Bearer 头），并校验 `Host` 与 `Origin`，防止 DNS rebinding 和其他网页伪造请求。

## 代码结构

```
apps/daemon     本机服务：Hono API、SSE、CLI、组合根
apps/web        React 19 + Vite + Tailwind 4 前端（构建后由 daemon 托管）
packages/core   领域层：Trigger / Thread / Ticket / 订阅 / 汇报，主 Agent 与 Worker 的工具和提示词
packages/agent-runtime  Agent 运行时：事件日志、收件箱步间注入、后台命令、文件/Shell/网页工具、recall、压缩
packages/sources 来源插件协议与注册表、插件加载器、GitHub 来源、定时任务（cron）
packages/plugin-sdk 写插件用的类型与工具
packages/plugins 内置插件：Telegram、Gmail（以及测试用的模拟 API）
apps/desktop    Electron 桌面端
examples/plugins 第三方插件示例（RSS 订阅）
packages/db     SQLite + Drizzle、迁移、持久化副作用队列 Effects
packages/models 供应商、BYOK 密钥存储、分层模型解析（继承 / 备用链 / 预算）、用量账本
docs/           调研与设计文档
```

## 路线图

- ~~M1~~：主 Agent + Worker 双层架构、异步 job、任务卡片、「待你处理」（已完成）
- ~~M2~~：GitHub 插件、定时任务（Routine）、Agent 主动发起对话（已完成）
- ~~M3~~：Reviewer 审核与规则、三层记忆、Watchdog、浏览器接管、Docker 沙箱（已完成）
- ~~M4~~：插件 SDK、MCP、Gmail / Telegram、Electron（已完成）
- ~~M5~~：按文章重新对齐——对话体验、主动处理、说明版本、子任务、链式召回（已完成）
- ~~M6~~：Muse 式主对话与个性、任务内授权、成果预览、记忆系统重做、设置归类（已完成）

## 许可

领域设计参考了 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）。后续移植的代码会在对应文件中保留原版权声明。
