import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '..')

export default defineConfig({
  resolve: {
    alias: {
      '@nuonuo/db': resolve(root, 'packages/db/src/index.ts'),
      '@nuonuo/models': resolve(root, 'packages/models/src/index.ts'),
      '@nuonuo/agent-runtime': resolve(root, 'packages/agent-runtime/src/index.ts'),
      '@nuonuo/core': resolve(root, 'packages/core/src/index.ts'),
      '@nuonuo/sources': resolve(root, 'packages/sources/src/index.ts'),
      '@nuonuo/plugin-sdk': resolve(root, 'packages/plugin-sdk/src/index.ts'),
      '@nuonuo/plugins': resolve(root, 'packages/plugins/src/index.ts'),
    },
  },
  test: {
    include: ['evals/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
  },
})
