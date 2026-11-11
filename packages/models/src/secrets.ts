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

const SERVICE = 'super-assistant'

export class KeychainSecrets implements SecretStore {
  readonly backend = 'keychain' as const
  constructor(private Entry: new (service: string, account: string) => {
    getPassword(): string | null | undefined; setPassword(v: string): void; deletePassword(): boolean | void
  }) {}
  get(ref: string) {
    try { return this.entry(ref).getPassword() ?? undefined } catch { return undefined }
  }
  set(ref: string, value: string) { this.entry(ref).setPassword(value) }
  delete(ref: string) { try { this.entry(ref).deletePassword() } catch { /* already absent */ } }
  private entry(ref: string) { return new this.Entry(SERVICE, ref) }
}

/** Encrypted file store. It protects against casual reads and synced backups of `secrets.enc`, not against code running as you. */
export class FileSecrets implements SecretStore {
  readonly backend = 'file' as const
  private key: Buffer
  constructor(private dir: string) {
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
 */
export class KeychainMigratingSecrets implements SecretStore {
  readonly backend = 'file' as const
  private tried = new Set<string>()
  constructor(private file: FileSecrets, private keychain: KeychainSecrets) {}
  get(ref: string) {
    const own = this.file.get(ref)
    if (own !== undefined || this.tried.has(ref)) return own
    this.tried.add(ref)
    const old = this.keychain.get(ref)
    // The Keychain copy stays: deleting it would ask for the password a second time.
    if (old !== undefined) this.file.set(ref, old)
    return old
  }
  set(ref: string, value: string) { this.tried.add(ref); this.file.set(ref, value) }
  delete(ref: string) { this.tried.add(ref); this.file.delete(ref) }
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
 * `SUPER_ASSISTANT_SECRETS=file|keychain` forces one. Returns why the file store was chosen, for `super-assistant doctor`.
 */
export async function openSecretStore(home: string, prefer = process.env.SUPER_ASSISTANT_SECRETS, platform = process.platform): Promise<{ store: SecretStore; note?: string }> {
  const fileStore = () => new FileSecrets(join(home, 'secrets'))
  if (prefer === 'file') return { store: fileStore(), note: 'SUPER_ASSISTANT_SECRETS=file' }
  if (platform === 'darwin' && prefer !== 'keychain') {
    const note = 'macOS 上默认用加密文件，避免钥匙串每次启动都要密码（SUPER_ASSISTANT_SECRETS=keychain 可改回）'
    try {
      // No probe here: writing a probe item another binary created would itself ask for the password.
      const { Entry } = await import('@napi-rs/keyring')
      return { store: new KeychainMigratingSecrets(fileStore(), new KeychainSecrets(Entry)), note }
    } catch { return { store: fileStore(), note } }
  }
  try {
    const { Entry } = await import('@napi-rs/keyring')
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
