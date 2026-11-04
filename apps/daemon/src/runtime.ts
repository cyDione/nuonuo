/** Composition root: opens the data directory, the state database, the secret store and the model hub, and owns shutdown. */
import { Effects, openStore, type Store } from '@super-agent/db'
import { ModelHub, openSecretStore, type SecretStore } from '@super-agent/models'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DaemonConfig } from './config'

export interface Runtime {
  config: DaemonConfig
  store: Store
  secrets: SecretStore
  secretsNote?: string
  hub: ModelHub
  effects: Effects
  startedAt: number
  close(): Promise<void>
}

export interface LockInfo { pid: number; port: number; startedAt: number }

export function readLock(home: string): LockInfo | undefined {
  const file = join(home, 'daemon.json')
  if (!existsSync(file)) return undefined
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo
    process.kill(info.pid, 0)
    return info
  } catch {
    return undefined
  }
}

export async function createRuntime(config: DaemonConfig, options: { lock?: boolean } = {}): Promise<Runtime> {
  mkdirSync(config.home, { recursive: true, mode: 0o700 })
  for (const dir of ['work', 'blobs', 'memory', 'plugins', 'logs']) mkdirSync(join(config.home, dir), { recursive: true })
  const lockFile = join(config.home, 'daemon.json')
  if (options.lock !== false) {
    const running = readLock(config.home)
    if (running && running.pid !== process.pid) throw new Error(`另一个 superagent 正在运行（pid ${running.pid}，端口 ${running.port}）`)
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: config.port, startedAt: Date.now() }))
  }
  const store = openStore(join(config.home, 'state.db'))
  try {
    const { store: secrets, note } = await openSecretStore(config.home)
    const hub = new ModelHub(store, secrets)
    const effects = new Effects(store)
    return {
      config, store, secrets, ...(note ? { secretsNote: note } : {}), hub, effects, startedAt: Date.now(),
      async close() {
        await effects.drain()
        store.close()
        if (options.lock !== false && readLock(config.home)?.pid === process.pid) rmSync(lockFile, { force: true })
      },
    }
  } catch (error) {
    store.close()
    if (options.lock !== false) rmSync(lockFile, { force: true })
    throw error
  }
}
