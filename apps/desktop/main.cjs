// Nuonuo thin desktop client: zero bundled Node.js or daemon.
// Serves the bundled web UI via secure `app://nuonuo` protocol (or Vite dev server in dev),
// stores server profiles + refresh tokens encrypted via Electron `safeStorage`, handles `nuonuo://pair` deep links,
// supports on-demand Local Deploy (install script or Docker), and drives native tray/notifications from the active server.
const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, nativeImage, nativeTheme, screen, shell, ipcMain, protocol, net, safeStorage } = require('electron')
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createVault } = require('./lib/vault.cjs')
const deployer = require('./lib/deployer.cjs')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

const SHORTCUT = 'CommandOrControl+Shift+Space'
const DEFAULT_PREFS = { tray: true, close: 'hide', summon: process.platform === 'darwin' ? 'Alt+Space' : '', quick: SHORTCUT }
const mac = process.platform === 'darwin'

let win, quick, tray, vault
let prefs = { ...DEFAULT_PREFS }
let registered = {}
let attention = 0
let badgeOn = true
let quitting = false
let activeSession = null // { id, baseUrl, accessToken }
let eventsAbort = null
let pendingDeepLink = null

const prefsFile = () => path.join(app.getPath('userData'), 'desktop-prefs.json')
const vaultFile = () => path.join(app.getPath('userData'), 'vault.json')
const asset = name => path.join(__dirname, 'assets', name)
const windowColor = () => (nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff')

function findWebDir() {
  const candidates = [
    process.env.NUONUO_WEB_DIR,
    process.resourcesPath && path.join(process.resourcesPath, 'web'),
    path.join(__dirname, '..', 'web', 'dist'),
  ]
  return candidates.find(p => p && existsSync(path.join(p, 'index.html')))
}

function uiStartUrl(hash = '') {
  if (process.env.NUONUO_DEV_URL) return `${process.env.NUONUO_DEV_URL.replace(/\/+$/, '')}/${hash ? `#${hash}` : ''}`
  return `app://nuonuo/${hash ? `#${hash}` : ''}`
}

function loadPrefs() {
  try {
    prefs = { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(prefsFile(), 'utf8')) }
  } catch { /* first run */ }
}

if (!app.requestSingleInstanceLock()) app.quit()

function handleDeepLink(rawUrl) {
  if (typeof rawUrl !== 'string' || !/^nuonuo:\/\//i.test(rawUrl)) return
  pendingDeepLink = rawUrl
  if (win && !win.isDestroyed()) {
    show()
    win.webContents.send('sa:pair-uri', rawUrl)
    pendingDeepLink = null
  }
}

app.on('second-instance', (_event, argv) => {
  const uri = argv.find(a => /^nuonuo:\/\//i.test(a))
  if (uri) handleDeepLink(uri)
  else show()
})
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})

function show(hash) {
  if (!win) createWindow()
  if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {})
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520, title: 'Nuonuo', show: false, backgroundColor: windowColor(),
    icon: nativeImage.createFromPath(asset('icon-256.png')),
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  win.loadURL(uiStartUrl())
  const tell = (event, value) => { if (win && !win.isDestroyed()) win.webContents.send(`sa:${event}`, value) }
  win.on('focus', () => tell('focus', true))
  win.on('blur', () => tell('focus', false))
  win.on('enter-full-screen', () => tell('fullscreen', true))
  win.on('leave-full-screen', () => tell('fullscreen', false))
  win.webContents.on('did-finish-load', () => {
    tell('focus', win.isFocused())
    tell('fullscreen', win.isFullScreen())
    if (pendingDeepLink) {
      tell('pair-uri', pendingDeepLink)
      pendingDeepLink = null
    }
  })
  win.once('ready-to-show', () => { if (!process.env.NUONUO_DESKTOP_HIDDEN) win.show() })
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (event, url) => {
    const allowedOrigin = uiStartUrl().split('#')[0]
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
  win.on('close', event => {
    if (quitting) return
    if (prefs.close === 'quit') { quitting = true; app.quit(); return }
    event.preventDefault()
    win.hide()
  })
}

function createQuick() {
  quick = new BrowserWindow({
    width: 640, height: 420, show: false, frame: false, transparent: true, resizable: false, movable: true, alwaysOnTop: true,
    skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false, hasShadow: false, backgroundColor: '#00000000',
    ...(mac ? { type: 'panel', visibleOnAllWorkspaces: true } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  quick.loadURL(uiStartUrl('/quick'))
  quick.on('blur', () => { if (!process.env.NUONUO_DESKTOP_SMOKE) quick.hide() })
  quick.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  quick.on('closed', () => { quick = undefined })
}

function toggleQuick() {
  if (!quick) createQuick()
  if (quick.isVisible() && quick.isFocused()) return quick.hide()
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const [w] = quick.getSize()
  quick.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * 0.18))
  quick.show()
  quick.focus()
}

function trayImage() {
  const image = nativeImage.createFromPath(asset(mac ? 'trayTemplate.png' : 'tray-color.png'))
  if (mac) image.setTemplateImage(true)
  return image
}

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

function refreshTray() {
  app.setBadgeCount(badgeOn ? attention : 0)
  if (!tray) return
  tray.setImage(trayImage())
  tray.setToolTip(attention ? `Nuonuo · ${attention} 件事等你处理` : 'Nuonuo')
  if (mac) tray.setTitle(attention && badgeOn ? String(attention) : '')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Nuonuo', click: () => show() },
    { label: '快问…', ...(prefs.quick ? { accelerator: prefs.quick } : {}), click: () => toggleQuick() },
    { label: '新侧聊', click: () => show('/new') },
    { type: 'separator' },
    { label: attention ? `等你点头：${attention} 件` : '没有等你点头的事', enabled: attention > 0, click: () => show('/waiting') },
    { type: 'separator' },
    { label: '设置与连接…', click: () => show('/settings/system') },
    { type: 'separator' },
    { label: '退出 Nuonuo 桌面端', click: () => { quitting = true; app.quit() } },
  ]))
}

// ── Native notifications & badge following the active remote/local server ────

let lastRefreshSignalAt = 0
function requestRendererRefresh() {
  const now = Date.now()
  if (now - lastRefreshSignalAt < 5_000) return
  lastRefreshSignalAt = now
  if (win && !win.isDestroyed()) win.webContents.send('sa:need-refresh', true)
}

async function serverApi(p) {
  if (!activeSession?.baseUrl || !activeSession?.accessToken) return null
  const res = await fetch(`${activeSession.baseUrl.replace(/\/+$/, '')}/v1${p}`, {
    headers: { authorization: `Bearer ${activeSession.accessToken}` },
    signal: AbortSignal.timeout(4_000),
  })
  if (res.status === 401) requestRendererRefresh()
  if (!res.ok) return null
  return res.json()
}

async function pollAttention() {
  try {
    const inbox = await serverApi('/inbox')
    if (!inbox) return
    const items = Array.isArray(inbox.items) ? inbox.items : []
    const notif = await serverApi('/settings/notifications')
    const badge = notif ? notif.settings?.badge !== false : badgeOn
    if (items.length !== attention || badge !== badgeOn) {
      attention = items.length
      badgeOn = badge
      refreshTray()
    }
  } catch { /* ignore while disconnected */ }
}

function showNotice(notice) {
  if (!Notification.isSupported() || (notice.kind !== 'test' && win && win.isFocused())) return
  const n = new Notification({ title: notice.title || 'Nuonuo', body: notice.body, silent: Boolean(notice.silent) })
  n.on('click', () => show(notice.hash))
  n.show()
  if (notice.chime && win && !win.isDestroyed()) {
    win.webContents.executeJavaScript(`window.__saChime?.(${JSON.stringify(notice.kind)})`).catch(() => {})
  }
}

function restartEventStream() {
  eventsAbort?.abort()
  eventsAbort = null
  if (!activeSession?.baseUrl || !activeSession?.accessToken) {
    attention = 0
    refreshTray()
    return
  }
  const ctrl = new AbortController()
  eventsAbort = ctrl
  void pollAttention()
  void (async () => {
    while (!ctrl.signal.aborted && !quitting) {
      try {
        const res = await fetch(`${activeSession.baseUrl.replace(/\/+$/, '')}/v1/events`, {
          headers: { authorization: `Bearer ${activeSession.accessToken}`, accept: 'text/event-stream' },
          signal: ctrl.signal,
        })
        if (res.status === 401) requestRendererRefresh()
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value.replace(/\r\n?/g, '\n')
          let cut
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
            if (!data || !block.includes('event: message')) continue
            const event = JSON.parse(data)
            if (event.type === 'ticket.updated') void pollAttention()
            if (event.type === 'notice') showNotice(event)
          }
        }
      } catch { /* wait and retry */ }
      if (ctrl.signal.aborted || quitting) break
      await new Promise(r => setTimeout(r, 4_000))
    }
  })()
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on('quick', (_e, action, hash) => {
  if (quick) quick.hide()
  if (action === 'open') show(typeof hash === 'string' ? hash.replace(/^#/, '') : undefined)
})
ipcMain.on('badge', (_e, count) => { attention = Number(count) || 0; refreshTray() })

const desktopPrefs = () => ({ ...prefs, openAtLogin: app.getLoginItemSettings().openAtLogin, registered })
ipcMain.handle('prefs:get', () => desktopPrefs())
ipcMain.handle('prefs:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return desktopPrefs()
  if (typeof patch.openAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, openAsHidden: true })
  for (const key of ['summon', 'quick']) if (typeof patch[key] === 'string') prefs[key] = patch[key].slice(0, 60)
  if (typeof patch.tray === 'boolean') prefs.tray = patch.tray
  if (patch.close === 'hide' || patch.close === 'quit') prefs.close = patch.close
  try { mkdirSync(path.dirname(prefsFile()), { recursive: true }); writeFileSync(prefsFile(), JSON.stringify(prefs)) } catch { /* best effort */ }
  if ('summon' in patch || 'quick' in patch) applyShortcuts()
  if ('tray' in patch) applyTray()
  refreshTray()
  return desktopPrefs()
})
ipcMain.handle('reveal', (_e, target) => (typeof target === 'string' && path.isAbsolute(target) && existsSync(target) ? shell.openPath(target) : 'missing'))
ipcMain.handle('pick-folder', async () => {
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return result.canceled ? undefined : result.filePaths[0]
})

ipcMain.handle('vault:list', () => vault.list())
ipcMain.handle('vault:save', (_e, profile, refreshToken) => vault.save(profile, refreshToken))
ipcMain.handle('vault:get-refresh', (_e, profileId) => vault.getRefreshToken(profileId))
ipcMain.handle('vault:set-active', (_e, profileId) => vault.setActive(profileId))
ipcMain.handle('vault:remove', (_e, profileId) => vault.remove(profileId))
ipcMain.handle('vault:active-session', (_e, sessionInfo) => {
  const prev = activeSession
  activeSession = sessionInfo && sessionInfo.baseUrl && sessionInfo.accessToken ? sessionInfo : null
  if (!prev || !activeSession || prev.baseUrl !== activeSession.baseUrl || prev.accessToken !== activeSession.accessToken) {
    restartEventStream()
  }
})

ipcMain.handle('deploy:detect', () => deployer.detect())
ipcMain.handle('deploy:start-local', (_e, opts) => deployer.startLocal(opts, line => win && !win.isDestroyed() && win.webContents.send('deploy:log', line)))
ipcMain.handle('deploy:start-docker', (_e, opts) => deployer.startDocker(opts, line => win && !win.isDestroyed() && win.webContents.send('deploy:log', line)))
ipcMain.handle('deploy:stop-local', () => deployer.stopLocal())

// ── Boot ─────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  vault = createVault(vaultFile(), safeStorage)
  try { app.setAsDefaultProtocolClient('nuonuo') } catch { /* dev */ }

  const webDir = findWebDir()
  const resolvedWebRoot = webDir ? path.resolve(webDir) : null
  protocol.handle('app', req => {
    if (!webDir || !resolvedWebRoot) return new Response('Web UI bundle missing. Run `pnpm build` first.', { status: 500 })
    const url = new URL(req.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const candidate = path.resolve(resolvedWebRoot, rel)
    let isSafeFile = false
    if (candidate === path.join(resolvedWebRoot, 'index.html') || candidate.startsWith(resolvedWebRoot + path.sep)) {
      try { isSafeFile = statSync(candidate).isFile() } catch { isSafeFile = false }
    }
    const safeFile = isSafeFile ? candidate : path.join(resolvedWebRoot, 'index.html')
    return net.fetch(pathToFileURL(safeFile).href)
  })

  loadPrefs()
  applyTray()
  createWindow()
  applyShortcuts()
  win.webContents.once('did-finish-load', () => { if (!quick) createQuick() })
  nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(windowColor()) })
  setInterval(pollAttention, 30_000)
  if (mac) app.dock.setIcon(nativeImage.createFromPath(asset('icon.png')))

  // Check if launched with a `nuonuo://` deep link argument.
  const launchUri = process.argv.find(a => /^nuonuo:\/\//i.test(a))
  if (launchUri) handleDeepLink(launchUri)
})

app.on('activate', () => show())
app.on('before-quit', () => { quitting = true; eventsAbort?.abort() })
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { /* stay in tray */ })
