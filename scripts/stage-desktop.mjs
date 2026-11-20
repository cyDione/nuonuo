#!/usr/bin/env node
// Stages the thin Nuonuo desktop client:
//   apps/desktop/.stage/web      built static Web UI (apps/web/dist)
//   apps/desktop/build/icon.png  app icon for electron-builder
// No Node.js runtime or daemon is bundled — the desktop app connects remotely or deploys locally on demand.
// Usage: node scripts/stage-desktop.mjs   (run `pnpm build` at the repository root first)
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '../..')
const desktop = join(root, 'apps/desktop')
const webDist = join(root, 'apps/web/dist')
const webOut = join(desktop, '.stage/web')

if (!existsSync(join(webDist, 'index.html'))) {
  throw new Error('apps/web/dist/index.html is missing; run `pnpm build` at the repository root first.')
}

rmSync(join(desktop, '.stage'), { recursive: true, force: true })
mkdirSync(webOut, { recursive: true })
cpSync(webDist, webOut, { recursive: true })

mkdirSync(join(desktop, 'build'), { recursive: true })
copyFileSync(join(desktop, 'assets/icon.png'), join(desktop, 'build/icon.png'))

console.log(`staged thin desktop client web bundle in ${webOut}`)
