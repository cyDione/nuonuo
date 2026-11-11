import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string
vi.mock('node:os', async importOriginal => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => root }))
const { adoptLegacyEnv, migrateLegacyHome, resolveHome } = await import('./legacy')

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nuonuo-legacy-')) })
afterEach(() => { vi.restoreAllMocks() })

describe('legacy names', () => {
  it('adopts SUPER_ASSISTANT_* variables without overriding NUONUO_*', () => {
    const env: NodeJS.ProcessEnv = { SUPER_ASSISTANT_MODEL: 'm1', SUPER_ASSISTANT_PORT: '1', NUONUO_PORT: '2' }
    expect(adoptLegacyEnv(env)).toEqual(['NUONUO_MODEL'])
    expect(env).toMatchObject({ NUONUO_MODEL: 'm1', NUONUO_PORT: '2' })
  })

  it('keeps a custom SUPER_ASSISTANT_HOME but not the old default', () => {
    const custom: NodeJS.ProcessEnv = { SUPER_ASSISTANT_HOME: '/data/sa' }
    adoptLegacyEnv(custom)
    expect(custom.NUONUO_HOME).toBe('/data/sa')
    const def: NodeJS.ProcessEnv = { SUPER_ASSISTANT_HOME: join(root, '.super-assistant') }
    adoptLegacyEnv(def)
    expect(def.NUONUO_HOME).toBeUndefined()
  })

  it('uses the old data directory until it is moved, then the new one', () => {
    expect(resolveHome({})).toBe(join(root, '.nuonuo'))
    mkdirSync(join(root, '.super-assistant'))
    writeFileSync(join(root, '.super-assistant', 'token'), 't')
    expect(resolveHome({})).toBe(join(root, '.super-assistant'))
    // Old update helpers pass the old default explicitly; it does not pin the old path.
    expect(resolveHome({ NUONUO_HOME: join(root, '.super-assistant') })).toBe(join(root, '.super-assistant'))
    expect(migrateLegacyHome({}, 'linux')).toEqual({ moved: true, from: join(root, '.super-assistant'), to: join(root, '.nuonuo') })
    expect(readFileSync(join(root, '.nuonuo', 'token'), 'utf8')).toBe('t')
    expect(lstatSync(join(root, '.super-assistant')).isSymbolicLink()).toBe(true)
    expect(resolveHome({ NUONUO_HOME: join(root, '.super-assistant') })).toBe(join(root, '.nuonuo'))
    expect(migrateLegacyHome({}, 'linux')).toEqual({ moved: false })
  })

  it('leaves the old directory alone while an old service runs on it', () => {
    mkdirSync(join(root, '.super-assistant'))
    writeFileSync(join(root, '.super-assistant', 'daemon.json'), JSON.stringify({ pid: process.ppid, port: 7420 }))
    const result = migrateLegacyHome({}, 'linux')
    expect(result.moved).toBe(false)
    expect(existsSync(join(root, '.nuonuo'))).toBe(false)
  })

  it('does not move a custom data directory', () => {
    mkdirSync(join(root, '.super-assistant'))
    expect(migrateLegacyHome({ NUONUO_HOME: join(root, 'elsewhere') }, 'linux')).toEqual({ moved: false })
    expect(existsSync(join(root, '.super-assistant', '..', '.nuonuo'))).toBe(false)
  })
})
