/**
 * API keys never touch the database or a model's context: they live in the OS keychain (macOS Keychain, Linux Secret Service),
 * or, where no keychain is reachable (headless Linux, containers), in an AES-256-GCM file whose key sits beside it with mode 0600.
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

const SERVICE = 'super-agent'

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

export class MemorySecrets implements SecretStore {
  readonly backend = 'memory' as const
  private map = new Map<string, string>()
  get(ref: string) { return this.map.get(ref) }
  set(ref: string, value: string) { this.map.set(ref, value) }
  delete(ref: string) { this.map.delete(ref) }
}

/**
 * Picks the keychain when it answers a probe, otherwise the encrypted file. `SUPERAGENT_SECRETS=file|keychain` forces one.
 * Returns why the file store was chosen, for `superagent doctor`.
 */
export async function openSecretStore(home: string, prefer = process.env.SUPERAGENT_SECRETS): Promise<{ store: SecretStore; note?: string }> {
  const fileStore = () => new FileSecrets(join(home, 'secrets'))
  if (prefer === 'file') return { store: fileStore(), note: 'SUPERAGENT_SECRETS=file' }
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
