#!/usr/bin/env node
// Stages everything the desktop app packs besides its own code, for the platform and CPU this runs on:
//   apps/desktop/.stage/daemon   the service (bundled CLI, web UI, production node_modules)
//   apps/desktop/.stage/node     a Node.js runtime (node or node.exe), so the app needs nothing installed
//   apps/desktop/build/icon.png  the app icon, drawn by lib/icon.cjs (electron-builder makes .icns/.ico from it)
// Usage: node scripts/stage-desktop.mjs   (run `pnpm build` at the repository root first)
// Native modules are installed for the machine running this, so build each platform/CPU on its own machine.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '../..')
const desktop = join(root, 'apps/desktop')
const stage = join(desktop, '.stage')
const platform = process.platform
const arch = process.env.SUPER_ASSISTANT_ARCH || process.arch
const nodeVersion = process.env.NODE_VERSION || process.versions.node
const win = platform === 'win32'

// 1. The service. Relative paths keep this working under Git Bash on Windows.
execFileSync('bash', ['scripts/stage-daemon.sh', 'apps/desktop/.stage/daemon'], { cwd: root, stdio: 'inherit' })

// Native prebuilds for other systems are dead weight in an installer.
const sqlite = join(stage, 'daemon/node_modules/better-sqlite3')
const keep = `${platform}-${arch}.node`
if (existsSync(join(sqlite, 'prebuilds'))) {
  for (const file of readdirSync(join(sqlite, 'prebuilds'))) if (file !== keep) rmSync(join(sqlite, 'prebuilds', file), { force: true })
  if (!existsSync(join(sqlite, 'prebuilds', keep))) throw new Error(`better-sqlite3 has no prebuild for ${keep}`)
  for (const dir of ['build', 'deps', 'src']) rmSync(join(sqlite, dir), { recursive: true, force: true })
}

// 2. Node.js, the same version the service was built and tested with.
const dist = `node-v${nodeVersion}-${win ? 'win' : platform}-${arch}`
const archive = `${dist}.${win ? 'zip' : 'tar.gz'}`
const work = join(stage, '.node-download')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const url = `https://nodejs.org/dist/v${nodeVersion}/${archive}`
console.log(`downloading ${url}`)
const res = await fetch(url)
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
writeFileSync(join(work, archive), Buffer.from(await res.arrayBuffer()))
// Windows' own tar (bsdtar) reads zip files; Git Bash's GNU tar, earlier on PATH, does not.
const tar = win ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
execFileSync(tar, ['-xf', archive], { cwd: work, stdio: 'inherit' })
const nodeOut = join(stage, 'node')
rmSync(nodeOut, { recursive: true, force: true })
mkdirSync(nodeOut, { recursive: true })
const exe = win ? 'node.exe' : 'node'
copyFileSync(join(work, dist, win ? exe : `bin/${exe}`), join(nodeOut, exe))
copyFileSync(join(work, dist, 'LICENSE'), join(nodeOut, 'LICENSE.node'))
rmSync(work, { recursive: true, force: true })

// 3. The icon.
const { iconPng } = createRequire(import.meta.url)(join(desktop, 'lib/icon.cjs'))
mkdirSync(join(desktop, 'build'), { recursive: true })
writeFileSync(join(desktop, 'build/icon.png'), iconPng(1024))

console.log(`staged the desktop app for ${platform}-${arch} (Node.js ${nodeVersion})`)
