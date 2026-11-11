# 部署与运维

README 里只放了最常用的安装方式，这里是完整说明：各平台安装包、后台运行与监听地址、从源码部署、升级、桌面端、命令行、数据与安全。

## 安装与部署

服务和执行都在你自己的机器上。默认只监听 `127.0.0.1`，不对外开放端口；需要时可以改成监听局域网地址。

### 安装包（推荐）

每个 [Release](https://github.com/cyDione/super-assistant/releases) 都有下面这些包，都自带 Node.js，不用另装运行环境：

| 平台 | CPU | 文件 | 形态 |
|---|---|---|---|
| Linux（服务器 / 无桌面） | x64（amd64）、arm64 | `super-assistant-<版本>-linux-<x64\|arm64>.tar.gz` | 后台服务 + 网页界面 |
| macOS | Apple 芯片（arm64）、Intel（x64） | `super-assistant-<版本>-mac-<arm64\|x64>.dmg`（或 `.zip`） | 桌面应用，网页访问可在设置里开启 |
| Windows | x64、arm64 | `super-assistant-<版本>-win-<x64\|arm64>-setup.exe`（或免安装 `.zip`） | 桌面应用，网页访问可在设置里开启 |

**Linux 一键安装**（x64 和 arm64 自动识别，不需要登录 GitHub）：

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/super-assistant/main/install.sh | bash
```

装到 `~/.local/share/super-assistant`，命令链接到 `~/.local/bin/super-assistant`；重复运行即升级，数据目录 `~/.super-assistant` 不受影响。指定版本：`SUPER_ASSISTANT_VERSION=v0.2.0`（放在 `bash` 前面）。

**Linux 后台运行、地址和端口**：

```bash
super-assistant start -d                                # 后台启动，打印登录链接（http://127.0.0.1:7420/auth?token=…）
super-assistant start -d --host 0.0.0.0 --port 8080     # 监听所有网卡的 8080 端口，局域网里的设备也能打开
super-assistant config --host 0.0.0.0 --port 8080       # 保存为默认值（写入 ~/.super-assistant/config.json），以后每次启动都用
super-assistant status | stop | restart                 # 查看 / 停止 / 用保存的设置重启
super-assistant service install                         # 开机自启（systemd 用户服务，同样读取保存的地址和端口）
```

地址和端口的优先级：命令行参数 `--host/--port` > 环境变量 `SUPER_ASSISTANT_HOST/SUPER_ASSISTANT_PORT`（也可以写进 `~/.super-assistant/env`）> `config.json` > 默认 `127.0.0.1:7420`。网页的「设置 → 系统 → 监听地址」也能改，改完点「重启服务」生效。监听非本机地址时登录链接就是密码，而且是明文 HTTP：只在可信的局域网里这样用，远程访问请放在 HTTPS 反向代理后面，或用 `ssh -L 7420:127.0.0.1:7420 <服务器>`。

**macOS / Windows 桌面端**：下载对应的安装包安装即可。应用自带服务，关掉窗口后留在托盘里继续工作。默认只有应用窗口能用；想在浏览器（或手机等局域网设备）里打开，到「设置 → 系统 → 网页访问」勾选「允许在浏览器里打开」，选「仅本机」或「局域网」并设置端口，点「重启服务」，再复制登录链接。

- macOS 包没有 Apple 开发者签名（只做了 ad-hoc 签名）。第一次打开如果提示「已损坏」或「无法验证开发者」，运行 `xattr -dr com.apple.quarantine /Applications/Super-assistant.app`，或在 Finder 里右键 →「打开」。
- Windows 包没有代码签名，SmartScreen 提示时点「更多信息 → 仍要运行」。
- 桌面端有新版本时，「设置 → 系统 → 版本更新」会提示并给出下载链接，下载新安装包覆盖安装即可。

### 从源码部署

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
- **自己打包**：Linux 无桌面包 `pnpm build && bash scripts/package-linux.sh`（打的是本机 CPU 的包）；桌面端 `pnpm build`，再在 `apps/desktop` 里运行 `pnpm dist:mac` / `pnpm dist:win`（同样只能打本机系统和 CPU 的包）。GitHub Actions 的 “Release” 工作流在 6 台对应的机器上打全部的包；推送 `v*` 标签时自动发布 Release。发版前先用 `pnpm set-version 0.2.0` 把所有包改成同一个版本号并提交，再打 `v0.2.0` 标签；标签和版本号不一致时，工作流会报错并且不发布。也可以不打标签：在 Actions → Release → Run workflow 里填版本号（和可选的发布说明）手动运行，6 个包都打成功后，工作流自己创建 `v0.2.0` 标签和 Release；这个版本已经有标签或 Release 时，它直接报错，不会重复发布。已经发布的版本打包中途停了，就勾上 rebuild 再运行一次，它会按原来的标签重新打包，并把包传到原来的 Release 上。
- **在外面用**：启用 Telegram 插件，用手机指挥家里的电脑，不需要开放端口。或者用 SSH 端口转发 `ssh -L 7420:127.0.0.1:7420 你的电脑`，再在本地打开登录链接；在同一个局域网里，也可以让服务监听局域网地址（见上面的「地址和端口」）。
- **GitHub**：在「设置 → 来源 → GitHub」点「授权 GitHub」，页面会给出一个验证码，在 github.com/login/device 输入并同意即可（设备码授权，不需要回调地址，通过 SSH 端口转发访问也能用）；再填写要监听的仓库。授权后智能体的 `gh` 和 git 也用这个授权。没有授权时仍会退回到 `env` 里的 `GITHUB_TOKEN` 或本机 `gh auth login`。
- **Gmail**：启用 Gmail 插件，在「设置 → 来源 → Gmail」点「授权 Gmail」，用 Google 账号登录并同意，浏览器会跳回本机服务（经 `ssh -L` 转发也可以）。随时可以点「断开授权」，会同时在 Google 那边撤销。
- 两个授权用到的 OAuth 应用怎么建，见 [10-oauth.md](10-oauth.md)。

**升级**：

用安装包（`install.sh`）装的：服务每天检查两次有没有新的 Release，有的话侧栏「设置」旁会显示「有更新」，在「设置 → 系统 → 版本更新」点「立即更新」即可，装完服务自动重启。命令行也可以：

```bash
super-assistant update --check   # 只检查
super-assistant update           # 下载并安装最新版本；systemd 服务会自动重启
```

仓库是公开的，检查和下载不需要登录 GitHub（`env` 里有 `GITHUB_TOKEN` 时会带上，只为提高 API 频率上限）。不想后台检查，在 `env` 里写 `SUPER_ASSISTANT_UPDATE_CHECK=0`。

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

macOS 和 Windows 直接用 Release 里的安装包（见上面「安装包」）。从源码运行：

```bash
pnpm build                      # 先构建服务和网页
cd apps/desktop && pnpm start   # 已有服务时直接连接；没有的话用系统 Node 启动它
```

- 关闭窗口时，应用会留在托盘里。
- 按 `Cmd/Ctrl+Shift+Space` 随时呼出窗口或打开新对话。
- 网页访问默认关闭，在「设置 → 系统 → 网页访问」开启（可选仅本机或局域网，以及端口）。
- 打包：`pnpm dist:mac` 或 `pnpm dist:win`，打出本机系统和 CPU 的安装包，里面带着服务和 Node.js。

## 命令行

| 命令 | 作用 |
|---|---|
| `super-assistant start [-d] [-H 地址] [-p 端口] [--no-open]` | 启动服务；`-d` 在后台运行（日志在 `~/.super-assistant/logs/daemon.log`），`-H 0.0.0.0` 让局域网可访问 |
| `super-assistant stop` / `restart` | 停止 / 重启服务（`restart` 在后台启动，用保存的地址和端口） |
| `super-assistant config [-H 地址] [-p 端口]` | 查看或保存监听地址和端口（下次启动生效） |
| `super-assistant status` | 查看是否在运行、监听地址，以及后台队列是否健康 |
| `super-assistant doctor` | 检查运行环境（Node、钥匙串、模型配置、git/gh/Docker） |
| `super-assistant token [--rotate]` | 打印登录链接；加 `--rotate` 时轮换访问令牌 |
| `super-assistant update [--check]` | 检查并安装新版本（Linux 安装包） |
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
- **网络访问控制**：默认只监听 `127.0.0.1`（可以改成局域网地址，见上面「地址和端口」）。所有 API 都需要访问令牌（HttpOnly + SameSite=Strict 的 cookie，或 Bearer 头），并校验 `Host` 与 `Origin`，防止 DNS rebinding 和其他网页伪造请求。
