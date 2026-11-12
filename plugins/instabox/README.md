# Instabox 云电脑

这个插件把 [Instabox](https://instabox.sh) 上的一台云端 Linux 机器接成糯糯自己的云电脑。接好以后，Worker 默认在这台机器上跑命令，可以上网、用 docker，还能同时开好几个浏览器。

- 安装：在「设置 → 插件 → 安装插件」里填 `cyDione/nuonuo/tree/main/plugins/instabox`，然后打开它。
- 设置：填上 API key（在 dashboard.instabox.sh 的 API keys 里新建，以 `ibk_` 开头，需要 `machines:read` 和 `machines:write` 权限）。账户里有好几台机器时，可以填要用哪一台，不填就用第一台。
- 机器空闲时会自动休眠。糯糯用之前会先叫醒它：被你手动暂停的会恢复，关机的会开机，所以隔了一阵后第一条命令会慢几秒。在冷却中的机器要等冷却结束才能用。
- 糯糯在机器上有自己的 `nuonuo` 账户，家目录是 `/data/nuonuo`。它能用 docker，但不能 sudo，也写不进你的 `/data/home`。它开的浏览器都是无头的，不会出现在你的桌面上。

插件只负责连到 Instabox：查状态、唤醒、跑一条命令、续租约。糯糯那边的空间、shell、文件互传和浏览器都由共用层负责，见 [云电脑](../../docs/13-computers.md)。
