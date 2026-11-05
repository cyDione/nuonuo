// Tells the web UI it runs inside the desktop app (which shows native notifications itself).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('superAssistantDesktop', {
  isDesktop: true,
  platform: process.platform,
  setBadge: count => ipcRenderer.send('badge', count),
  // Window state the page draws itself around: 'focus' (true/false) and 'fullscreen' (true/false).
  on: (event, fn) => { if (event === 'focus' || event === 'fullscreen') ipcRenderer.on(`sa:${event}`, (_e, value) => fn(value)) },
  // The quick-ask box: 'hide' tucks it away, 'open' shows the main window at a page (#/c/…).
  quick: (action, hash) => ipcRenderer.send('quick', action, hash),
})
