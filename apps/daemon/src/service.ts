/** Installs the daemon as a per-user service so it starts at login: launchd on macOS, a systemd user unit on Linux. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultHome, legacyHome } from './legacy'

const LABEL = 'dev.nuonuo.daemon'
/** The launchd label and systemd unit of versions from before the rename. */
const LEGACY_LABEL = 'dev.super-assistant.daemon'
const LEGACY_UNIT = 'super-assistant.service'
const legacyFiles = () => ({
  plist: join(homedir(), 'Library/LaunchAgents', `${LEGACY_LABEL}.plist`),
  unit: join(homedir(), '.config/systemd/user', LEGACY_UNIT),
})
/** The data directory goes into the unit only when it is not a default one, so that a later move of the default is followed. */
const customHome = (home: string) => ![defaultHome(), legacyHome()].some(d => resolve(d) === resolve(home))

export function serviceFiles(entry: string, home: string) {
  const node = process.execPath
  const args = entry.endsWith('.ts') ? [node, '--import', 'tsx', entry, 'start', '--no-open'] : [node, entry, 'start', '--no-open']
  if (process.platform === 'darwin') {
    const file = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${customHome(home) ? `<key>NUONUO_HOME</key><string>${home}</string>` : ''}<key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${home}/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>${home}/logs/daemon.log</string>
</dict></plist>
`
    return { file, content: plist, enable: ['launchctl', ['load', '-w', file]] as const, disable: ['launchctl', ['unload', '-w', file]] as const }
  }
  if (process.platform === 'linux') {
    const file = join(homedir(), '.config/systemd/user/nuonuo.service')
    const unit = `[Unit]
Description=Nuonuo personal daemon
After=network-online.target
# The unit from before the rename: starting this one stops it first.
Conflicts=${LEGACY_UNIT}
After=${LEGACY_UNIT}

[Service]
ExecStart=${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}
${customHome(home) ? `Environment=NUONUO_HOME=${home}\n` : ''}# Tells the updater that systemd restarts this process after an update.
Environment=NUONUO_SERVICE=1
Environment=PATH=${process.env.PATH}
Restart=on-failure
RestartSec=5
# A shutdown that hangs must not stall a systemctl restart for the 90s default.
TimeoutStopSec=15

[Install]
WantedBy=default.target
`
    return { file, content: unit, enable: ['systemctl', ['--user', 'enable', '--now', 'nuonuo.service']] as const,
      disable: ['systemctl', ['--user', 'disable', '--now', 'nuonuo.service']] as const }
  }
  throw new Error(`不支持的平台：${process.platform}（目前支持 macOS 与 Linux）`)
}

export function installService(entry: string, home: string, dryRun: boolean): string {
  const s = serviceFiles(entry, home)
  if (dryRun) return `${s.file}\n\n${s.content}`
  mkdirSync(join(s.file, '..'), { recursive: true })
  writeFileSync(s.file, s.content)
  const legacy = legacyFiles()
  if (process.platform === 'linux' && existsSync(legacy.unit)) {
    // An install from before the rename (install.sh runs this, possibly from inside the old service): enable the new unit
    // and let systemd swap them. Conflicts= stops the old one before the new one starts, even if that ends this process.
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
    try { execFileSync('systemctl', ['--user', 'disable', LEGACY_UNIT], { stdio: 'inherit' }) } catch { /* not enabled */ }
    rmSync(legacy.unit, { force: true })
    execFileSync('systemctl', ['--user', 'enable', 'nuonuo.service'], { stdio: 'inherit' })
    execFileSync('systemctl', ['--user', 'start', '--no-block', 'nuonuo.service'], { stdio: 'inherit' })
    return `已安装：${s.file}（替换了旧的 ${LEGACY_UNIT}）`
  }
  if (process.platform === 'darwin' && existsSync(legacy.plist)) {
    try { execFileSync('launchctl', ['unload', '-w', legacy.plist], { stdio: 'inherit' }) } catch { /* not loaded */ }
    rmSync(legacy.plist, { force: true })
  }
  if (process.platform === 'linux') execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
  execFileSync(s.enable[0], [...s.enable[1]], { stdio: 'inherit' })
  return `已安装并启动：${s.file}\n提示：开机启动的服务读不到 shell 里 export 的变量。API key 请在网页的「设置 → 模型供应商」里填写（存进钥匙串），或写进 ${join(home, 'env')}（每行 KEY=value，权限 0600）。`
}

export function uninstallService(entry: string, home: string): string {
  const s = serviceFiles(entry, home)
  try { execFileSync(s.disable[0], [...s.disable[1]], { stdio: 'inherit' }) } catch { /* not loaded */ }
  rmSync(s.file, { force: true })
  return `已移除：${s.file}`
}
