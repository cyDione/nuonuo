import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS module
import { createVault } from './vault.cjs'

describe('desktop encrypted vault', () => {
  it('encrypts refresh tokens on disk when safeStorage is available and supports multi-profile management', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuonuo-vault-'))
    const file = join(dir, 'vault.json')
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`ENC:${s}`, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8').replace(/^ENC:/, ''),
    }

    const vault = createVault(file, fakeSafeStorage)
    expect(vault.list()).toEqual({ profiles: [], activeId: null, encryptionAvailable: true, backend: 'safeStorage' })

    vault.save({ id: 'srv_1', name: 'Home', baseUrl: 'https://home.example.com', createdAt: 1 }, 'nnr_secret_refresh_token_1')
    vault.save({ id: 'srv_2', name: 'Office', baseUrl: 'https://office.example.com', createdAt: 2 }, 'nnr_secret_refresh_token_2')

    // Raw file must never contain plaintext refresh token, and no unused vault.key is created in safeStorage mode.
    const rawDisk = readFileSync(file, 'utf8')
    expect(rawDisk).not.toContain('nnr_secret_refresh_token_1')
    expect(rawDisk).toContain('"enc": "safeStorage"')
    expect(existsSync(join(dir, 'vault.key'))).toBe(false)

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

  it('encrypts refresh tokens with AES-256-GCM and a mode-0600 vault.key when safeStorage is disabled (macOS default)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuonuo-vault-gcm-'))
    const file = join(dir, 'vault.json')
    const keyFile = join(dir, 'vault.key')

    const vault = createVault(file, null)
    expect(vault.list()).toEqual({ profiles: [], activeId: null, encryptionAvailable: true, backend: 'aes-256-gcm' })
    expect(existsSync(keyFile)).toBe(false)

    vault.save({ id: 'srv_mac', name: 'Local', baseUrl: 'http://127.0.0.1:7420', createdAt: 10 }, 'nnr_mac_refresh_secret')

    expect(existsSync(keyFile)).toBe(true)
    expect(readFileSync(keyFile).length).toBe(32)
    if (process.platform !== 'win32') {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }

    const firstDisk = readFileSync(file, 'utf8')
    expect(firstDisk).not.toContain('nnr_mac_refresh_secret')
    expect(firstDisk).toContain('"enc": "aes-256-gcm"')

    // Re-saving the same token uses a fresh random IV so ciphertext changes.
    vault.save({ id: 'srv_mac', name: 'Local', baseUrl: 'http://127.0.0.1:7420', createdAt: 10 }, 'nnr_mac_refresh_secret')
    const secondDisk = readFileSync(file, 'utf8')
    expect(secondDisk).not.toBe(firstDisk)

    // Survives app restart (brand new vault instance reading vault.key + vault.json from disk).
    const reloaded = createVault(file, null)
    expect(reloaded.getRefreshToken('srv_mac')).toBe('nnr_mac_refresh_secret')
  })

  it('rejects tampered AES-256-GCM ciphertexts and safely skips legacy safeStorage records without calling Keychain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuonuo-vault-tamper-'))
    const file = join(dir, 'vault.json')

    const vault = createVault(file, null)
    vault.save({ id: 'srv_1', name: 'One', baseUrl: 'http://127.0.0.1:7420', createdAt: 1 }, 'nnr_valid_token')

    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    // Tamper with ciphertext byte
    const tampered = Buffer.from(parsed.tokens.srv_1.data, 'base64')
    tampered[0] ^= 0xff
    parsed.tokens.srv_1.data = tampered.toString('base64')
    // Inject legacy safeStorage + plain records
    parsed.tokens.srv_legacy_kc = { enc: 'safeStorage', data: Buffer.from('opaque-kc-blob').toString('base64') }
    parsed.tokens.srv_legacy_plain = { enc: 'plain', data: Buffer.from('nnr_plain_legacy', 'utf8').toString('base64') }
    writeFileSync(file, JSON.stringify(parsed, null, 2))

    const reloaded = createVault(file, null)
    expect(reloaded.getRefreshToken('srv_1')).toBeUndefined()
    expect(reloaded.getRefreshToken('srv_legacy_kc')).toBeUndefined()
    expect(reloaded.getRefreshToken('srv_legacy_plain')).toBe('nnr_plain_legacy')
  })

  it('guards main.cjs so macOS disables Chromium OSCrypt Keychain lookup by default', () => {
    const mainSource = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8')
    expect(mainSource).toContain("app.commandLine.appendSwitch('use-mock-keychain')")
    expect(mainSource).toContain("process.env.NUONUO_MAC_KEYCHAIN === '1'")
    expect(mainSource).not.toContain('createVault(vaultFile(), safeStorage)')
  })
})
