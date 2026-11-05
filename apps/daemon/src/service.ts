/** Installs the daemon as a per-user service so it starts at login: launchd on macOS, a systemd user unit on Linux. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LABEL = 'dev.super-assistant.daemon'

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
  <key>EnvironmentVariables</key><dict><key>SUPER_ASSISTANT_HOME</key><string>${home}</string><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${home}/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>${home}/logs/daemon.log</string>
</dict></plist>
`
    return { file, content: plist, enable: ['launchctl', ['load', '-w', file]] as const, disable: ['launchctl', ['unload', '-w', file]] as const }
  }
  if (process.platform === 'linux') {
    const file = join(homedir(), '.config/systemd/user/super-assistant.service')
    const unit = `[Unit]
Description=Super-assistant personal daemon
After=network-online.target

[Service]
ExecStart=${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}
Environment=SUPER_ASSISTANT_HOME=${home}
# Tells the updater that systemd restarts this process after an update.
Environment=SUPER_ASSISTANT_SERVICE=1
Environment=PATH=${process.env.PATH}
Restart=on-failure
RestartSec=5
# A shutdown that hangs must not stall a systemctl restart for the 90s default.
TimeoutStopSec=15

[Install]
WantedBy=default.target
`
    return { file, content: unit, enable: ['systemctl', ['--user', 'enable', '--now', 'super-assistant.service']] as const,
      disable: ['systemctl', ['--user', 'disable', '--now', 'super-assistant.service']] as const }
  }
  throw new Error(`不支持的平台：${process.platform}（目前支持 macOS 与 Linux）`)
}

export function installService(entry: string, home: string, dryRun: boolean): string {
  const s = serviceFiles(entry, home)
  if (dryRun) return `${s.file}\n\n${s.content}`
  mkdirSync(join(s.file, '..'), { recursive: true })
  writeFileSync(s.file, s.content)
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
