/** Composition root: opens the data directory, the state database, the secret store and the model hub, and owns shutdown. */
import { AgentRuntime, Bus } from '@super-agent/agent-runtime'
import { Engine, registerAgents } from '@super-agent/core'
import { Effects, openStore, type Store } from '@super-agent/db'
import { githubKind, Routines, routinesKind, SourceRegistry } from '@super-agent/sources'
import { EnvAwareSecrets, ModelHub, openSecretStore, type SecretStore } from '@super-agent/models'
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
  bus: Bus
  agents: AgentRuntime
  engine: Engine
  sources: SourceRegistry
  routines: Routines
  /** Starts agent turns: recovery of interrupted sessions and anything queued. */
  startAgents(): void
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
    const { store: base, note } = await openSecretStore(config.home)
    const secrets = new EnvAwareSecrets(base)
    const hub = new ModelHub(store, secrets)
    await bootstrapModels(hub)
    const effects = new Effects(store)
    const bus = new Bus()
    const agents = new AgentRuntime(store, hub, bus)
    const sources = new SourceRegistry(store, effects)
    const routines = new Routines(store)
    sources.register(githubKind())
    sources.register(routinesKind(routines))
    const engine = new Engine(store, agents, bus, { home: config.home, sources })
    sources.engine = engine
    agents.options.maxWorkers = engine.execution().maxWorkers
    registerAgents(store, agents, engine, sources.agentExtensions())
    return {
      config, store, secrets, ...(note ? { secretsNote: note } : {}), hub, effects, bus, agents, engine, sources, routines, startedAt: Date.now(),
      startAgents() {
        agents.recover(session => engine.recoveryNote(session.id, session.role))
        sources.startAll()
      },
      async close() {
        await sources.stopAll()
        await agents.shutdown()
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

/** Registers providers for `*_API_KEY` variables and, while no layer is configured, applies the DeepSeek preset. */
export async function bootstrapModels(hub: ModelHub): Promise<void> {
  hub.syncEnvProviders()
  const deepseek = hub.listProviders().find(p => p.kind === 'deepseek' && p.hasKey)
  if (!deepseek || Object.values(hub.roleConfigs()).some(c => c.chain.length > 0)) return
  // Gateways rename models; map the preset onto what this endpoint lists (best effort, offline keeps the official ids).
  const available = await hub.listModels(deepseek.id).catch(() => undefined)
  if (hub.applyPreset('deepseek', deepseek.id, { onlyIfEmpty: true, ...(available ? { available } : {}) })) {
    console.log(`已为 ${deepseek.name}${deepseek.keyEnv ? `（${deepseek.keyEnv}）` : ''} 应用 DeepSeek 推荐分层配置`)
  }
}
