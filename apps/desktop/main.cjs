// Nuonuo desktop: the web UI in a window, plus what only a desktop app can do —
// a tray icon showing what needs you, native notifications, a global shortcut, and starting at login.
const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, nativeImage, nativeTheme, screen, shell, ipcMain, session } = require('electron')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { ensureDaemon, stopDaemon, readLock, home } = require('./lib/daemon.cjs')
const { startInstall } = require('./lib/update.cjs')

const SHORTCUT = 'CommandOrControl+Shift+Space'
let win, quick, tray, daemon
let attention = 0
let badgeOn = true
let quitting = false

// What the owner set in 设置 (通用 · 快捷键): kept next to the app's own data, applied at once.
const DEFAULT_PREFS = { tray: true, close: 'hide', summon: process.platform === 'darwin' ? 'Alt+Space' : '', quick: SHORTCUT }
let prefs = { ...DEFAULT_PREFS }
let registered = {}
const prefsFile = () => path.join(app.getPath('userData'), 'desktop-prefs.json')
// The app's own folder was named Super-assistant before the rename; its settings are read from there once.
const legacyPrefsFile = () => path.join(app.getPath('appData'), 'Super-assistant', 'desktop-prefs.json')
function loadPrefs() {
  for (const file of [prefsFile(), legacyPrefsFile()]) {
    try { prefs = { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(file, 'utf8')) }; return } catch { /* first run */ }
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => show())

const base = () => `http://${daemon.host}:${daemon.port}`
const api = async (path, init = {}) => {
  const res = await fetch(`${base()}${path}`, { ...init, headers: { authorization: `Bearer ${daemon.token}`, ...(init.headers || {}) } })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

function show(hash) {
  if (!win) createWindow()
  if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {})
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const asset = name => path.join(__dirname, 'assets', name)
const mac = process.platform === 'darwin'
// The window is the page: on macOS the title bar is drawn by the web UI (traffic lights sit in the sidebar), and the
// background matches the sidebar so nothing flashes while it loads (Figma "v4 · 桌面端").
const windowColor = () => (nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff')

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520, title: 'Nuonuo', show: false, backgroundColor: windowColor(),
    icon: nativeImage.createFromPath(asset('icon-256.png')),
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  win.loadURL(`${base()}/auth?token=${daemon.token}`)
  // The page dims its title bar when the window is in the background, and moves things aside in full screen.
  const tell = (event, value) => { if (!win.isDestroyed()) win.webContents.send(`sa:${event}`, value) }
  win.on('focus', () => tell('focus', true))
  win.on('blur', () => tell('focus', false))
  win.on('enter-full-screen', () => tell('fullscreen', true))
  win.on('leave-full-screen', () => tell('fullscreen', false))
  win.webContents.on('did-finish-load', () => { tell('focus', win.isFocused()); tell('fullscreen', win.isFullScreen()) })
  win.once('ready-to-show', () => { if (!process.env.NUONUO_DESKTOP_HIDDEN) win.show() })
  // Links to other sites open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(base())) { event.preventDefault(); shell.openExternal(url) } })
  // Closing the window hides it (the agent keeps working in the background), or quits the app when the owner chose that;
  // the background service keeps running either way.
  win.on('close', event => {
    if (quitting) return
    if (prefs.close === 'quit') { quitting = true; app.quit(); return }
    event.preventDefault(); win.hide()
  })
}

/** Quick ask (⌘⇧Space): a small floating box over whatever you are doing; it tucks away when you click elsewhere. */
function createQuick() {
  quick = new BrowserWindow({
    width: 640, height: 420, show: false, frame: false, transparent: true, resizable: false, movable: true, alwaysOnTop: true,
    skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false, hasShadow: false, backgroundColor: '#00000000',
    ...(mac ? { type: 'panel', visibleOnAllWorkspaces: true } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  quick.loadURL(`${base()}/#/quick`)
  quick.on('blur', () => { if (!process.env.NUONUO_DESKTOP_SMOKE) quick.hide() })
  quick.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  quick.on('closed', () => { quick = undefined })
}

function toggleQuick() {
  if (!quick) createQuick()
  if (quick.isVisible() && quick.isFocused()) return quick.hide()
  // Top third of the screen the pointer is on.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const [w] = quick.getSize()
  quick.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * 0.18))
  quick.show()
  quick.focus()
}

ipcMain.on('quick', (_e, action, hash) => {
  if (quick) quick.hide()
  if (action === 'open') show(typeof hash === 'string' ? hash.replace(/^#/, '') : undefined)
})

function trayImage() {
  // macOS: a one-colour template (the system tints it for light and dark menu bars); elsewhere Mochi in colour.
  const image = nativeImage.createFromPath(asset(mac ? 'trayTemplate.png' : 'tray-color.png'))
  if (mac) image.setTemplateImage(true)
  return image
}

/** The global shortcuts: 叫出 (the main window) and 快速问一句 (the quick box). Returns which ones the system took. */
function applyShortcuts() {
  globalShortcut.unregisterAll()
  registered = {}
  for (const [key, run] of [['summon', () => show()], ['quick', () => toggleQuick()]]) {
    if (!prefs[key]) continue
    try { registered[key] = globalShortcut.register(prefs[key], run) } catch { registered[key] = false }
  }
}

function applyTray() {
  if (prefs.tray && !tray) { tray = new Tray(trayImage()); tray.on('click', () => show()) }
  else if (!prefs.tray && tray) { tray.destroy(); tray = undefined }
  refreshTray()
}

const desktopPrefs = () => ({ ...prefs, openAtLogin: app.getLoginItemSettings().openAtLogin, registered })
ipcMain.handle('prefs:get', () => desktopPrefs())
ipcMain.handle('prefs:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return desktopPrefs()
  if (typeof patch.openAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, openAsHidden: true })
  for (const key of ['summon', 'quick']) if (typeof patch[key] === 'string') prefs[key] = patch[key].slice(0, 60)
  if (typeof patch.tray === 'boolean') prefs.tray = patch.tray
  if (patch.close === 'hide' || patch.close === 'quit') prefs.close = patch.close
  try { writeFileSync(prefsFile(), JSON.stringify(prefs)) } catch { /* best effort */ }
  if ('summon' in patch || 'quick' in patch) applyShortcuts()
  if ('tray' in patch) applyTray()
  refreshTray()
  return desktopPrefs()
})
// 在访达中显示: opens a folder the page names (the data directory, plugins/), if it exists.
ipcMain.handle('reveal', (_e, target) => (typeof target === 'string' && path.isAbsolute(target) && existsSync(target) ? shell.openPath(target) : 'missing'))
// 设置 → 插件 → 选择文件夹…: the folder the owner picks, or undefined when they cancel.
ipcMain.handle('pick-folder', async () => {
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return result.canceled ? undefined : result.filePaths[0]
})

function refreshTray() {
  app.setBadgeCount(badgeOn ? attention : 0)
  if (!tray) return
  tray.setImage(trayImage())
  tray.setToolTip(attention ? `Nuonuo · ${attention} 件事等你处理` : 'Nuonuo')
  if (process.platform === 'darwin') tray.setTitle(attention && badgeOn ? String(attention) : '')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Nuonuo', click: () => show() },
    { label: '快问…', ...(prefs.quick ? { accelerator: prefs.quick } : {}), click: () => toggleQuick() },
    { label: '新侧聊', click: () => show('/new') },
    { type: 'separator' },
    { label: attention ? `等你点头：${attention} 件` : '没有等你点头的事', enabled: attention > 0, click: () => show('/waiting') },
    { type: 'separator' },
    { label: '设置…', click: () => show('/settings/persona') },
    updateItem(),
    { type: 'separator' },
    { label: '退出（后台服务继续运行）', click: () => { quitting = true; app.quit() } },
    { label: '退出并停止后台服务', click: () => { stopService = true; stopDaemon(); quitting = true; app.quit() } },
  ]))
}

async function pollAttention() {
  try {
    const { items } = await api('/api/inbox')
    const badge = await api('/api/settings/notifications').then(r => r.settings.badge !== false).catch(() => badgeOn)
    if (items.length !== attention || badge !== badgeOn) { attention = items.length; badgeOn = badge; refreshTray() }
  } catch { void reconnect() }
}

/**
 * The daemon restarted (Settings → System changed its address or port, or it was updated): find it again, starting it if
 * it stopped, and reload the window on the new address.
 */
let reconnecting = false
async function reconnect() {
  if (reconnecting) return
  reconnecting = true
  try {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1_500))
      const lock = readLock()
      if (!lock && i < 6) continue
      const next = await ensureDaemon(console.log, ownVersion()).catch(() => undefined)
      if (!next) continue
      const moved = next.port !== daemon.port || next.host !== daemon.host
      daemon = next
      if (moved && win) win.loadURL(`${base()}/auth?token=${daemon.token}`)
      if (moved && quick) { quick.destroy(); quick = undefined }
      return
    }
  } finally { reconnecting = false }
}

/** Follows the daemon's event stream; what the agent says while the window is not focused becomes a native notification. */
async function followEvents() {
  for (;;) {
    try {
      const res = await fetch(`${base()}/api/events`, { headers: { authorization: `Bearer ${daemon.token}` } })
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        let i
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i); buffer = buffer.slice(i + 2)
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
          if (!data || !block.includes('event: message')) continue
          const event = JSON.parse(data)
          if (event.type === 'ticket.updated') void pollAttention()
          if (event.type === 'notice') showNotice(event)
        }
      }
    } catch { /* reconnect below */ }
    await new Promise(r => setTimeout(r, 3_000))
  }
}

/** The service decided this is worth a banner (设置 → 通知); shown unless the window is in front (a test always shows). */
function showNotice(notice) {
  if (!Notification.isSupported() || (notice.kind !== 'test' && win && win.isFocused())) return
  const n = new Notification({ title: notice.title || 'Nuonuo', body: notice.body, silent: Boolean(notice.silent) })
  n.on('click', () => show(notice.hash))
  n.show()
  // 糯糯's own sound (设置 → 通知 → 提示音) is played by the page, which keeps running while the window is hidden.
  if (notice.chime && win && !win.isDestroyed()) win.webContents.executeJavaScript(`window.__saChime?.(${JSON.stringify(notice.kind)})`).catch(() => {})
}

/**
 * Updates: the service checks twice a day and, with 自动下载并安装 on (the default), downloads the new version in the
 * background. Once it is staged the app says so once, the tray offers 「重启并更新」, and quitting installs it
 * (lib/update.cjs). The settings page asks for the same through the bridge (update.install).
 */
const ownVersion = () => (app.isPackaged ? app.getVersion() : undefined)
let staged = null          // status().download when it is ready, and whether it installs on quit (prefs.install)
let installing = false
let stopService = false
let announced = ''
async function pollUpdate() {
  try {
    const status = await api('/api/update')
    const d = status.download
    staged = d && d.state === 'ready' && status.available !== false ? { ...d, onQuit: Boolean(status.prefs && status.prefs.install) } : null
    if (staged && announced !== staged.tag && Notification.isSupported()) {
      announced = staged.tag
      const n = new Notification({ title: `糯糯的新版本 v${staged.version} 已经下载好`, body: '退出时会自动安装；点这里现在就重启更新', silent: true })
      n.on('click', () => void installNow(true))
      n.show()
    }
    refreshTray()
  } catch { /* the service is restarting; next time */ }
}
/** Hands the staged version to the install helper and quits; the helper opens the new version (relaunch) or only restarts the service. */
function install(relaunch) {
  if (installing || !staged) return false
  startInstall({ download: staged, home: home(), daemonPid: readLock()?.pid, relaunch, restartDaemon: !stopService, packaged: app.isPackaged })
  installing = true
  return true
}
async function installNow(relaunch) {
  await pollUpdate()
  try {
    if (!install(relaunch)) throw new Error('新版本还没下载好')
  } catch (error) {
    if (Notification.isSupported()) new Notification({ title: '没能自动安装更新', body: String(error.message || error) }).show()
    show('/settings/system')
    return String(error.message || error)
  }
  quitting = true
  app.quit()
  return 'ok'
}
ipcMain.handle('update:install', () => installNow(true))

/** 检查更新 in the tray: asks the service; a newer version turns the item into 「更新到 vX」, which opens 系统和更新. */
let update = { checking: false, latest: null, error: false }
async function checkUpdate() {
  update = { ...update, checking: true, error: false }; refreshTray()
  try {
    const status = await api('/api/update/check', { method: 'POST' })
    update = { checking: false, latest: status.available && status.latest ? status.latest.version : null, error: Boolean(status.checkError) }
    if (!update.latest && !update.error && Notification.isSupported()) new Notification({ title: 'Nuonuo', body: `已经是最新版本（${status.current}）`, silent: true }).show()
  } catch { update = { ...update, checking: false, error: true } }
  refreshTray()
  void pollUpdate()
  if (update.latest) show('/settings/system')
}
function updateItem() {
  if (staged) return { label: `重启并更新到 v${staged.version}`, click: () => void installNow(true) }
  if (update.checking) return { label: '正在检查更新…', enabled: false }
  if (update.latest) return { label: `更新到 v${update.latest}…`, click: () => show('/settings/system') }
  return { label: update.error ? '检查更新（上次没连上）' : '检查更新…', click: () => void checkUpdate() }
}

ipcMain.on('badge', (_e, count) => { attention = Number(count) || 0; refreshTray() })

app.whenReady().then(async () => {
  try {
    daemon = await ensureDaemon(console.log, ownVersion())
  } catch (error) {
    const { dialog } = require('electron')
    dialog.showErrorBox('Nuonuo 无法启动', String(error.message || error))
    app.quit()
    return
  }
  // Marks the window's requests as the desktop app's: with browser access off, the daemon serves pages only to it.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, done) => {
    const headers = details.requestHeaders
    if (details.url.startsWith(base())) headers['x-nuonuo-client'] = 'desktop'
    done({ requestHeaders: headers })
  })
  loadPrefs()
  applyTray()
  createWindow()
  applyShortcuts()
  // The quick box shares the main window's sign-in, so it loads once the main window has.
  win.webContents.once('did-finish-load', () => { if (!quick) createQuick() })
  nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(windowColor()) })
  void pollAttention()
  setInterval(pollAttention, 20_000)
  void followEvents()
  setTimeout(pollUpdate, 20_000)
  setInterval(pollUpdate, 5 * 60_000)
  if (mac) app.dock.setIcon(nativeImage.createFromPath(asset('icon.png')))

  // Smoke test hook: capture the window and the tray menu, then quit.
  if (process.env.NUONUO_DESKTOP_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 2_500))
      const image = await win.webContents.capturePage()
      writeFileSync(process.env.NUONUO_DESKTOP_SMOKE, image.toPNG())
      console.log(JSON.stringify({ ok: true, url: win.webContents.getURL(), title: await win.webContents.executeJavaScript('document.title'),
        desktopFlag: await win.webContents.executeJavaScript('Boolean(window.nuonuoDesktop && window.nuonuoDesktop.isDesktop)'),
        shortcut: Boolean(registered.quick), tray: Boolean(tray && !tray.isDestroyed()), attention, started: daemon.started }))
      quitting = true
      app.quit()
    })
  }
})

app.on('activate', () => show())
app.on('before-quit', () => {
  quitting = true
  // 自动下载并安装: a staged version goes in as the app quits (not in the smoke test).
  if (staged && staged.onQuit && !installing && !process.env.NUONUO_DESKTOP_SMOKE) {
    try { install(false) } catch (error) { console.error('[update]', error.message) }
  }
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { /* stay in the tray */ })
