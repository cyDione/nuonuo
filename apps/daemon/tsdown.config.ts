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
  noExternal: [/^@super-agent\//],
  external: [/^(?!@super-agent\/)[^./]/],
  hooks: {
    'build:done': () => {
      if (existsSync('../web/dist')) cpSync('../web/dist', 'dist/web', { recursive: true })
    },
  },
})
