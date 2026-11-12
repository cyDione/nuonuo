/** Composition root: opens the data directory, the state database, the secret store and the model hub, and owns shutdown. */
import { pruneChats, pruneRuntime } from './data'
import { Notices } from './notices'
import { AgentRuntime, BrowserManager, Bus, findBrowser, McpManager, workerEnv, type McpServerConfig } from '@nuonuo/agent-runtime'
import { Skills, skillsExtension, accessExtension, LocalAccess, LocalApps, localAppsExtension, gatedSourceExtension, browserExtension, combineExtensions, Distiller, Feed, feedExtension, Goals, goalsExtension, Ideas, ideasContext, personaPrompt, Engine, Instructions, instructionsExtension, mcpExtension, Memory, memoryExtension, proactiveExtension, proactiveTool, registerAgents, Reviewer, sandboxApplies, sandboxExtension, expandHome, Screener, StructuredCallError, Watchdog } from '@nuonuo/core'
import { Effects, kvGet, kvSet, openStore, type Store } from '@nuonuo/db'
import { gmailPlugin, telegramPlugin } from '@nuonuo/plugins'
import { githubKind, PluginManager, Routines, routinesKind, SourceRegistry } from '@nuonuo/sources'
import { DECISION_KINDS, EnvAwareSecrets, ModelError, ModelHub, openSecretStore, type SecretStore } from '@nuonuo/models'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { ToolSet } from 'ai'
import type { DaemonConfig } from './config'

export interface Runtime {
  config: DaemonConfig
  store: Store
  /** 权限: folders and local apps the assistant may use. */
  access: LocalAccess
  /** Where the owner's attachments are kept. */
  uploadsDir: string
  /** 会做的事. */
  skills: Skills
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
  distiller: Distiller
  instructions: Instructions
  goals: Goals
  feed: Feed
  ideas: Ideas
  notices: Notices
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

export interface LockInfo { pid: number; port: number; startedAt: number; host?: string; desktop?: boolean }

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
    if (running && running.pid !== process.pid) throw new Error(`另一个 nuonuo 正在运行（pid ${running.pid}，端口 ${running.port}）`)
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: config.port, host: config.host, desktop: config.desktop, startedAt: Date.now() }))
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
    const ownMcp = () => kvGet<McpServerConfig[]>(store, 'settings:mcp') ?? []
    // Plugins' servers join the owner's; a name the owner already uses stays the owner's.
    const mcp = new McpManager(() => { const own = ownMcp(); const names = new Set(own.map(s => s.name)); return [...own, ...plugins.mcpServers().filter(s => !names.has(s.name))] }, agents.blobs)
    plugins.onChange = () => { void mcp.sync() }
    const engine = new Engine(store, agents, bus, { home: config.home, sources, screen: triggerId => effects.enqueue('proactive.screen', triggerId, { triggerId }) })
    const screener = new Screener(store, hub, engine)
    effects.handle<{ triggerId: string }>('proactive.screen', async ({ triggerId }) => {
      try { await screener.screen(triggerId) } catch (error) {
        // Without a usable filter model, or with a reply that cannot be read, a retry would not help (and would be billed
        // again); record it so the activity log says why. Failed calls (network, provider errors) are retried.
        if (error instanceof ModelError) { engine.proactiveDecision(triggerId, { act: false, reason: `没有可用的过滤模型：${error.message}` }, 'off'); return }
        if (error instanceof StructuredCallError && error.kind !== 'call') { engine.proactiveDecision(triggerId, { act: false, reason: error.message }, 'off'); return }
        throw error
      }
    }, { concurrency: 2, baseDelayMs: 10_000, maxDelayMs: 600_000 })
    const instructions = new Instructions(store)
    const goals = new Goals(store, Date.now, () => bus.emit({ type: 'goals.updated' }))
    const feed = new Feed(store, Date.now, () => bus.emit({ type: 'feed.updated' }))
    const ideas = new Ideas(store, hub, () => ideasContext(store, { goals, feed, memory }), Date.now, () => bus.emit({ type: 'ideas.updated' }))
    sources.engine = engine
    agents.options.maxWorkers = engine.execution().maxWorkers
    const reviewer = new Reviewer(store, hub, engine, agents, bus)
    reviewer.envFor = ticket => workerEnv({ NUONUO_TICKET: ticket.id, NUONUO_DIR: ticket.directory })
    const access = new LocalAccess(store)
    const skills = new Skills(store, Date.now, () => bus.emit({ type: 'skills.updated' }))
    plugins.useSkills(skills)
    reviewer.access = access
    reviewer.sandboxed = ticket => sandboxApplies(engine.execution().sandbox, ticket)
    const uploadsDir = join(config.home, 'uploads')
    /** What the sandbox mounts: the folders allowed in 权限 and the attachments (read-only); never-touch ones inside them are covered. */
    const sandboxFolders = () => {
      const s = access.settings()
      const mounts = [...s.folders.map(f => ({ path: expandHome(f.path), write: f.write })), { path: uploadsDir, write: false }].filter(m => existsSync(m.path))
      const hidden = [...s.locked, ...s.never].map(p => expandHome(p)).filter(p => existsSync(p) && mounts.some(m => p.startsWith(m.path + sep)))
      return { mounts, hidden }
    }
    const conversationTitle = (id: string) => store.sqlite.prepare('SELECT title FROM conversations WHERE id = ?').get(id) as { title: string } | undefined
    const memory = new Memory(store, config.home, { embedder: () => hub.embeddingModel(), label: scope => (scope.startsWith('cnv_') ? conversationTitle(scope)?.title : undefined) })
    memory.importLegacy()
    const distiller = new Distiller(store, hub, memory, cnv => engine.scopeOfThread(`webchat:${cnv}`))
    effects.handle<{ conversationId: string }>('memory.distill', async ({ conversationId }) => {
      try { await distiller.distill(conversationId) } catch (error) {
        // Not configured, out of budget, or an unreadable reply: retrying the same transcript would fail (and bill) again.
        if (error instanceof StructuredCallError && error.kind !== 'call') console.warn(`[memory.distill] ${error.message}`)
        else if (!(error instanceof ModelError)) throw error
      }
      await memory.embedPending().catch(() => 0)
    }, { concurrency: 1, baseDelayMs: 30_000, maxDelayMs: 900_000 })
    // The memory side path: once a conversation has been quiet for a while, distil what the owner said (debounced).
    bus.on(event => {
      if (event.type !== 'message.created') return
      const row = store.sqlite.prepare("SELECT conversation_id AS c, role, json_extract(meta, '$.source') AS s FROM messages WHERE id = ?").get(String(event.messageId)) as { c: string; role: string; s: string | null } | undefined
      if (row?.role === 'user' && (row.s ?? 'webchat') === 'webchat') store.atomic(() => effects.enqueue('memory.distill', row.c, { conversationId: row.c }, DISTILL_QUIET_MS))
    })
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
        const what = name === 'update_instructions' ? `灵魂（第 ${r.version} 版）` : `主动策略（第 ${r.version} 版）`
        const where = name === 'update_instructions' ? '右侧栏的「它是谁」' : '设置 → 助理 → 主动的策略'
        engine.reply({ conversationId: watchdog.conversation(), text: `我刚改了${what}。不同意的话告诉我，或者在${where}里恢复到上一版。` })
      }),
    })
    registerAgents(store, agents, engine, combineExtensions(
      gatedSourceExtension(combineExtensions(sources.agentExtensions(id => access.settings().sources[id] === 'read'), plugins.agentExtensions()), access, reviewer,
        () => new Set([...sources.askFirstTools(), ...plugins.askFirstTools()])),
      memoryExtension(memory, engine),
      { routerPrompt: () => personaPrompt(store) },
      instructionsExtension(instructions),
      goalsExtension(goals),
      feedExtension(feed),
      proactiveExtension(store, engine),
      browserExtension(browser, engine, agents),
      sandboxExtension(engine, sandboxFolders),
      accessExtension(access, uploadsDir),
      skillsExtension(skills),
      localAppsExtension(new LocalApps(access, reviewer)),
      mcpExtension(mcp, engine, reviewer),
      { gateShell: (ticket, sessionId, command, cwd) => reviewer.gateShell(ticket, sessionId, command, cwd) },
    ))
    watchdog.register()
    // A task that ended gives its browser tab back.
    bus.on(event => {
      if (event.type !== 'ticket.updated') return
      try { if (engine.ticket(String(event.ticketId)).ended) void browser.closePage(String(event.ticketId)) } catch { /* deleted */ }
    })
    const notices = new Notices(store, bus, { feed, ideas, reviewer, ticketConversation: id => { try { return engine.conversationOfTicket(id) } catch { return null } } })
    notices.register()
    let watchdogTimer: NodeJS.Timeout | undefined
    let memoryTimer: NodeJS.Timeout | undefined
    let ideasTimer: NodeJS.Timeout | undefined
    const browserPath = await findBrowser()
    return {
      ...(browserPath ? { browserPath } : {}),
      config, store, secrets, access, uploadsDir, skills, ...(note ? { secretsNote: note } : {}), hub, effects, bus, agents, engine, sources, routines, reviewer, memory, distiller, instructions, goals, feed, ideas, notices, screener, watchdog, browser, plugins, mcp, startedAt: Date.now(),
      startAgents() {
        engine.mainConversation()
        agents.recover(session => engine.recoveryNote(session.id, session.role))
        void plugins.loadEnabled().finally(() => sources.startAll())
        void mcp.sync()
        // Healing the main agent needs no model; the watchdog agent's judgement does.
        watchdogTimer = setInterval(() => { try { const healed = watchdog.healRouter() ?? null; if (hub.resolve('watchdog')) watchdog.tick(healed) } catch (e) { console.error('[watchdog]', e) } }, 60_000)
        // Nightly memory upkeep (expire episodes, merge duplicates); also on start when the last run is over a day old.
        const upkeep = () => {
          try { if (Date.now() - (kvGet<number>(store, 'memory:consolidated') ?? 0) > 20 * 3_600_000) { memory.consolidate(); kvSet(store, 'memory:consolidated', Date.now()) } } catch (e) { console.error('[memory]', e) }
          // 聊天记录保留 (设置 → 数据和隐私): older messages go, hourly.
          try { pruneChats(store, engine.mainConversation(), id => engine.tickets({ threadId: engine.threadOf(id), open: true }).length > 0) } catch (e) { console.error('[privacy]', e) }
          // The runtime's own leftovers (delivered inbox rows, old command output, spilled tool output).
          try { pruneRuntime(store) } catch (e) { console.error('[retention]', e) }
        }
        upkeep()
        memoryTimer = setInterval(upkeep, 3_600_000)
        void memory.embedPending().catch(() => 0)
        // 点子: a new batch each morning (or week), once a main model is set up.
        let thinking = false
        const think = () => {
          if (thinking || !hub.resolve('router') || !ideas.due()) return
          thinking = true
          void ideas.refresh().catch(e => { if (!(e instanceof StructuredCallError) || e.kind !== 'no_model') console.warn(`[ideas] ${(e as Error).message}`) }).finally(() => { thinking = false })
        }
        ideasTimer = setInterval(think, 15 * 60_000)
        setTimeout(think, 30_000).unref?.()
      },
      async close() {
        clearInterval(watchdogTimer)
        clearInterval(memoryTimer)
        clearInterval(ideasTimer)
        await mcp.close()
        await plugins.close()
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

/** How long a conversation stays quiet before its new messages are distilled into memory. */
const DISTILL_QUIET_MS = Number(process.env.NUONUO_DISTILL_DELAY_MS) || 120_000

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

/**
 * Registers providers for `*_API_KEY` variables. On first start (no layer configured yet), NUONUO_MODEL puts the layers on
 * that model of the first provider found in the environment; without it, they go on a model picked from that provider's
 * live list, in the background so a slow provider never holds up startup.
 */
export async function bootstrapModels(hub: ModelHub, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  hub.syncEnvProviders()
  const model = env.NUONUO_MODEL?.trim()
  const provider = hub.listProviders().find(p => p.keyEnv && p.hasKey && !DECISION_KINDS.includes(p.kind))
  if (!provider) return
  if (model) {
    if (hub.applyDefaultModel(provider.id, model)) console.log(`已将各层模型设为 ${provider.name} 的 ${model}（NUONUO_MODEL）`)
    return
  }
  void hub.applyLiveDefault(provider.id).then(picked => {
    if (picked) console.log(`已将各层模型设为 ${provider.name} 的 ${picked}（从供应商的实时模型列表选出，可在「设置 → 分层模型」更改）`)
  }, () => {})
}
