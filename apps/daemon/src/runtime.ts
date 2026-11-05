/** Composition root: opens the data directory, the state database, the secret store and the model hub, and owns shutdown. */
import { AgentRuntime, BrowserManager, Bus, findBrowser, McpManager, workerEnv, type McpServerConfig } from '@super-agent/agent-runtime'
import { browserExtension, combineExtensions, Engine, Instructions, instructionsExtension, mcpExtension, Memory, memoryExtension, proactiveExtension, proactiveTool, registerAgents, Reviewer, sandboxExtension, Screener, Watchdog } from '@super-agent/core'
import { Effects, kvGet, openStore, type Store } from '@super-agent/db'
import { gmailPlugin, telegramPlugin } from '@super-agent/plugins'
import { githubKind, PluginManager, Routines, routinesKind, SourceRegistry } from '@super-agent/sources'
import { EnvAwareSecrets, LAYER_PRESETS, ModelError, ModelHub, openSecretStore, type SecretStore } from '@super-agent/models'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolSet } from 'ai'
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
  reviewer: Reviewer
  memory: Memory
  instructions: Instructions
  screener: Screener
  watchdog: Watchdog
  browser: BrowserManager
  browserPath?: string
  plugins: PluginManager
  mcp: McpManager
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
    const sources = new SourceRegistry(store, effects, secrets)
    const routines = new Routines(store)
    sources.register(githubKind())
    sources.register(routinesKind(routines))
    const plugins = new PluginManager(join(config.home, 'plugins'), sources, store)
    plugins.registerBuiltIn(telegramPlugin)
    plugins.registerBuiltIn(gmailPlugin)
    const mcp = new McpManager(() => kvGet<McpServerConfig[]>(store, 'settings:mcp') ?? [], agents.blobs)
    const engine = new Engine(store, agents, bus, { home: config.home, sources, screen: triggerId => effects.enqueue('proactive.screen', triggerId, { triggerId }) })
    const screener = new Screener(store, hub, engine)
    effects.handle<{ triggerId: string }>('proactive.screen', async ({ triggerId }) => {
      try { await screener.screen(triggerId) } catch (error) {
        // Without a usable filter model there is nothing to retry; record it so the activity log says why.
        if (error instanceof ModelError) { engine.proactiveDecision(triggerId, { act: false, reason: `没有可用的过滤模型：${error.message}` }, 'off'); return }
        throw error
      }
    }, { concurrency: 2, baseDelayMs: 10_000, maxDelayMs: 600_000 })
    const instructions = new Instructions(store)
    sources.engine = engine
    agents.options.maxWorkers = engine.execution().maxWorkers
    const reviewer = new Reviewer(store, hub, engine, agents, bus)
    reviewer.envFor = ticket => workerEnv({ SUPERAGENT_TICKET: ticket.id, SUPERAGENT_DIR: ticket.directory })
    const memory = new Memory(config.home)
    const browser = new BrowserManager(join(config.home, 'browser-profile'))
    const watchdog = new Watchdog(store, agents, engine, {
      systemProblems: () => [
        ...effects.health().filter(h => h.failing > 0).map(h => `后台队列 ${h.kind} 连续失败：${h.lastError ?? ''}`),
        ...sources.list().filter(s => s.enabled && s.health.status === 'error').map(s => `来源 ${s.title} 出错：${s.health.detail ?? ''}`),
      ],
      // Online corrections take effect at once (article §6), but never silently: each one is announced to the owner with
      // how to undo it, so changes to prompts and trigger rules stay under the owner's control.
      correctionTools: () => announced({ ...instructions.tools('watchdog'), update_proactive: proactiveTool(store, 'watchdog', engine) }, (name, result) => {
        const r = result as { version?: number }
        const what = name === 'update_instructions' ? `说明（第 ${r.version} 版）` : `主动策略（第 ${r.version} 版）`
        const where = name === 'update_instructions' ? '设置 → 说明' : '设置 → 主动'
        engine.reply({ conversationId: watchdog.conversation(), text: `我刚改了${what}。不同意的话告诉我，或者在${where}里恢复到上一版。` })
      }),
    })
    registerAgents(store, agents, engine, combineExtensions(
      sources.agentExtensions(),
      memoryExtension(memory, engine),
      instructionsExtension(instructions),
      proactiveExtension(store, engine),
      browserExtension(browser, engine, agents),
      sandboxExtension(engine),
      mcpExtension(mcp, engine, reviewer),
      { gateShell: (ticket, sessionId, command, cwd) => reviewer.gateShell(ticket, sessionId, command, cwd) },
    ))
    watchdog.register()
    // A task that ended gives its browser tab back.
    bus.on(event => {
      if (event.type !== 'ticket.updated') return
      try { if (engine.ticket(String(event.ticketId)).ended) void browser.closePage(String(event.ticketId)) } catch { /* deleted */ }
    })
    let watchdogTimer: NodeJS.Timeout | undefined
    const browserPath = await findBrowser()
    return {
      ...(browserPath ? { browserPath } : {}),
      config, store, secrets, ...(note ? { secretsNote: note } : {}), hub, effects, bus, agents, engine, sources, routines, reviewer, memory, instructions, screener, watchdog, browser, plugins, mcp, startedAt: Date.now(),
      startAgents() {
        agents.recover(session => engine.recoveryNote(session.id, session.role))
        void plugins.loadEnabled().finally(() => sources.startAll())
        void mcp.sync()
        watchdogTimer = setInterval(() => { try { if (hub.resolve('watchdog')) watchdog.tick() } catch (e) { console.error('[watchdog]', e) } }, 60_000)
      },
      async close() {
        clearInterval(watchdogTimer)
        await mcp.close()
        await browser.close()
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

/** Calls `after` once a tool succeeded (ok !== false). */
function announced(tools: ToolSet, after: (name: string, result: unknown) => void): ToolSet {
  for (const [name, t] of Object.entries(tools)) {
    const run = t.execute
    if (!run) continue
    t.execute = async (input: any, options: any) => {
      const result = await run(input, options)
      if (!(result && typeof result === 'object' && (result as { ok?: boolean }).ok === false)) { try { after(name, result) } catch (e) { console.error('[watchdog] announce', e) } }
      return result
    }
  }
  return tools
}

/** Registers providers for `*_API_KEY` variables and, while no layer is configured, applies the DeepSeek preset. */
export async function bootstrapModels(hub: ModelHub): Promise<void> {
  hub.syncEnvProviders()
  const deepseek = hub.listProviders().find(p => p.kind === 'deepseek' && p.hasKey)
  if (!deepseek || Object.values(hub.roleConfigs()).some(c => c.chain.length > 0)) return
  // Gateways rename models; map the preset onto what this endpoint lists (best effort, offline keeps the official ids).
  const available = await hub.listModels(deepseek.id).catch(() => undefined)
  // SUPERAGENT_PRESET picks another layer setup (e.g. deepseek-flash: every layer on V4.1 Flash, for testing).
  const preset = process.env.SUPERAGENT_PRESET?.trim() || 'deepseek'
  if (hub.applyPreset(preset, deepseek.id, { onlyIfEmpty: true, ...(available ? { available } : {}) })) {
    console.log(`已为 ${deepseek.name}${deepseek.keyEnv ? `（${deepseek.keyEnv}）` : ''} 应用分层配置：${LAYER_PRESETS.find(p => p.id === preset)?.label ?? preset}`)
  }
}
