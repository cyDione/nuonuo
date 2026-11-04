// Tells the web UI it runs inside the desktop app (which shows native notifications itself).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('superagentDesktop', {
  isDesktop: true,
  platform: process.platform,
  setBadge: count => ipcRenderer.send('badge', count),
})
