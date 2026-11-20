# Nuonuo 统一公开协议 v1（Protocol 2.0）

糯糯采用**服务端与客户端彻底解绑**的 Client-Server 架构。官方桌面端、可选 WebUI、手机 App、手表、音箱、CLI 以及任意第三方客户端全部共用同一套 `/v1/*` 公开接口，区别仅在于认证时获得的权限作用域（`scopes`）。

- **协议前缀**：`<server>/v1`（所有响应带 `x-nuonuo-protocol: 2.0`）
- **传输方式**：HTTPS / Localhost HTTP + JSON；实时推送采用 Bearer 认证的 `fetch` SSE（`GET /v1/events`）
- **服务端模式**：默认纯 Headless API（不提供网页）；需要服务端托管 WebUI 时使用 `nuonuo start --web`（或 `NUONUO_WEB=1`）
- **官方 SDK**：[`@nuonuo/client`](../packages/client)（零外部依赖 TypeScript SDK）

---

## 1. 认证与安全模型

所有客户端认证后统一获得一对凭证：
- **`accessToken`（`nna_…`）**：HMAC-SHA256 签名，**15 分钟短效**，仅驻留内存，通过 `Authorization: Bearer <accessToken>` 携带。
- **`refreshToken`（`nnr_…`）**：**30 天有效、严格单次轮换**，服务端仅存 `sha256` 哈希。每次调用 `POST /v1/auth/refresh` 会立即作废旧 Refresh Token 并签发新一对令牌；**一旦检测到已失效的旧 Refresh Token 被重放，服务端立即吊销整条令牌家族并写入安全审计日志**。

### 三种认证方式

| 方式 | 适用场景 | 端点 |
|---|---|---|
| **一次性配对码 / 二维码** | 任意网络与设备（桌面/手机/音箱/第三方客户端） | 服务端运行 `nuonuo pair [--admin] [--qr]` 生成 10 分钟一次性配对码与 `nuonuo://pair?server=...&code=...` → 客户端调用 `POST /v1/auth/pair/exchange` |
| **Owner 密码** | 浏览器 / 远程桌面快速登录 | 服务端运行 `nuonuo auth set-password <密码>`（`scrypt` 哈希 + 限速） → 客户端调用 `POST /v1/auth/password/login` |
| **WebAuthn Passkey** | `https://` 域名或 `localhost` 浏览器无密码登录 | 注册：`POST /v1/auth/passkey/register/options` & `/verify`（需 `admin`）；登录：`POST /v1/auth/passkey/login/options` & `/verify` |

### 权限作用域（RBAC Scopes，默认最小权限拒绝）

| Scope | 能力范围 |
|---|---|
| `chat` | 对话、消息收发与幂等重发、附件上传下载、语音听写/朗读、客户端外观偏好 |
| `notices` | 接收实时通知事件 |
| `approvals` | 查看并审批高危动作确认卡（非 `admin` 仅限单次/本任务） |
| `tasks:read` | 查看任务与步骤、产物、动态、目标、点子、记忆、灵魂、只读截图 |
| `tasks:write` | 启停/重试任务、编辑目标/记忆/灵魂/技能/心境 |
| `admin` | 完整管理权限（模型供应商、分层模型、权限与沙箱、插件/来源、设备/会话/密码/Passkey 管理、系统配置） |

---

## 2. 核心认证接口

| 接口 | 认证要求 | 说明 |
|---|---|---|
| `GET /v1/auth/methods` | 公开 | 探测服务端版本、`webUi` 状态与已开启的认证方式 |
| `POST /v1/auth/pair/exchange` | 公开（10 次防爆破熔断） | `{ code, device, cookie? }` → `201 AuthTokenBundle` |
| `POST /v1/auth/password/login` | 公开（按 IP 限速） | `{ password, device, cookie? }` → `200 AuthTokenBundle` |
| `POST /v1/auth/passkey/login/options` & `/verify` | 公开（仅 HTTPS / localhost） | WebAuthn Passkey 登录 → `200 AuthTokenBundle` |
| `POST /v1/auth/refresh` | Refresh Token（Body 或 Cookie） | 单次轮换刷新，检测重放自动吊销家族 |
| `POST /v1/auth/logout` | 已登录 | 吊销当前会话并清除 Cookie |
| `POST /v1/auth/resource-ticket` | 已登录 | `{ path }` → 签发 30 秒单路径临时票据（用于受保护的 `<iframe>` 或下载，严禁 URL 放长期令牌） |
| `POST /v1/auth/pair/codes` | `admin` | 生成一次性配对码、`nuonuo://pair?...` 与二维码 SVG |
| `POST/DELETE /v1/auth/password` | `admin` | 设置/清除 Owner 密码 |
| `GET/DELETE /v1/auth/passkeys` | `admin` | 查看/移除已绑定 Passkey |
| `GET/PATCH/DELETE /v1/devices` | `admin` | 管理与吊销已连接设备 |
| `GET/DELETE /v1/sessions` | `admin` | 查看与强制踢下线活跃会话 |
| `GET /v1/auth/audit` | `admin` | 查询认证与安全审计日志 |

---

## 3. 业务与实时事件接口

| 接口 | Scope | 说明 |
|---|---|---|
| `GET /v1/hello` | 任意已认证 | 握手：返回协议版本、助理身份、设备与可用特性列表 |
| `GET /v1/health` | 任意已认证 | 存活检查（`admin` 额外返回进程与队列健康状态） |
| `GET /v1/events` | 任意已认证 | 按 Scope 过滤的实时 SSE 事件流（支持 `?conversation=main|<id>`，会话吊销自动断开） |
| `GET/POST /v1/conversations` | `chat` | 列出或新建对话 |
| `GET/POST /v1/conversations/:id/messages` | `chat` | `:id` 支持 `main`；支持 `?after=`、`?limit=`、`clientId` 幂等键、`text`/`content` |
| `POST/GET/DELETE /v1/uploads` | `chat` | 上传、下载（支持临时资源票据）、丢弃未发送附件 |
| `POST /v1/speech` & `/v1/transcribe` | `chat` | TTS 朗读与 STT 听写 |
| `GET/POST /v1/approvals` | `approvals` | 查看与审批高危操作 |
| `GET/POST /v1/tickets/*`, `/v1/artifacts/*`, `/v1/goals/*`, `/v1/feed/*`, `/v1/ideas/*`, `/v1/memories/*` | `tasks:read` / `tasks:write` | 任务步进详情、产物、长期目标、动态、点子与记忆 |
| `/v1/providers/*`, `/v1/roles/*`, `/v1/settings/*`, `/v1/plugins/*`, `/v1/sources/*`, `/v1/system/*` | `admin` | 系统、模型、安全权限与插件管理 |
