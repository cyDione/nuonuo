import { cpSync, existsSync } from 'node:fs'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Workspace packages are bundled; npm dependencies (native better-sqlite3, keyring) stay external.
  noExternal: [/^@nuonuo\//],
  // Bare package names only: on Windows resolved sources are absolute paths like D:\…, which must stay bundled too.
  external: [/^(?!@nuonuo\/)(?![A-Za-z]:[\\/])[^./\\]/],
  hooks: {
    'build:done': () => {
      if (existsSync('../web/dist')) cpSync('../web/dist', 'dist/web', { recursive: true })
      // The plugin sandbox starts this file in its own process (packages/sources/src/plugin-sandbox.ts).
      cpSync('../../packages/sources/src/plugin-runner.mjs', 'dist/plugin-runner.mjs')
      cpSync('../../packages/sources/src/channel.mjs', 'dist/channel.mjs')
    },
  },
})
