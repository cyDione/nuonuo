// Preload bridge for the thin Nuonuo desktop client: OS-encrypted vault, on-demand local deploy,
// native window/tray/shortcuts, and `nuonuo://` deep-link forwarding.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nuonuoDesktop', {
  isDesktop: true,
  platform: process.platform,
  setBadge: count => ipcRenderer.send('badge', count),
  on: (event, fn) => {
    if (event === 'focus' || event === 'fullscreen' || event === 'pair-uri' || event === 'need-refresh') {
      ipcRenderer.on(`sa:${event}`, (_e, value) => fn(value))
    }
  },
  quick: (action, hash) => ipcRenderer.send('quick', action, hash),
  prefs: { get: () => ipcRenderer.invoke('prefs:get'), set: patch => ipcRenderer.invoke('prefs:set', patch) },
  reveal: target => ipcRenderer.invoke('reveal', target),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  vault: {
    list: () => ipcRenderer.invoke('vault:list'),
    save: (profile, refreshToken) => ipcRenderer.invoke('vault:save', profile, refreshToken),
    getRefreshToken: profileId => ipcRenderer.invoke('vault:get-refresh', profileId),
    setActive: profileId => ipcRenderer.invoke('vault:set-active', profileId),
    remove: profileId => ipcRenderer.invoke('vault:remove', profileId),
    setActiveSession: session => ipcRenderer.invoke('vault:active-session', session),
  },
  deploy: {
    detect: () => ipcRenderer.invoke('deploy:detect'),
    startLocal: opts => ipcRenderer.invoke('deploy:start-local', opts),
    startDocker: opts => ipcRenderer.invoke('deploy:start-docker', opts),
    stopLocal: () => ipcRenderer.invoke('deploy:stop-local'),
    onLog: fn => {
      const handler = (_e, line) => fn(line)
      ipcRenderer.on('deploy:log', handler)
      return () => ipcRenderer.removeListener('deploy:log', handler)
    },
  },
})
