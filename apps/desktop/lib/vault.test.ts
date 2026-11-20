import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS module
import { createVault } from './vault.cjs'

describe('desktop safeStorage vault', () => {
  it('encrypts refresh tokens on disk when safeStorage is available and supports multi-profile management', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuonuo-vault-'))
    const file = join(dir, 'vault.json')
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`ENC:${s}`, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8').replace(/^ENC:/, ''),
    }

    const vault = createVault(file, fakeSafeStorage)
    expect(vault.list()).toEqual({ profiles: [], activeId: null, encryptionAvailable: true })

    vault.save({ id: 'srv_1', name: 'Home', baseUrl: 'https://home.example.com', createdAt: 1 }, 'nnr_secret_refresh_token_1')
    vault.save({ id: 'srv_2', name: 'Office', baseUrl: 'https://office.example.com', createdAt: 2 }, 'nnr_secret_refresh_token_2')

    // Raw file must never contain plaintext refresh token.
    const rawDisk = readFileSync(file, 'utf8')
    expect(rawDisk).not.toContain('nnr_secret_refresh_token_1')
    expect(rawDisk).toContain('"enc": "safeStorage"')

    expect(vault.getRefreshToken('srv_1')).toBe('nnr_secret_refresh_token_1')
    expect(vault.getRefreshToken('srv_2')).toBe('nnr_secret_refresh_token_2')
    expect(vault.list().activeId).toBe('srv_2')

    vault.setActive('srv_1')
    expect(vault.list().activeId).toBe('srv_1')

    vault.remove('srv_1')
    expect(vault.getRefreshToken('srv_1')).toBeUndefined()
    expect(vault.list().profiles.map((p: any) => p.id)).toEqual(['srv_2'])
    expect(vault.list().activeId).toBe('srv_2')
  })
})
