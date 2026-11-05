import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnvFile } from './config'

describe('loadEnvFile', () => {
  it('reads KEY=value lines without overriding the environment, and keeps the file private', () => {
    const home = mkdtempSync(join(tmpdir(), 'sa-env-'))
    writeFileSync(join(home, 'env'), '# keys\nOPENAI_API_KEY=sk-abc\nexport GITHUB_TOKEN="ghp_x"\nSUPER_ASSISTANT_PORT=7999\nbad line\n', { mode: 0o644 })
    const env: NodeJS.ProcessEnv = { SUPER_ASSISTANT_PORT: '7420' }
    expect(loadEnvFile(home, env)).toEqual(['OPENAI_API_KEY', 'GITHUB_TOKEN'])
    expect(env).toMatchObject({ OPENAI_API_KEY: 'sk-abc', GITHUB_TOKEN: 'ghp_x', SUPER_ASSISTANT_PORT: '7420' })
    expect(statSync(join(home, 'env')).mode & 0o777).toBe(0o600)
    expect(loadEnvFile(mkdtempSync(join(tmpdir(), 'sa-env-')), env)).toEqual([])
  })
})
