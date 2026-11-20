import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectHost, isLoopback, loadEnvFile, networkUrls, readSavedConfig, resolveConfig, writeSavedConfig } from './config'

describe('loadEnvFile', () => {
  it('reads KEY=value lines without overriding the environment, and keeps the file private', () => {
    const home = mkdtempSync(join(tmpdir(), 'sa-env-'))
    writeFileSync(join(home, 'env'), '# keys\nOPENAI_API_KEY=sk-abc\nexport GITHUB_TOKEN="ghp_x"\nNUONUO_PORT=7999\nbad line\n', { mode: 0o644 })
    const env: NodeJS.ProcessEnv = { NUONUO_PORT: '7420' }
    expect(loadEnvFile(home, env)).toEqual(['OPENAI_API_KEY', 'GITHUB_TOKEN'])
    expect(env).toMatchObject({ OPENAI_API_KEY: 'sk-abc', GITHUB_TOKEN: 'ghp_x', NUONUO_PORT: '7420' })
    expect(statSync(join(home, 'env')).mode & 0o777).toBe(0o600)
    expect(loadEnvFile(mkdtempSync(join(tmpdir(), 'sa-env-')), env)).toEqual([])
  })
})

describe('resolveConfig', () => {
  const withHome = (saved?: object) => {
    const home = mkdtempSync(join(tmpdir(), 'sa-cfg-'))
    if (saved) writeFileSync(join(home, 'config.json'), JSON.stringify(saved))
    process.env.NUONUO_HOME = home
    delete process.env.NUONUO_HOST
    delete process.env.NUONUO_PORT
    delete process.env.NUONUO_WEB
    return home
  }

  it('defaults to headless API-only (web: false) and resolves host, port, and web by precedence flag > env > file > default', () => {
    withHome()
    expect(resolveConfig()).toMatchObject({
      host: '127.0.0.1',
      port: 7420,
      web: false,
      sources: { host: 'default', port: 'default', web: 'default' },
    })

    const home = withHome({ host: '0.0.0.0', port: 8080 })
    expect(resolveConfig()).toMatchObject({ host: '0.0.0.0', port: 8080, web: false, sources: { host: 'file', port: 'file', web: 'default' } })

    writeSavedConfig(home, { web: true })
    expect(readSavedConfig(home)).toEqual({ host: '0.0.0.0', port: 8080, web: true })
    expect(resolveConfig()).toMatchObject({ web: true, sources: { web: 'file' } })

    process.env.NUONUO_PORT = '9000'
    process.env.NUONUO_WEB = '0'
    expect(resolveConfig()).toMatchObject({ port: 9000, web: false, sources: { port: 'env', web: 'env' } })

    expect(resolveConfig({ host: '192.168.1.5', port: 9100, web: true })).toMatchObject({
      host: '192.168.1.5',
      port: 9100,
      web: true,
      sources: { host: 'flag', port: 'flag', web: 'flag' },
    })

    delete process.env.NUONUO_PORT
    delete process.env.NUONUO_WEB
    expect(() => resolveConfig({ host: 'bad host!' })).toThrow(/监听地址/)
    expect(() => writeSavedConfig(home, { port: 70000 })).toThrow(/端口/)
  })

  it('lists the addresses other devices use, and loopback for this machine', () => {
    expect(networkUrls('127.0.0.1', 7420)).toEqual([])
    expect(networkUrls('192.168.1.5', 7420)).toEqual(['http://192.168.1.5:7420'])
    expect(connectHost('0.0.0.0')).toBe('127.0.0.1')
    expect(connectHost('::1')).toBe('[::1]')
    expect(isLoopback('127.0.0.1') && !isLoopback('0.0.0.0')).toBe(true)
  })
})
