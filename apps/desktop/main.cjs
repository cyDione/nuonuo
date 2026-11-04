// Super-agent desktop: the web UI in a window, plus what only a desktop app can do —
// a tray icon showing what needs you, native notifications, a global shortcut, and starting at login.
const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, nativeImage, shell, ipcMain } = require('electron')
const { writeFileSync } = require('node:fs')
const { ensureDaemon, stopDaemon } = require('./lib/daemon.cjs')
const { iconPng } = require('./lib/icon.cjs')

const SHORTCUT = 'CommandOrControl+Shift+Space'
let win, tray, daemon
let attention = 0
let quitting = false

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => show())

const base = () => `http://127.0.0.1:${daemon.port}`
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520, title: 'Super-agent', show: false, backgroundColor: '#f7f7f8',
    icon: nativeImage.createFromBuffer(iconPng(256)),
    webPreferences: { preload: require('node:path').join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  win.loadURL(`${base()}/auth?token=${daemon.token}`)
  win.once('ready-to-show', () => { if (!process.env.SUPERAGENT_DESKTOP_HIDDEN) win.show() })
  // Links to other sites open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(base())) { event.preventDefault(); shell.openExternal(url) } })
  // Closing the window hides it; the agent keeps working in the tray.
  win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide() } })
}

function trayImage() {
  const mac = process.platform === 'darwin'
  const image = nativeImage.createFromBuffer(iconPng(mac ? 18 : 22, { color: mac ? [0, 0, 0] : [79, 70, 229], badge: attention > 0 && !mac }))
  if (mac) image.setTemplateImage(true)
  return image
}

function refreshTray() {
  if (!tray) return
  tray.setImage(trayImage())
  tray.setToolTip(attention ? `Super-agent · ${attention} 件事等你处理` : 'Super-agent')
  if (process.platform === 'darwin') tray.setTitle(attention ? String(attention) : '')
  app.setBadgeCount(attention)
  const login = app.getLoginItemSettings().openAtLogin
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Super-agent', click: () => show() },
    { label: '新对话', accelerator: SHORTCUT, click: () => show('/') },
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
  } catch { /* daemon restarting */ }
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
    const n = new Notification({ title: message.role === 'assistant' ? 'Super-agent' : String(message.meta.actor || message.meta.source || 'Super-agent'), body: message.content.slice(0, 200), silent: false })
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
    dialog.showErrorBox('Super-agent 无法启动', String(error.message || error))
    app.quit()
    return
  }
  tray = new Tray(trayImage())
  tray.on('click', () => show())
  refreshTray()
  createWindow()
  globalShortcut.register(SHORTCUT, () => (win && win.isVisible() && win.isFocused() ? win.hide() : show('/')))
  void pollAttention()
  setInterval(pollAttention, 20_000)
  void followEvents()
  if (process.platform === 'darwin') app.dock.setIcon(nativeImage.createFromBuffer(iconPng(256)))

  // Smoke test hook: capture the window and the tray menu, then quit.
  if (process.env.SUPERAGENT_DESKTOP_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 2_500))
      const image = await win.webContents.capturePage()
      writeFileSync(process.env.SUPERAGENT_DESKTOP_SMOKE, image.toPNG())
      console.log(JSON.stringify({ ok: true, url: win.webContents.getURL(), title: await win.webContents.executeJavaScript('document.title'),
        desktopFlag: await win.webContents.executeJavaScript('Boolean(window.superagentDesktop && window.superagentDesktop.isDesktop)'),
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
