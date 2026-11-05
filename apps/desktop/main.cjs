// Super-assistant desktop: the web UI in a window, plus what only a desktop app can do —
// a tray icon showing what needs you, native notifications, a global shortcut, and starting at login.
const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, nativeImage, nativeTheme, screen, shell, ipcMain, session } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const { ensureDaemon, stopDaemon, readLock } = require('./lib/daemon.cjs')

const SHORTCUT = 'CommandOrControl+Shift+Space'
let win, quick, tray, daemon
let attention = 0
let quitting = false

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
const windowColor = () => (nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#f4f4f3')

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
  // Closing the window hides it; the agent keeps working in the tray.
  win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide() } })
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

function refreshTray() {
  if (!tray) return
  tray.setImage(trayImage())
  tray.setToolTip(attention ? `Super-assistant · ${attention} 件事等你处理` : 'Super-assistant')
  if (process.platform === 'darwin') tray.setTitle(attention ? String(attention) : '')
  app.setBadgeCount(attention)
  const login = app.getLoginItemSettings().openAtLogin
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Super-assistant', click: () => show() },
    { label: '快问…', accelerator: SHORTCUT, click: () => toggleQuick() },
    { label: '新对话', click: () => show('/new') },
    { type: 'separator' },
    { label: attention ? `待你处理：${attention} 件` : '没有需要你处理的事', enabled: attention > 0, click: () => show() },
    { type: 'separator' },
    { label: '开机时启动', type: 'checkbox', checked: login, click: item => { app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }); refreshTray() } },
    { label: '设置', click: () => show('/settings/providers') },
    { type: 'separator' },
    { label: '退出（后台服务继续运行）', click: () => { quitting = true; app.quit() } },
    { label: '退出并停止后台服务', click: () => { stopDaemon(); quitting = true; app.quit() } },
  ]))
}

async function pollAttention() {
  try {
    const { items } = await api('/api/inbox')
    if (items.length !== attention) { attention = items.length; refreshTray() }
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
          if (event.type === 'message.created') void notifyMessage(event)
        }
      }
    } catch { /* reconnect below */ }
    await new Promise(r => setTimeout(r, 3_000))
  }
}

const notified = new Set()
async function notifyMessage({ conversationId, messageId }) {
  if (notified.has(messageId) || (win && win.isFocused()) || !Notification.isSupported()) return
  notified.add(messageId)
  try {
    const { message } = await api(`/api/messages/${messageId}`)
    const fromOwner = message.role === 'user' && (message.meta.source || 'webchat') === 'webchat'
    if (fromOwner || message.role === 'event' || message.meta.delivery) return
    const name = await api('/api/persona').then(r => r.persona.name).catch(() => 'Super-assistant')
    const n = new Notification({ title: message.role === 'assistant' ? name : String(message.meta.actor || message.meta.source || name), body: message.content.slice(0, 200), silent: false })
    n.on('click', () => show(`/c/${conversationId}`))
    n.show()
  } catch { /* best effort */ }
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
  tray = new Tray(trayImage())
  tray.on('click', () => show())
  refreshTray()
  createWindow()
  globalShortcut.register(SHORTCUT, () => toggleQuick())
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
        shortcut: globalShortcut.isRegistered(SHORTCUT), tray: Boolean(tray && !tray.isDestroyed()), attention, started: daemon.started }))
      quitting = true
      app.quit()
    })
  }
})

app.on('activate', () => show())
app.on('before-quit', () => { quitting = true })
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { /* stay in the tray */ })
