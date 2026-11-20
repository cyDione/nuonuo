// OS-encrypted multi-server profile & refresh token store backed by Electron `safeStorage`.
// Refresh tokens are encrypted before hitting disk (mode 0600); plaintext never touches localStorage.
const { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')

function createVault(filePath, safeStorage) {
  const canEncrypt = () => Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable())

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
    writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    try { chmodSync(filePath, 0o600) } catch { /* Windows */ }
  }

  function seal(plaintext) {
    if (canEncrypt()) {
      return { enc: 'safeStorage', data: safeStorage.encryptString(plaintext).toString('base64') }
    }
    return { enc: 'plain', data: Buffer.from(plaintext, 'utf8').toString('base64') }
  }

  function unseal(record) {
    if (!record || typeof record.data !== 'string') return undefined
    try {
      if (record.enc === 'safeStorage') {
        if (!canEncrypt()) return undefined
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
      return { profiles: raw.profiles, activeId: raw.activeId, encryptionAvailable: canEncrypt() }
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
