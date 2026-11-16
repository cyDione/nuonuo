# 云电脑

云电脑是糯糯自己的一台 Linux 机器，放在云上。插件把某一家供应商的机器接进来以后，Worker 就能在上面上网、装软件、跑 docker，在 `1280×800` 的图形桌面上同时开好几个有头 GUI 浏览器并操作桌面程序。这台机器默认就是 Worker 的执行环境，你自己电脑上的文件碰不到。

[Instabox](https://instabox.sh) 是第一家接入的供应商，插件在 [`plugins/instabox`](../plugins/instabox)。接别的供应商也是写一个插件，在里面声明一台云电脑，和[聊天渠道](12-channels.md)是一个思路：共用的部分写一次，每家只写一个小适配器。

## 用起来

1. 在「设置 → 插件 → 安装插件」里填 `cyDione/nuonuo/tree/main/plugins/instabox`。
2. 打开它，点「打开」进到设置，填上 Instabox 的 API key（[dashboard.instabox.sh](https://dashboard.instabox.sh) → API keys，以 `ibk_` 开头）。账户里有好几台机器时，可以填要用哪一台（ID 或名字），不填就用第一台。
3. 完成。之后 Worker 的 `shell` 就在云电脑上跑。想让命令还在本机跑，到「设置 → 安全和执行 → 执行环境」改成「本机」。

日常使用时，右侧栏的「浏览器」会实时列出云电脑和本机当前开着的页面，点进去就能看画面；遇到登录、二次验证、验证码或付款确认时，直接点「接管」即可在网页或完整云桌面上亲自操作，完成后点「交还」唤醒正在等待的 Worker 继续往下跑。「设置 → 安全和执行 → 执行环境」里也能查看机器在线/休眠/冷却状态、叫醒机器和管理常驻浏览器。设计稿在 Figma 第 32 与第 34 节。

## 共用层替每家供应商做的事

共用层在 [`packages/sources/src/computer.ts`](../packages/sources/src/computer.ts)：

| 事 | 做法 |
|---|---|
| 唤醒和探测 | 用之前先看机器在不在线。在休眠就唤醒（被手动暂停的恢复，关机的开机），再跑一条命令确认它在回应。确认过的机器 1 分钟内不再探测 |
| 保持清醒 | 任务在用机器时续一份 15 分钟的租约，供应商在这段时间里不会让它休眠；任务用完就不再续，机器照常自己休眠 |
| 糯糯自己的空间 | 能 sudo 的机器上，糯糯会建一个 `nuonuo` 账户：家目录是 `<dataDir>/nuonuo`（在持久盘上），加进 docker 组，但不能 sudo。你自己的账户和文件不受影响。不能 sudo 的机器上，糯糯只用 `<dataDir>/nuonuo` 这一个文件夹 |
| 图形桌面与显示权限 | 供应商声明 `capabilities.desktop` 时，共用层会在首次命令前自动拉起 X11 图形桌面（必要时自动安装），并通过 `xhost +SI:localuser:nuonuo` 与 `.Xauthority` 把显示权限授给 `nuonuo` 账户 |
| 任务文件夹 | 每个任务在 `~/tasks/<任务 id>` 里做事，命令默认就从这里开始 |
| 命令 | 每条命令都作为一个后台任务启动，等一会儿（至少 20 秒）还没跑完就转到后台，跑完后结果作为新消息送达。有总时长上限，`job_stop` 会停掉它和它启动的所有进程 |
| 审核 | 和本机命令走同一套审核：发出去的、高风险的、花钱的照样先问你。批准后的命令在云电脑上运行。不检查本机文件夹的规则，因为云电脑碰不到你的文件夹 |
| 文件 | `computer_upload` / `computer_download` 在本机的任务目录和云电脑之间分块传文件，一次最多 100 MB |
| 有头浏览器与接管互斥 | `browserd.mjs` 在有图形桌面时默认以有头 GUI 模式（`1280×800`）启动多个独立 Chromium 配置（若 X11 暂不可用自动回退无头），每个配置各自保存登录状态并支持命名标签页；只监听 `127.0.0.1` 且带令牌校验。主人接管某个标签页期间，Worker 对该标签页的操作会被互斥拦截，直到主人点「交还」。20 分钟空闲的配置会自动关闭释放内存，登录态留在磁盘上 |
| 更新 | 上面这些文件有版本号，糯糯更新以后会在下次用的时候重新装一遍 |

### 给 Worker 的工具

| 执行环境是云电脑时（默认） | 执行环境是本机时 | 作用 |
|---|---|---|
| `shell` / `job_status` / `job_stop` | `computer_shell` / `computer_job_status` / `computer_job_stop` | 在云电脑上跑命令 |
| `local_shell` / `local_job_status` / `local_job_stop` | `shell` / `job_status` / `job_stop` | 在你的电脑上跑命令 |
| `computer_upload` / `computer_download` | 同左 | 在两边之间传文件 |
| `computer_browser_open` / `_snapshot` / `_click` / `_type` / `_press` / `_scroll` / `_back` / `_eval` / `_screenshot` / `_tabs` / `_close` | 同左 | 云电脑上的浏览器。`browser` 选用哪个配置（默认 `main`），`tab` 选标签页（默认是这个任务自己的） |
| `computer_desktop_screenshot` / `_click` / `_move` / `_drag` / `_scroll` / `_type` / `_press` | 同左 | 机器带图形桌面时开放：截取完整 `1280×800` 桌面画面并用 `xdotool` 点击、拖拽、滚动、输入和按键（处理原生文件选择器、弹窗、Canvas 或桌面应用） |
| `computer_status` | 同左 | 看机器在不在线，顺便唤醒 |

`read_file`、`write_file` 这些文件工具还是作用在本机的任务目录上，最后交付的文件要放在那里。需要登录或验证时，Worker 可以直接在云电脑浏览器里停下请你到右侧栏「浏览器」接管；`browser_*` 则是你本机上的浏览器，只在必须用本机环境时才用。

## 写一个供应商插件

```js
export default ({ definePlugin, defineComputer }) => definePlugin({
  id: 'mybox',
  computers: [defineComputer({
    id: 'mybox',
    title: 'MyBox 云电脑',
    capabilities: {
      sudo: true,          // 登录用户能 sudo -n：糯糯会建自己的账户
      docker: true,
      sleeps: true,        // 机器会自己休眠
      dataDir: '/data',    // 持久盘上的一个文件夹；糯糯的空间在 /data/nuonuo
      maxExecSeconds: 600, // 一次 exec 最长多久
      desktop: { display: ':1', width: 1280, height: 800 }, // 可选：提供 X11 图形桌面
      env: { DISPLAY: ':1', NUONUO_BROWSER_HEADED: '1' },   // 每条命令都会带上的环境变量
    },
    async status(ctx) { /* 不唤醒，只看状态 */ return { state: 'asleep' } },
    async wake(ctx) { /* 唤醒或开机，等到能用为止 */ return { state: 'ready' } },
    async exec(ctx, { command, stdin, timeoutSeconds }) { return { exitCode: 0, stdout: '', stderr: '' } },
    async keepAwake(ctx, { key, seconds }) { /* 可选：让机器在这段时间里别休眠 */ },
    async startDesktop(ctx) { /* 可选：确保图形桌面已安装并运行 */ },
    async desktopUrl(ctx, { viewOnly } = {}) { /* 可选：返回可嵌入 iframe 的桌面流链接 */ return { url: 'https://...' } },
    async desktopControl(ctx, action) { /* 可选：主人接管 'takeover' / 交还 'handback' 通知 */ },
  })],
})
```

- `ctx` 就是插件的上下文。API key 这类东西放进 package.json 的 `nuonuo.settings`（`type: 'secret'`），用 `ctx.settings.get('apiKey')` 读。
- `state` 可以是 `ready`、`asleep`、`waking`、`off`、`unconfigured`（还没填 key 之类）、`error`；`detail` 是给你看的一句话；暂时不能唤醒（比如在冷却）时填 `retryAfterSeconds`。
- `exec` 以机器的登录用户身份运行一行 bash，命令非零退出不算出错。机器不在线时抛出带 `409` 或 `not running` 的错误，共用层会重新唤醒，再试一次。
- 插件跑在沙箱里，只能联网，不能启动程序。所以 `exec`、`startDesktop`、`desktopUrl` 等都通过供应商的 HTTP 接口实现并经沙箱 IPC 转发，Instabox 插件就是这样写的。

## 接口

| 接口 | 作用 |
|---|---|
| `GET /api/computers` | 已连接的云电脑和它们的状态，以及当前的执行环境 |
| `POST /api/computers/:id/wake` | 唤醒、探测，必要时准备好糯糯的空间与图形桌面 |
| `POST /api/computers/:id/desktop` | 拉起图形桌面并返回桌面流链接（`{ ok, url, expiresAt? }`，支持 `viewOnly`） |
| `GET /api/computers/:id/desktop/screenshot` | 截取云电脑完整图形桌面 PNG 画面 |
| `GET /api/computers/:id/browsers` | 云电脑上开着的浏览器和标签页（机器在休眠时不唤醒，直接返回空列表） |
| `POST /api/computers/:id/browsers/:name/close` | 关掉一个浏览器，登录状态会留着 |
| `GET /api/browsers` | 右侧栏「浏览器」统一视图：云电脑状态及当前所有云端与本机打开的页面 |
| `POST /api/browsers/open` / `close` | 在当前默认环境（云端或本机）新开网页或关闭指定页面 |
| `GET /api/browsers/screenshot` | 获取指定云端或本机标签页的最新截图 |
| `POST /api/browsers/handoff` / `input` / `return` | 接管页面（含云端互斥锁）、发送网页或桌面级键鼠操作、交还页面并自动唤醒等待中的任务 |

## 实机测试

```bash
NUONUO_LIVE_INSTABOX=1 INSTABOX_API_KEY=ibk_... npx vitest run packages/sources/src/computer-instabox.live.test.ts
```

这个测试会唤醒机器，确认 `nuonuo` 账户能用 docker、不能 sudo、写不进你的家目录，然后开两个浏览器、截一张图。
