import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const { blocker, macScript, winScript } = createRequire(import.meta.url)('./update.cjs') as {
  blocker(o: { platform: string; exe: string; packaged: boolean }): string | null
  macScript(o: Record<string, unknown>): string
  winScript(o: Record<string, unknown>): string
}

describe('blocker', () => {
  it('refuses a dev build, an app run from the dmg or translocated, and systems without an installer', () => {
    expect(blocker({ platform: 'darwin', exe: '/x/Nuonuo.app/Contents/MacOS/Nuonuo', packaged: false })).toMatch(/开发版/)
    expect(blocker({ platform: 'darwin', exe: '/Volumes/Nuonuo/Nuonuo.app/Contents/MacOS/Nuonuo', packaged: true })).toMatch(/应用程序/)
    expect(blocker({ platform: 'darwin', exe: '/private/var/folders/x/AppTranslocation/y/d/Nuonuo.app/Contents/MacOS/Nuonuo', packaged: true })).toMatch(/应用程序/)
    expect(blocker({ platform: 'win32', exe: 'C:\\x\\Nuonuo.exe', packaged: true })).toBeNull()
    expect(blocker({ platform: 'linux', exe: '/opt/x', packaged: true })).toMatch(/不支持/)
    const apps = mkdtempSync(join(tmpdir(), 'sa-apps-'))
    expect(blocker({ platform: 'darwin', exe: join(apps, 'Nuonuo.app/Contents/MacOS/Nuonuo'), packaged: true })).toBeNull()
  })
})

describe('Windows helper', () => {
  it('runs the installer silently and quotes paths for PowerShell', () => {
    const script = winScript({ appPid: 1, daemonPid: 2, staged: "C:\\Users\\o'k\\setup.exe", exe: 'C:\\a\\Nuonuo.exe', resources: 'C:\\a\\resources', home: 'C:\\h', relaunch: true, restartDaemon: true })
    expect(script).toContain("$setup = 'C:\\Users\\o''k\\setup.exe'")
    expect(script).toContain("-ArgumentList '/S', '--updated' -Wait")
    expect(script).toContain('if ($true) {\n  Start-Process -FilePath $exe')
  })
})

describe.skipIf(process.platform === 'win32')('macOS helper', () => {
  it('waits for the app, stops the service, swaps the app in, clears quarantine and starts the new service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sa-mac-'))
    const bin = join(root, 'bin'), dest = join(root, 'Applications/Nuonuo.app'), home = join(root, 'home')
    const staged = join(home, 'updates/v9/app/Nuonuo.app')
    for (const d of [bin, join(dest, 'Contents'), join(staged, 'Contents/Resources/node'), join(staged, 'Contents/Resources/daemon'), join(home, 'logs')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(dest, 'v'), 'old'); writeFileSync(join(staged, 'v'), 'new')
    const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
    stub('ditto', 'cp -R "$1" "$2"'); stub('xattr', `echo "$@" >> ${root}/xattr`); stub('open', `echo "$@" >> ${root}/open`)
    writeFileSync(join(staged, 'Contents/Resources/node/node'), `#!/bin/sh\necho "$@" > ${root}/started\n`); chmodSync(join(staged, 'Contents/Resources/node/node'), 0o755)
    const app = spawn('sleep', ['30']), daemon = spawn('sleep', ['30'])
    const file = join(root, 'h.sh')
    writeFileSync(file, macScript({ appPid: app.pid, daemonPid: daemon.pid, staged, bundle: dest, home, relaunch: false, restartDaemon: true }))
    setTimeout(() => app.kill(), 300)
    const done = await new Promise<number | null>(resolve => spawn('bash', [file], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' }).on('exit', resolve))
    expect(done).toBe(0)
    expect(readFileSync(join(dest, 'v'), 'utf8')).toBe('new')
    expect(existsSync(`${dest}.old`) || existsSync(`${dest}.new`) || existsSync(join(home, 'updates'))).toBe(false)
    expect(readFileSync(join(root, 'xattr'), 'utf8')).toContain(`-dr com.apple.quarantine ${dest}`)
    expect(daemon.exitCode !== null || daemon.signalCode !== null).toBe(true)
    await new Promise(r => setTimeout(r, 300))
    expect(readFileSync(join(root, 'started'), 'utf8')).toContain('daemon/cli.mjs start --no-open --desktop')
    expect(existsSync(join(root, 'open'))).toBe(false)
    expect(spawnSync('bash', ['-n', file]).status).toBe(0)
  })
})
