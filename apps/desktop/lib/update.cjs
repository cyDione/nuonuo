// Installs the new version the service downloaded and staged (apps/daemon/src/update.ts, status().download).
//
// The app cannot replace its own files while it runs, so it writes a small helper script, starts it detached and quits.
// The helper waits for the app to exit and stops the background service (on Windows its node.exe lives in the install
// folder and would block the installer; on macOS it would keep serving the old version). Then:
//   macOS    swaps the staged Super-assistant.app in place of the running one (as install.sh does) and clears the
//            quarantine flag, so Gatekeeper does not stop the updated app even without a Developer ID signature;
//   Windows  runs the NSIS installer silently (/S --updated), which updates the existing installation in place.
// Afterwards it opens the app again (restart and update), or only starts the service again when the app was simply
// quitting (install on quit), so routines keep running. Everything it does goes to <home>/logs/update.log.
const { spawn } = require('node:child_process')
const { accessSync, constants, existsSync, mkdirSync, openSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const sh = value => `'${String(value).replace(/'/g, `'\\''`)}'`
const ps = value => `'${String(value).replace(/'/g, "''")}'`

/** The running .app bundle on macOS (…/Super-assistant.app), from the executable inside it. */
const macBundle = exe => path.resolve(exe, '..', '..', '..')

/** Why this copy of the app cannot update itself in place, or null when it can. */
function blocker({ platform, exe, packaged }) {
  if (!packaged) return '开发版不会自动安装更新'
  if (platform === 'darwin') {
    const bundle = macBundle(exe)
    if (!bundle.endsWith('.app')) return '找不到应用的位置'
    // Opened straight from the .dmg, or moved by Gatekeeper's App Translocation: there is nothing to replace.
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return '请先把 Super-assistant 拖进「应用程序」文件夹再更新'
    try { accessSync(path.dirname(bundle), constants.W_OK) } catch { return `没有权限写入 ${path.dirname(bundle)}，请从发布页下载新版手动安装` }
    return null
  }
  if (platform === 'win32') return null
  return '这个系统上的桌面版不支持自动安装'
}

/** The helper script for macOS (bash). */
function macScript({ appPid, daemonPid, staged, bundle, home, relaunch, restartDaemon }) {
  return `#!/bin/bash
# Super-assistant update helper (written by the app; safe to delete).
app_pid=${Number(appPid) || 0}; daemon_pid=${Number(daemonPid) || 0}
staged=${sh(staged)}; dest=${sh(bundle)}; home=${sh(home)}
log() { printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }
log "installing $staged over $dest"
for _ in $(seq 1 300); do kill -0 "$app_pid" 2>/dev/null || break; sleep 0.2; done
if [ "$daemon_pid" -gt 0 ] && kill -0 "$daemon_pid" 2>/dev/null; then
  kill -TERM "$daemon_pid" 2>/dev/null
  for _ in $(seq 1 75); do kill -0 "$daemon_pid" 2>/dev/null || break; sleep 0.2; done
  kill -KILL "$daemon_pid" 2>/dev/null || true
fi
ok=1
rm -rf "$dest.new" "$dest.old"
if ditto "$staged" "$dest.new"; then
  xattr -dr com.apple.quarantine "$dest.new" 2>/dev/null || true
  if mv "$dest" "$dest.old" && mv "$dest.new" "$dest"; then
    rm -rf "$dest.old"
    rm -rf "$home/updates"
    log "installed"
  else
    log "could not swap the app; the old version stays"
    [ -d "$dest" ] || mv "$dest.old" "$dest"
    rm -rf "$dest.new"; ok=0
  fi
else
  log "could not copy the new version"; rm -rf "$dest.new"; ok=0
fi
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
if [ ${relaunch ? 1 : 0} = 1 ]; then
  open "$dest"
elif [ ${restartDaemon ? 1 : 0} = 1 ]; then
  res="$dest/Contents/Resources"
  (cd "$res/daemon" && SUPER_ASSISTANT_HOME="$home" nohup "$res/node/node" "$res/daemon/cli.mjs" start --no-open --desktop >>"$home/logs/daemon.log" 2>&1 &)
fi
[ $ok = 1 ]
`
}

/** The helper script for Windows (PowerShell). */
function winScript({ appPid, daemonPid, staged, exe, resources, home, relaunch, restartDaemon }) {
  return `# Super-assistant update helper (written by the app; safe to delete).
$ErrorActionPreference = 'Continue'
function Log($m) { Write-Output ("{0} {1}" -f (Get-Date -Format s), $m) }
$setup = ${ps(staged)}; $exe = ${ps(exe)}; $resources = ${ps(resources)}; $saHome = ${ps(home)}
Log "installing $setup"
Wait-Process -Id ${Number(appPid) || 0} -Timeout 60 -ErrorAction SilentlyContinue
$daemonPid = ${Number(daemonPid) || 0}
if ($daemonPid -gt 0) {
  Stop-Process -Id $daemonPid -ErrorAction SilentlyContinue
  Wait-Process -Id $daemonPid -Timeout 15 -ErrorAction SilentlyContinue
}
$p = Start-Process -FilePath $setup -ArgumentList '/S', '--updated' -Wait -PassThru
Log ("installer exit code {0}" -f $p.ExitCode)
if ($p.ExitCode -eq 0) { Remove-Item -Recurse -Force (Join-Path $saHome 'updates') -ErrorAction SilentlyContinue }
if (${relaunch ? '$true' : '$false'}) {
  Start-Process -FilePath $exe
} elseif (${restartDaemon ? '$true' : '$false'}) {
  $env:SUPER_ASSISTANT_HOME = $saHome
  $cli = Join-Path $resources 'daemon\\cli.mjs'
  Start-Process -FilePath (Join-Path $resources 'node\\node.exe') -ArgumentList ('"' + $cli + '"'), 'start', '--no-open', '--desktop' -WorkingDirectory (Join-Path $resources 'daemon') -WindowStyle Hidden
}
`
}

/**
 * Starts the helper for `download` (status().download, state 'ready') and returns; the caller quits the app right after.
 * Throws when this copy cannot update itself (see blocker).
 */
function startInstall({ download, home, daemonPid, relaunch, restartDaemon, platform = process.platform, exe = process.execPath, resources = process.resourcesPath, packaged = true, appPid = process.pid }) {
  if (!download || download.state !== 'ready' || !download.path || !existsSync(download.path)) throw new Error('新版本还没下载好')
  const why = blocker({ platform, exe, packaged })
  if (why) throw new Error(why)
  const logs = path.join(home, 'logs')
  mkdirSync(logs, { recursive: true })
  const out = openSync(path.join(logs, 'update.log'), 'a')
  const args = { appPid, daemonPid, staged: download.path, home, relaunch, restartDaemon }
  let child
  if (platform === 'darwin') {
    const file = path.join(logs, 'update-install.sh')
    writeFileSync(file, macScript({ ...args, bundle: macBundle(exe) }), { mode: 0o700 })
    child = spawn('/bin/bash', [file], { detached: true, stdio: ['ignore', out, out] })
  } else {
    const file = path.join(logs, 'update-install.ps1')
    writeFileSync(file, winScript({ ...args, exe, resources }))
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
      { detached: true, windowsHide: true, stdio: ['ignore', out, out] })
  }
  child.unref()
  return child
}

module.exports = { startInstall, blocker, macScript, winScript, macBundle }
