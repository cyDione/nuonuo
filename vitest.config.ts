import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/daemon/src/**/*.test.ts', 'apps/desktop/lib/**/*.test.ts'],
    environment: 'node',
  },
})
