# 部署与运维

README 里只放了最常用的安装方式，这里是完整说明：各平台安装包、后台运行与监听地址、从源码部署、升级、桌面端、命令行、数据与安全。

## 安装与部署

服务和执行都在你自己的机器上。默认只监听 `127.0.0.1`，不对外开放端口；需要时可以改成监听局域网地址。

### 安装包（推荐）

每个 [Release](https://github.com/cyDione/nuonuo/releases) 都有下面这些包，都自带 Node.js，不用另装运行环境：

| 平台 | CPU | 文件 | 形态 |
|---|---|---|---|
| Linux（服务器 / 无桌面） | x64（amd64）、arm64 | `nuonuo-<版本>-linux-<x64\|arm64>.tar.gz` | 后台服务 + 网页界面 |
| macOS | Apple 芯片（arm64）、Intel（x64） | `nuonuo-<版本>-mac-<arm64\|x64>.dmg`（或 `.zip`） | 桌面应用，网页访问可在设置里开启 |
| Windows | x64、arm64 | `nuonuo-<版本>-win-<x64\|arm64>-setup.exe`（或免安装 `.zip`） | 桌面应用，网页访问可在设置里开启 |

**Linux 一键安装**（x64 和 arm64 自动识别，不需要登录 GitHub）：

```sh
curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash
```

装到 `~/.local/share/nuonuo`，命令链接到 `~/.local/bin/nuonuo`；重复运行即升级，数据目录 `~/.nuonuo` 不受影响。指定版本：`NUONUO_VERSION=v0.2.0`（放在 `bash` 前面）。

**Linux 后台运行、地址和端口**：

```bash
nuonuo start -d                                # 后台启动，打印登录链接（http://127.0.0.1:7420/auth?token=…）
nuonuo start -d --host 0.0.0.0 --port 8080     # 监听所有网卡的 8080 端口，局域网里的设备也能打开
nuonuo config --host 0.0.0.0 --port 8080       # 保存为默认值（写入 ~/.nuonuo/config.json），以后每次启动都用
nuonuo status | stop | restart                 # 查看 / 停止 / 用保存的设置重启
nuonuo service install                         # 开机自启（systemd 用户服务，同样读取保存的地址和端口）
```

地址和端口的优先级：命令行参数 `--host/--port` > 环境变量 `NUONUO_HOST/NUONUO_PORT`（也可以写进 `~/.nuonuo/env`）> `config.json` > 默认 `127.0.0.1:7420`。网页的「设置 → 系统 → 监听地址」也能改，改完点「重启服务」生效。监听非本机地址时登录链接就是密码，而且是明文 HTTP：只在可信的局域网里这样用，远程访问请放在 HTTPS 反向代理后面，或用 `ssh -L 7420:127.0.0.1:7420 <服务器>`。

**macOS / Windows 桌面端**：下载对应的安装包安装即可。应用自带服务，关掉窗口后留在托盘里继续工作。默认只有应用窗口能用；想在浏览器（或手机等局域网设备）里打开，到「设置 → 系统 → 网页访问」勾选「允许在浏览器里打开」，选「仅本机」或「局域网」并设置端口，点「重启服务」，再复制登录链接。

- macOS 可以不下载 dmg，直接在终端运行 `curl -fsSL https://raw.githubusercontent.com/cyDione/nuonuo/main/install.sh | bash`：它下载对应芯片的 zip，装进 `/Applications`（没有写权限时装进 `~/Applications`），再运行一次就是更新（先退出应用）。curl 下载的文件没有「来自互联网」的隔离标记，所以没有开发者签名时也能直接打开。
- 发布流程配好 Apple 开发者证书（见下面「macOS 签名和公证」）之前，macOS 包只有 ad-hoc 签名。浏览器下载的 dmg 第一次打开会提示「无法验证开发者」或「已损坏」。打开 dmg 之前先运行 `xattr -cr /路径/nuonuo-<版本>-mac-<芯片>.dmg` 清掉隔离标记，从里面拖出来的应用就不会被拦；已经装好的，运行 `xattr -dr com.apple.quarantine /Applications/Nuonuo.app`，或到「系统设置 → 隐私与安全性」点「仍要打开」。
- Windows 包没有代码签名，SmartScreen 提示时点「更多信息 → 仍要运行」。
- 桌面端有新版本时，「设置 → 系统 → 版本更新」会提示并给出下载链接，下载新安装包覆盖安装即可。

### 从源码部署

**1. 准备**：Node.js ≥ 22.12、pnpm、git。可选：`gh`（GitHub）、Docker（沙箱）、Chrome/Chromium（浏览器工具）。

```bash
git clone https://github.com/cyDione/nuonuo.git ~/nuonuo
cd ~/nuonuo
pnpm install
pnpm build
```

**2. 填 API key**（二选一）：
- 启动后在网页的「设置 → 模型供应商」里填写，key 存进系统钥匙串（macOS 上存进数据目录里的加密文件，免得钥匙串每次启动都要密码）；
- 或写进数据目录的 `env` 文件。开机自启的服务读不到 shell 里的 `export`，用这个文件最稳：

```bash
mkdir -p ~/.nuonuo
printf 'OPENAI_API_KEY=sk-...\n' > ~/.nuonuo/env   # 每行 KEY=value；换成你用的供应商，也可放 *_BASE_URL、GITHUB_TOKEN 等
chmod 600 ~/.nuonuo/env
```

各层用哪个模型在「设置 → 分层模型」里选，下拉框是供应商实时返回的模型列表（有发布时间的按新到旧排）。首次启动、还没配置过任何层时，糯糯会从 `env` 里第一个供应商的实时列表里自动选一个通用对话模型（跳过 realtime、语音、mini 之类的变体和预览版）；想指定，在 `env` 里加一行 `NUONUO_MODEL=<模型 id>`。两者都只在还没配置过任何层时生效。

**3. 启动，检查**：

```bash
node apps/daemon/dist/cli.mjs doctor          # 检查环境
node apps/daemon/dist/cli.mjs start           # 打印并打开登录链接（http://127.0.0.1:7420/auth?token=…）
```

可以加个别名：`alias nuonuo="node ~/nuonuo/apps/daemon/dist/cli.mjs"`。登录链接丢了，用 `nuonuo token` 重新打印。

**4. 开机自启**（macOS 用 launchd，Linux 用 systemd 用户服务）：

```bash
nuonuo service install        # 写入并启动；nuonuo service uninstall 移除
loginctl enable-linger $USER      # 仅 Linux：没登录桌面时也保持运行
```

**5. 可选**：
- **自己打包**：Linux 无桌面包 `pnpm build && bash scripts/package-linux.sh`（打的是本机 CPU 的包）；桌面端 `pnpm build`，再在 `apps/desktop` 里运行 `pnpm dist:mac` / `pnpm dist:win`（同样只能打本机系统和 CPU 的包）。GitHub Actions 的 “Release” 工作流在 6 台对应的机器上打全部的包；推送 `v*` 标签时自动发布 Release。发版前先用 `pnpm set-version 0.2.0` 把所有包改成同一个版本号并提交，再打 `v0.2.0` 标签；标签和版本号不一致时，工作流会报错并且不发布。也可以不打标签：在 Actions → Release → Run workflow 里填版本号（和可选的发布说明）手动运行，6 个包都打成功后，工作流自己创建 `v0.2.0` 标签和 Release；这个版本已经有标签或 Release 时，它直接报错，不会重复发布。已经发布的版本打包中途停了，就勾上 rebuild 再运行一次，它会按原来的标签重新打包，并把包传到原来的 Release 上。
- **macOS 签名和公证**：Release 工作流发版时，如果仓库配了下面这些 Actions secrets（仓库 Settings → Secrets and variables → Actions → New repository secret），就用 Developer ID 证书签名、开启 hardened runtime，并交给 Apple 公证，用户下载 dmg 后可以直接打开。没配时照旧 ad-hoc 签名，工作流只给一个警告；只配了证书、没配公证方式时，工作流报错停下（签了名但没公证，照样会被拦）。拉取请求和只打包不发布的运行都不签名。
  - `MAC_CERT_P12_BASE64`：「Developer ID Application」证书连同私钥导出的 .p12，转成 base64（`base64 -i cert.p12 | pbcopy`）；`MAC_CERT_PASSWORD`：导出 .p12 时设的密码。
  - 公证用 App Store Connect API 密钥（推荐）：`APPLE_API_KEY_P8`（下载的 `AuthKey_XXXX.p8` 文件的全部内容）、`APPLE_API_KEY_ID`（密钥 ID）、`APPLE_API_ISSUER`（Issuer ID）。
  - 或者用 Apple ID：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`（在 account.apple.com 生成的 App 专用密码）、`APPLE_TEAM_ID`。
- **在外面用**：启用 Telegram 插件，用手机指挥家里的电脑，不需要开放端口。或者用 SSH 端口转发 `ssh -L 7420:127.0.0.1:7420 你的电脑`，再在本地打开登录链接；在同一个局域网里，也可以让服务监听局域网地址（见上面的「地址和端口」）。
- **GitHub**：在「设置 → 来源 → GitHub」点「授权 GitHub」，页面会给出一个验证码，在 github.com/login/device 输入并同意即可（设备码授权，不需要回调地址，通过 SSH 端口转发访问也能用）；再填写要监听的仓库。授权后智能体的 `gh` 和 git 也用这个授权。没有授权时仍会退回到 `env` 里的 `GITHUB_TOKEN` 或本机 `gh auth login`。
- **Gmail**：启用 Gmail 插件，在「设置 → 来源 → Gmail」点「授权 Gmail」，用 Google 账号登录并同意，浏览器会跳回本机服务（经 `ssh -L` 转发也可以）。随时可以点「断开授权」，会同时在 Google 那边撤销。
- 两个授权用到的 OAuth 应用怎么建，见 [10-oauth.md](10-oauth.md)。

**升级**：

用安装包（`install.sh`）装的：服务每天检查两次有没有新的 Release，有的话侧栏「设置」旁会显示「有更新」，在「设置 → 系统 → 版本更新」点「立即更新」即可，装完服务自动重启。命令行也可以：

```bash
nuonuo update --check   # 只检查
nuonuo update           # 下载并安装最新版本；systemd 服务会自动重启
```

仓库是公开的，检查和下载不需要登录 GitHub（`env` 里有 `GITHUB_TOKEN` 时会带上，只为提高 API 频率上限）。不想后台检查，在 `env` 里写 `NUONUO_UPDATE_CHECK=0`。

安装插件和插件的 npm 依赖时，默认从 npm 官方源下载。国内网络慢的话，在 `env` 里写 `NUONUO_NPM_REGISTRY=https://registry.npmmirror.com`；也会沿用 npm 自己的 `npm_config_registry`。

v0.1.0 还没有自动更新功能：从 v0.1.0 升级，需要手动再运行一次上面的 `install.sh` 安装命令，之后的版本就可以用「立即更新」或 `nuonuo update` 了。

从源码运行的：

```bash
cd ~/nuonuo && git pull && pnpm install && pnpm build
```

升级后重启服务：`nuonuo service install`，或者停掉再 `start`。数据目录 `~/.nuonuo/` 不受影响，数据库会自动迁移。

**从 super-assistant 升级**：v0.2.4 及以前项目叫 super-assistant。新版本会自己完成迁移，一般什么都不用做：

- 旧版的自动更新照常工作（GitHub 会把旧仓库地址跳到 cyDione/nuonuo，发版时还会附带一份旧文件名的安装包）。
- 第一次启动新版时，`~/.super-assistant` 会搬到 `~/.nuonuo`，旧路径留一个指向新目录的链接。钥匙串里的密钥、桌面端的设置第一次读取时迁过去。
- `SUPER_ASSISTANT_*` 环境变量（shell、`env` 文件、旧的服务配置里）继续有效，等同于对应的 `NUONUO_*`；建议有空时把 `env` 里的改成新名字：`sed -i.bak 's/^\(export \)\{0,1\}SUPER_ASSISTANT_/\1NUONUO_/' ~/.nuonuo/env`。
- Linux：install.sh 把命令换成 `nuonuo`（旧的 `super-assistant` 命令删除），`~/.local/share/super-assistant` 换成指向 `~/.local/share/nuonuo` 的链接，`super-assistant.service` 换成 `nuonuo.service`。
- macOS：App 改叫 Nuonuo.app，下次更新时会替换掉旧的 Super-assistant.app。系统会再问一次通知权限。
- Windows：原地升级。从 v0.2.4 升上来的那一次，更新完不会自动重新打开，从开始菜单打开 Nuonuo 即可。
- 第三方插件 `package.json` 里的 `"super-assistant"` 字段继续识别，新插件请用 `"nuonuo"`。Gmail 派活标签的默认值变成 `nuonuo`，邮箱里只有旧的 `super-assistant` 标签时继续用它。

从源码运行的：`git remote set-url origin https://github.com/cyDione/nuonuo.git`，然后照常 `git pull && pnpm install && pnpm build`，再 `nuonuo service install`（会替换掉旧的 launchd / systemd 服务）。

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
| `nuonuo start [-d] [-H 地址] [-p 端口] [--no-open]` | 启动服务；`-d` 在后台运行（日志在 `~/.nuonuo/logs/daemon.log`），`-H 0.0.0.0` 让局域网可访问 |
| `nuonuo stop` / `restart` | 停止 / 重启服务（`restart` 在后台启动，用保存的地址和端口） |
| `nuonuo config [-H 地址] [-p 端口]` | 查看或保存监听地址和端口（下次启动生效） |
| `nuonuo status` | 查看是否在运行、监听地址，以及后台队列是否健康 |
| `nuonuo doctor` | 检查运行环境（Node、钥匙串、模型配置、git/gh/Docker） |
| `nuonuo token [--rotate]` | 打印登录链接；加 `--rotate` 时轮换访问令牌 |
| `nuonuo update [--check]` | 检查并安装新版本（Linux 安装包） |
| `nuonuo service install / uninstall` | 开机自启（macOS 用 launchd，Linux 用 systemd 用户服务） |

在仓库内开发时，可以用 `node apps/daemon/dist/cli.mjs <命令>` 代替 `nuonuo`。

## 开发

```bash
pnpm dev     # daemon（tsx watch，数据目录为 ./.nuonuo-dev）+ Vite（http://localhost:5173）
pnpm check   # 类型检查 + 测试 + 构建
```

开发模式下，daemon 会打印指向 `localhost:5173` 的登录链接；Vite 会把 `/api` 和 `/auth` 代理到 daemon。

## 数据与安全

- **数据目录**：默认是 `~/.nuonuo/`，可用 `NUONUO_HOME` 修改。里面包括：`state.db`（SQLite）、`token`（访问令牌，权限 0600）、`work/`、`memory/`、`logs/`。
- **API key 存放位置**：不进数据库、不进日志，也不会进入模型上下文。macOS 上默认存在加密文件里（免得每次启动都弹钥匙串密码）；Linux / Windows 优先用系统钥匙串（Secret Service / 凭据管理器），钥匙串不可用时（例如无桌面的 Linux）自动改用 `secrets/secrets.enc`（AES-256-GCM，密钥 `master.key` 的权限为 0600）。`NUONUO_SECRETS=file|keychain` 可以强制指定其中一种。
- **网络访问控制**：默认只监听 `127.0.0.1`（可以改成局域网地址，见上面「地址和端口」）。所有 API 都需要访问令牌（HttpOnly + SameSite=Strict 的 cookie，或 Bearer 头），并校验 `Host` 与 `Origin`，防止 DNS rebinding 和其他网页伪造请求。
