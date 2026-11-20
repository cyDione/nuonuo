/**
 * API keys never touch the database or a model's context: they live in the OS keychain (Linux Secret Service, Windows Credential
 * Manager), or in an AES-256-GCM file whose key sits beside it with mode 0600 (macOS, headless Linux, containers).
 *
 * macOS uses the file by default. A Keychain item trusts the exact binary that created it, and the app's Node.js is ad-hoc signed:
 * every update, and the CLI's own `node`, is a different binary to the Keychain, so each read asked for the login password.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SecretStore {
  readonly backend: 'keychain' | 'file' | 'memory'
  get(ref: string): string | undefined
  set(ref: string, value: string): void
  delete(ref: string): void
}

const SERVICE = 'nuonuo'
/** The keychain service name before the project was renamed to nuonuo; keys saved under it move over on first read. */
const LEGACY_SERVICE = 'super-assistant'

export type KeychainEntryCtor = new (service: string, account: string) => {
  getPassword(): string | null | undefined
  setPassword(v: string): void
  deletePassword(): boolean | void
}

export class KeychainSecrets implements SecretStore {
  readonly backend = 'keychain' as const
  constructor(private Entry: KeychainEntryCtor, private moveLegacy = true) {}
  get(ref: string) {
    try { return this.getOrThrow(ref) } catch { return undefined }
  }
  /**
   * Reads from the Keychain without swallowing permission-denial or locked-keychain errors,
   * allowing `KeychainMigratingSecrets` to trip its circuit breaker after a single denied prompt.
   */
  getOrThrow(ref: string): string | undefined {
    const value = this.entry(ref).getPassword() ?? undefined
    return value ?? this.adoptLegacyOrThrow(ref)
  }
  set(ref: string, value: string) { this.entry(ref).setPassword(value) }
  delete(ref: string) { try { this.entry(ref).deletePassword() } catch { /* already absent */ } }
  private entry(ref: string) { return new this.Entry(SERVICE, ref) }
  /** A key saved by a version from before the rename: copied to the new name, then removed from the old one. */
  private adoptLegacyOrThrow(ref: string): string | undefined {
    const old = new this.Entry(LEGACY_SERVICE, ref)
    const value = old.getPassword() ?? undefined
    if (value === undefined || !this.moveLegacy) return value
    try { this.set(ref, value) } catch { /* best effort */ }
    try { old.deletePassword() } catch { /* best effort */ }
    return value
  }
}

/** Encrypted file store. It protects against casual reads and synced backups of `secrets.enc`, not against code running as you. */
export class FileSecrets implements SecretStore {
  readonly backend = 'file' as const
  private key: Buffer
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    const keyFile = join(dir, 'master.key')
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 })
    chmodSync(keyFile, 0o600)
    this.key = readFileSync(keyFile)
    if (this.key.length !== 32) throw new Error(`${keyFile} is not a 32-byte key`)
  }
  get(ref: string) { return this.read()[ref] }
  set(ref: string, value: string) { this.write({ ...this.read(), [ref]: value }) }
  delete(ref: string) { const all = this.read(); delete all[ref]; this.write(all) }

  private get file() { return join(this.dir, 'secrets.enc') }
  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {}
    const raw = readFileSync(this.file)
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'))
  }
  private write(all: Record<string, string>) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(all), 'utf8'), cipher.final()])
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

/**
 * The file store, reading through to the Keychain for a key it does not have yet: keys saved there by earlier versions move into the
 * file the first time they are read (the Keychain may ask once per key), and later reads never touch the Keychain again.
 *
 * Checked refs and any permission denial (`aborted: true`) are persisted in `migrated.json` (mode 0600) so restarts never re-prompt
 * and a single "Deny" click immediately halts all further Keychain lookups.
 */
export class KeychainMigratingSecrets implements SecretStore {
  readonly backend = 'file' as const
  private tried = new Set<string>()
  private aborted = false
  constructor(private file: FileSecrets, private keychain: KeychainSecrets) {
    this.loadState()
  }
  get(ref: string) {
    const own = this.file.get(ref)
    if (own !== undefined || this.aborted || this.tried.has(ref)) return own
    this.tried.add(ref)
    let old: string | undefined
    try {
      old = this.keychain.getOrThrow(ref)
    } catch {
      this.aborted = true
      this.saveState()
      return undefined
    }
    this.saveState()
    // The Keychain copy stays: deleting it would ask for the password a second time.
    if (old !== undefined) this.file.set(ref, old)
    return old
  }
  set(ref: string, value: string) {
    const had = this.tried.has(ref)
    this.tried.add(ref)
    if (!had) this.saveState()
    this.file.set(ref, value)
  }
  delete(ref: string) {
    const had = this.tried.has(ref)
    this.tried.add(ref)
    if (!had) this.saveState()
    this.file.delete(ref)
  }

  private get stateFile() { return join(this.file.dir, 'migrated.json') }
  private loadState() {
    if (!existsSync(this.stateFile)) return
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { tried?: unknown; aborted?: unknown }
      if (Array.isArray(parsed.tried)) {
        for (const item of parsed.tried) if (typeof item === 'string') this.tried.add(item)
      }
      if (parsed.aborted === true) this.aborted = true
    } catch { /* ignore malformed state file */ }
  }
  private saveState() {
    try {
      mkdirSync(this.file.dir, { recursive: true })
      const payload = JSON.stringify({ tried: [...this.tried], ...(this.aborted ? { aborted: true } : {}) })
      const tmp = `${this.stateFile}.tmp`
      writeFileSync(tmp, payload, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.stateFile)
    } catch { /* best effort */ }
  }
}

export class MemorySecrets implements SecretStore {
  readonly backend = 'memory' as const
  private map = new Map<string, string>()
  get(ref: string) { return this.map.get(ref) }
  set(ref: string, value: string) { this.map.set(ref, value) }
  delete(ref: string) { this.map.delete(ref) }
}

/**
 * Picks the keychain when it answers a probe, otherwise the encrypted file; on macOS, the encrypted file (see the top of this file).
 * `NUONUO_SECRETS=file|keychain` forces one. Returns why the file store was chosen, for `nuonuo doctor`.
 */
export async function openSecretStore(
  home: string,
  prefer = process.env.NUONUO_SECRETS,
  platform = process.platform,
  loadKeyring: () => Promise<{ Entry: KeychainEntryCtor }> = () => import('@napi-rs/keyring'),
): Promise<{ store: SecretStore; note?: string }> {
  const secretsDir = join(home, 'secrets')
  const fileStore = () => new FileSecrets(secretsDir)
  if (prefer === 'file') return { store: fileStore(), note: 'NUONUO_SECRETS=file' }
  if (platform === 'darwin' && prefer !== 'keychain') {
    const note = 'macOS 上默认用加密文件，避免钥匙串每次启动都要密码（NUONUO_SECRETS=keychain 可改回，NUONUO_SECRETS=migrate-keychain 可迁移旧钥匙串密钥）'
    if (prefer !== 'migrate-keychain') {
      return { store: fileStore(), note }
    }
    try {
      // Explicit opt-in migration only: no probe here, as writing a probe item another binary created would ask for the password.
      const { Entry } = await loadKeyring()
      return { store: new KeychainMigratingSecrets(fileStore(), new KeychainSecrets(Entry, false)), note }
    } catch { return { store: fileStore(), note } }
  }
  try {
    const { Entry } = await loadKeyring()
    const probe = new Entry(SERVICE, '__probe__')
    probe.setPassword('ok')
    const ok = probe.getPassword() === 'ok'
    probe.deletePassword()
    if (ok) return { store: new KeychainSecrets(Entry) }
    throw new Error('keychain probe returned a different value')
  } catch (error) {
    if (prefer === 'keychain') throw error
    return { store: fileStore(), note: `keychain unavailable: ${error instanceof Error ? error.message : String(error)}` }
  }
}
