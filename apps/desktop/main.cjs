// Super-assistant desktop: the web UI in a window, plus what only a desktop app can do —
// a tray icon showing what needs you, native notifications, a global shortcut, and starting at login.
const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, nativeImage, nativeTheme, screen, shell, ipcMain, session } = require('electron')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { ensureDaemon, stopDaemon, readLock } = require('./lib/daemon.cjs')

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
function loadPrefs() { try { prefs = { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(prefsFile(), 'utf8')) } } catch { /* first run */ } }

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
    width: 1280, height: 860, minWidth: 720, minHeight: 520, title: 'Super-assistant', show: false, backgroundColor: windowColor(),
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
  win.once('ready-to-show', () => { if (!process.env.SUPER_ASSISTANT_DESKTOP_HIDDEN) win.show() })
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
  quick.on('blur', () => { if (!process.env.SUPER_ASSISTANT_DESKTOP_SMOKE) quick.hide() })
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

function refreshTray() {
  app.setBadgeCount(badgeOn ? attention : 0)
  if (!tray) return
  tray.setImage(trayImage())
  tray.setToolTip(attention ? `Super-assistant · ${attention} 件事等你处理` : 'Super-assistant')
  if (process.platform === 'darwin') tray.setTitle(attention && badgeOn ? String(attention) : '')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Super-assistant', click: () => show() },
    { label: '快问…', ...(prefs.quick ? { accelerator: prefs.quick } : {}), click: () => toggleQuick() },
    { label: '新侧聊', click: () => show('/new') },
    { type: 'separator' },
    { label: attention ? `等你点头：${attention} 件` : '没有等你点头的事', enabled: attention > 0, click: () => show('/waiting') },
    { type: 'separator' },
    { label: '设置…', click: () => show('/settings/persona') },
    { type: 'separator' },
    { label: '退出（后台服务继续运行）', click: () => { quitting = true; app.quit() } },
    { label: '退出并停止后台服务', click: () => { stopDaemon(); quitting = true; app.quit() } },
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
      const next = await ensureDaemon().catch(() => undefined)
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
  const n = new Notification({ title: notice.title || 'Super-assistant', body: notice.body, silent: Boolean(notice.silent) })
  n.on('click', () => show(notice.hash))
  n.show()
}

ipcMain.on('badge', (_e, count) => { attention = Number(count) || 0; refreshTray() })

app.whenReady().then(async () => {
  try {
    daemon = await ensureDaemon()
  } catch (error) {
    const { dialog } = require('electron')
    dialog.showErrorBox('Super-assistant 无法启动', String(error.message || error))
    app.quit()
    return
  }
  // Marks the window's requests as the desktop app's: with browser access off, the daemon serves pages only to it.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, done) => {
    const headers = details.requestHeaders
    if (details.url.startsWith(base())) headers['x-super-assistant-client'] = 'desktop'
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
  if (mac) app.dock.setIcon(nativeImage.createFromPath(asset('icon.png')))

  // Smoke test hook: capture the window and the tray menu, then quit.
  if (process.env.SUPER_ASSISTANT_DESKTOP_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 2_500))
      const image = await win.webContents.capturePage()
      writeFileSync(process.env.SUPER_ASSISTANT_DESKTOP_SMOKE, image.toPNG())
      console.log(JSON.stringify({ ok: true, url: win.webContents.getURL(), title: await win.webContents.executeJavaScript('document.title'),
        desktopFlag: await win.webContents.executeJavaScript('Boolean(window.superAssistantDesktop && window.superAssistantDesktop.isDesktop)'),
        shortcut: Boolean(registered.quick), tray: Boolean(tray && !tray.isDestroyed()), attention, started: daemon.started }))
      quitting = true
      app.quit()
    })
  }
})

app.on('activate', () => show())
app.on('before-quit', () => { quitting = true })
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { /* stay in the tray */ })
