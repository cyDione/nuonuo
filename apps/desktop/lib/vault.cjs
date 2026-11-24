// Encrypted multi-server profile & refresh token store for the thin desktop client.
// Uses Electron `safeStorage` when explicitly provided and available (Windows/Linux, or macOS with NUONUO_MAC_KEYCHAIN=1),
// and otherwise encrypts refresh tokens with AES-256-GCM using a 32-byte key file (`vault.key`, mode 0600) beside `vault.json`.
// Plaintext refresh tokens never touch localStorage or unencrypted disk files.
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
const { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

function createVault(filePath, safeStorage) {
  const keyPath = join(dirname(filePath), 'vault.key')
  let cachedKey = null

  const canUseSafeStorage = () => Boolean(
    safeStorage
    && typeof safeStorage.isEncryptionAvailable === 'function'
    && safeStorage.isEncryptionAvailable(),
  )

  function readExistingFileKey() {
    if (cachedKey) return cachedKey
    if (!existsSync(keyPath)) return null
    try {
      try { chmodSync(keyPath, 0o600) } catch { /* Windows */ }
      const buf = readFileSync(keyPath)
      if (buf.length !== 32) return null
      cachedKey = buf
      return cachedKey
    } catch {
      return null
    }
  }

  function getOrCreateFileKey() {
    const existing = readExistingFileKey()
    if (existing) return existing
    if (existsSync(keyPath)) {
      throw new Error(`${keyPath} is not a 32-byte key`)
    }
    const key = randomBytes(32)
    mkdirSync(dirname(keyPath), { recursive: true })
    const tmp = `${keyPath}.tmp`
    writeFileSync(tmp, key, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* Windows */ }
    renameSync(tmp, keyPath)
    cachedKey = key
    return cachedKey
  }

  function readRaw() {
    if (!existsSync(filePath)) return { profiles: [], activeId: null, tokens: {} }
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      return {
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
        tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {},
      }
    } catch {
      return { profiles: [], activeId: null, tokens: {} }
    }
  }

  function writeRaw(data) {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* Windows */ }
    renameSync(tmp, filePath)
  }

  function seal(plaintext) {
    if (canUseSafeStorage()) {
      return { enc: 'safeStorage', data: safeStorage.encryptString(plaintext).toString('base64') }
    }
    const key = getOrCreateFileKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return {
      enc: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: ciphertext.toString('base64'),
    }
  }

  function unseal(record) {
    if (!record || typeof record.data !== 'string') return undefined
    try {
      if (record.enc === 'aes-256-gcm') {
        if (typeof record.iv !== 'string' || typeof record.tag !== 'string') return undefined
        const key = readExistingFileKey()
        if (!key) return undefined
        const iv = Buffer.from(record.iv, 'base64')
        const tag = Buffer.from(record.tag, 'base64')
        const body = Buffer.from(record.data, 'base64')
        if (iv.length !== 12 || tag.length !== 16) return undefined
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      }
      if (record.enc === 'safeStorage') {
        if (!canUseSafeStorage()) return undefined
        return safeStorage.decryptString(Buffer.from(record.data, 'base64'))
      }
      if (record.enc === 'plain') {
        return Buffer.from(record.data, 'base64').toString('utf8')
      }
    } catch {
      return undefined
    }
    return undefined
  }

  return {
    list() {
      const raw = readRaw()
      const backend = canUseSafeStorage() ? 'safeStorage' : 'aes-256-gcm'
      return { profiles: raw.profiles, activeId: raw.activeId, encryptionAvailable: true, backend }
    },
    save(profile, refreshToken) {
      const raw = readRaw()
      raw.profiles = [profile, ...raw.profiles.filter(p => p.id !== profile.id)]
      raw.activeId = profile.id
      if (typeof refreshToken === 'string' && refreshToken) {
        raw.tokens[profile.id] = seal(refreshToken)
      }
      writeRaw(raw)
    },
    getRefreshToken(profileId) {
      const raw = readRaw()
      return unseal(raw.tokens[profileId])
    },
    setActive(profileId) {
      const raw = readRaw()
      raw.activeId = profileId || null
      writeRaw(raw)
    },
    remove(profileId) {
      const raw = readRaw()
      raw.profiles = raw.profiles.filter(p => p.id !== profileId)
      delete raw.tokens[profileId]
      if (raw.activeId === profileId) raw.activeId = raw.profiles[0]?.id ?? null
      writeRaw(raw)
    },
  }
}

module.exports = { createVault }
