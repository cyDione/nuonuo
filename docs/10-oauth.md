# GitHub 与 Gmail 的授权接入

GitHub 和 Gmail 都用 OAuth 授权接入：在设置页点一下，用自己的账号登录并同意，令牌存进系统钥匙串（没有钥匙串时存进数据目录里加密的 `secrets/`），不写进数据库，也不进模型上下文。

服务只监听 127.0.0.1，常见用法是在远程 Linux 上跑、用 `ssh -L 7420:127.0.0.1:7420` 访问，所以两种授权都选了不需要公网回调地址的方式：

| | 方式 | 为什么能在远程机器上用 |
|---|---|---|
| GitHub | OAuth 设备码（Device Flow） | 不需要回调；页面给出验证码，你在任意浏览器的 github.com/login/device 输入即可 |
| Gmail | 已安装应用的 OAuth（loopback 回调 + PKCE） | 回调地址是你浏览器里打开的 `http://localhost:7420/...`，浏览器经 SSH 转发回到服务 |

## 用到的 OAuth 应用

代码里有内置客户端的位置（`DEFAULT_GITHUB_CLIENT_ID`、`DEFAULT_GOOGLE_CLIENT_ID` / `DEFAULT_GOOGLE_CLIENT_SECRET`）。内置值为空时，设置页会直接显示 Client ID 字段；有内置值时这些字段收进「高级」，留空即用内置的。

### GitHub OAuth App

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。
2. Homepage URL 随便填（例如仓库地址），Authorization callback URL 填 `http://127.0.0.1:7420`（设备码流程用不到它，但表单要求必填）。
3. 创建后勾选 **Enable Device Flow** 并保存。
4. 把 Client ID（`Ov23…`）填进「设置 → 来源 → GitHub → OAuth App Client ID」。设备码流程不需要 Client Secret。

申请的权限是 `repo read:org workflow`，和 `gh auth login` 默认的一样，这样派给智能体的任务能用同一个令牌跑 `gh` 和 `git push`。断开授权只删除本机令牌；要在 GitHub 那边也撤销，去 Settings → Applications → Authorized OAuth Apps。

### Google OAuth 客户端（Gmail）

1. Google Cloud 控制台新建项目，启用 **Gmail API**。
2. 「OAuth 同意屏幕」：用户类型选「外部」，加上 `https://www.googleapis.com/auth/gmail.modify` 范围。
   - **发布状态改成「正式版」**。停在「测试」状态时，Google 签发的 refresh token 7 天就过期，Gmail 每周都要重新授权。未经验证的正式版应用在授权时会显示「Google 未验证此应用」，点「高级 → 继续」即可；个人用不需要送审。
3. 「凭据 → 创建凭据 → OAuth 客户端 ID」，应用类型选 **桌面应用**。桌面应用类型允许任意 `http://localhost:<端口>` / `http://127.0.0.1:<端口>` 回调，所以不用登记回调地址。
4. 把 Client ID 和 Client Secret 填进「设置 → 来源 → Gmail」。按 Google 对已安装应用的说明，桌面客户端的 secret 不算机密（每份安装都带着它）；授权码由 PKCE 和本机回调保护。

断开授权时会调用 Google 的 revoke 接口，授权会从你账号的「第三方访问」列表里消失。

## 设置页的协议

来源可以声明 `authorized(ctx)` 和带 `show: 'authorized' | 'unauthorized'` 的 `actions`。设置页为这类来源单独显示「账号授权」卡片：动作返回 `{ url }` 时跳到授权页（Gmail），返回 `{ device }` 时显示验证码并轮询 `device.poll` 直到 `{ status: 'done' | 'error' }`（GitHub）。第三方插件也可以用同一套接口接入自己的 OAuth。
