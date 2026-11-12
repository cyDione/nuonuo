/**
 * Third-party plugins: a folder in `<home>/plugins/` with a package.json whose `nuonuo.plugin` names an ES module.
 * The manifest is read to list the plugin; its code runs only once the owner enables it (plugins run with the daemon's
 * own rights, so enabling one is a decision of trust). The module's default export is a plugin object or a function that
 * receives the SDK, so a plugin needs no dependencies of its own.
 */
import type { McpServerConfig } from '@nuonuo/agent-runtime'
import type { AgentExtensions, SkillInput, Skills } from '@nuonuo/core'
import { kvGet, kvSet, schema, type Store } from '@nuonuo/db'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { appToken, oauth } from './auth.mjs'
import { ChannelError, makeDefineChannel } from './channel.mjs'
import type { SourceKind } from './kind'
import { installDependencies } from './plugin-deps'
import { fetchPlugin, parseOrigin } from './plugin-install'
import { PluginSandbox, sandboxWanted } from './plugin-sandbox'
import type { SourceRegistry } from './registry'

export interface NuonuoPlugin {
  id: string
  name?: string
  version?: string
  description?: string
  sources?: SourceKind[]
  /**
   * MCP servers the plugin brings. They join the owner's own servers under the name `<plugin id>_<name>`; a stdio server
   * starts in the plugin's folder, and worker calls always pass the review layer.
   */
  mcpServers?: PluginMcpServer[]
  /**
   * Tools for the agents that need no source. Names must start with `<plugin id>_`; tools listed in `writes` are asked
   * about before every call.
   */
  routerTools?(ctx: PluginContext): ToolSet
  workerTools?(ctx: PluginContext): ToolSet
  writes?: string[]
  /** Text added to the main agent's or the workers' prompt while the plugin is on. */
  routerPrompt?: string | ((ctx: PluginContext) => string | undefined)
  workerPrompt?: string | ((ctx: PluginContext) => string | undefined)
  /**
   * Context for the main agent's next turn, worked out from the owner's new message(s) in the batch. It is appended to
   * that input (after the recalled memories), not to the system prompt, so it can change every turn without breaking the
   * prompt cache. Called only for batches that carry a request; it must answer fast (a slow or failing answer is skipped)
   * and is clipped to 2,000 characters.
   */
  inlineContext?(ctx: PluginContext, input: PluginTurnInput): string | undefined | Promise<string | undefined>
  /** Procedures (会做的事) the plugin brings. They arrive switched off, for the owner to turn on in 它是谁. */
  skills?: SkillInput[]
}

/** What a plugin's own tools and prompts receive. */
export interface PluginContext {
  id: string
  /** The plugin's folder. */
  dir: string
  /** The plugin's small persistent state. */
  state: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
  log(...args: unknown[]): void
}

/** What `inlineContext` sees of the turn. */
export interface PluginTurnInput {
  /** The text of the new message(s) the main agent is about to answer. */
  text: string
  /** The project they belong to (a side chat, a repository), when there is one. */
  scope?: string
}

/** How long the main agent waits for a plugin's turn context before going on without it. */
export const INLINE_CONTEXT_TIMEOUT = 1_500
const INLINE_CONTEXT_LIMIT = 2_000

export interface PluginMcpServer {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Which agents get the tools; defaults to the workers only. */
  roles?: ('worker' | 'router')[]
}

type PluginModuleText = string | ((ctx: PluginContext) => string | undefined) | undefined

export const PLUGIN_API_VERSION = 1
export const definePlugin = <T extends NuonuoPlugin>(plugin: T): T => plugin

/** Everything a plugin may use from the host, passed to its factory. */
export const defineChannel = makeDefineChannel(z)
export const sdk = { apiVersion: PLUGIN_API_VERSION, definePlugin, defineChannel, ChannelError, oauth, appToken, tool, jsonSchema, z }
export type PluginSdk = typeof sdk
export type PluginModule = NuonuoPlugin | ((sdk: PluginSdk) => NuonuoPlugin | Promise<NuonuoPlugin>)

export interface PluginManifest { id: string; name: string; version: string; description: string; dir: string; entry: string; apiVersion: number }

export interface PluginInfo extends PluginManifest {
  enabled: boolean
  loaded: boolean
  builtIn: boolean
  sources: string[]
  /** Names of the MCP servers it adds (as they appear in the MCP list). */
  mcpServers: string[]
  /** Names of its own tools and skills. */
  tools: string[]
  skills: string[]
  /** What installing its dependencies left to say (install scripts not run, optional ones skipped). */
  notes?: string[]
  /** Where it was installed from, when it was installed through the app (so it can be updated). */
  origin?: string
  error?: string
}

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/

export class PluginManager {
  private loaded = new Map<string, { plugin: NuonuoPlugin; manifest: PluginManifest }>()
  private errors = new Map<string, string>()
  private builtIns = new Map<string, NuonuoPlugin>()

  /** Called after plugins load or unload, so the MCP list can pick up their servers. */
  onChange?: () => void

  private skills: Skills | undefined
  private fetchImpl: typeof fetch
  private sandboxes = new Map<string, PluginSandbox>()
  /** Whether third-party plugins run in their own restricted process (see plugin-sandbox.ts). */
  readonly sandboxed: boolean

  constructor(private dir: string, private registry: SourceRegistry, private store: Store, opts: { fetch?: typeof fetch; skills?: Skills; sandbox?: boolean } | typeof fetch = {}) {
    const o = typeof opts === 'function' ? { fetch: opts } : opts
    this.fetchImpl = o.fetch ?? fetch
    this.sandboxed = o.sandbox ?? sandboxWanted()
    if (o.skills) this.useSkills(o.skills)
  }

  /** Where plugins' skills go (会做的事). */
  useSkills(skills: Skills): void {
    this.skills = skills
    skills.pluginActive = id => this.loaded.has(id)
  }

  private context(manifest: PluginManifest): PluginContext {
    const key = (k: string) => `plugin:${manifest.id}:state:${k}`
    return { id: manifest.id, dir: manifest.dir, log: (...args) => console.log(`[plugin ${manifest.id}]`, ...args),
      state: { get: <T>(k: string) => kvGet<T>(this.store, key(k)), set: (k, v) => kvSet(this.store, key(k), v) } }
  }

  /** A plugin's tools named `<id>_…`; others are dropped so they cannot pass for the app's own. */
  private ownTools(id: string, make: () => ToolSet | undefined): ToolSet {
    let tools: ToolSet
    try { tools = make() ?? {} } catch (error) { console.warn(`[plugin ${id}] 工具出错：${(error as Error).message}`); return {} }
    const out: ToolSet = {}
    for (const [name, t] of Object.entries(tools)) {
      if (name.startsWith(`${id}_`)) out[name] = t
      else console.warn(`[plugin ${id}] 插件工具名必须以 ${id}_ 开头，已忽略：${name}`)
    }
    return out
  }

  /** A built-in plugin as the agents see it: always loaded, with no folder of its own. */
  private builtInEntry(plugin: NuonuoPlugin): { plugin: NuonuoPlugin; manifest: PluginManifest } {
    return { plugin, manifest: { id: plugin.id, name: plugin.name ?? plugin.id, version: plugin.version ?? '', description: plugin.description ?? '', dir: '', entry: '', apiVersion: PLUGIN_API_VERSION } }
  }

  /** A plugin's small persistent state, for the service's own pages (e.g. 心境 in 它是谁). */
  stateOf(id: string): PluginContext['state'] {
    const key = (k: string) => `plugin:${id}:state:${k}`
    return { get: <T>(k: string) => kvGet<T>(this.store, key(k)), set: (k, v) => kvSet(this.store, key(k), v) }
  }

  /** The built-in and loaded plugins' own tools and prompt text, for the agents. */
  agentExtensions(): AgentExtensions {
    const all = () => [...[...this.builtIns.values()].map(p => this.builtInEntry(p)), ...this.loaded.values()]
    const text = (v: PluginModuleText, m: PluginManifest) => { try { return typeof v === 'function' ? v(this.context(m)) : v } catch { return undefined } }
    return {
      routerTools: () => Object.assign({}, ...all().map(({ plugin, manifest }) => this.ownTools(manifest.id, () => plugin.routerTools?.(this.context(manifest))))) as ToolSet,
      workerTools: () => Object.assign({}, ...all().map(({ plugin, manifest }) => this.ownTools(manifest.id, () => plugin.workerTools?.(this.context(manifest))))) as ToolSet,
      routerPrompt: () => all().map(({ plugin, manifest }) => text(plugin.routerPrompt, manifest)).filter(Boolean).map(t => String(t).slice(0, 4_000)).join('\n\n'),
      workerPrompt: () => all().map(({ plugin, manifest }) => text(plugin.workerPrompt, manifest)).filter(Boolean).map(t => String(t).slice(0, 4_000)).join('\n\n') || undefined,
      inlineContext: async (input, scope) => {
        const parts = await Promise.all(all().filter(({ plugin }) => typeof plugin.inlineContext === 'function').map(({ plugin, manifest }) =>
          withTimeout(Promise.resolve().then(() => plugin.inlineContext!(this.context(manifest), { text: input, ...(scope ? { scope } : {}) })), INLINE_CONTEXT_TIMEOUT)
            .then(t => typeof t === 'string' && t.trim() ? t.trim().slice(0, INLINE_CONTEXT_LIMIT) : '')
            .catch(error => { console.warn(`[plugin ${manifest.id}] inlineContext 出错：${(error as Error).message}`); return '' })))
        return parts.filter(Boolean).join('\n\n')
      },
    }
  }

  private toolNames(plugin: NuonuoPlugin, m: PluginManifest): string[] {
    return [...new Set([...Object.keys(this.ownTools(m.id, () => plugin.routerTools?.(this.context(m)))), ...Object.keys(this.ownTools(m.id, () => plugin.workerTools?.(this.context(m))))])]
  }

  /** Acting tools of loaded plugins (their `writes`): asked about before every call. */
  askFirstTools(): Set<string> {
    return new Set([...[...this.builtIns.values()].map(p => this.builtInEntry(p)), ...this.loaded.values()].flatMap(({ plugin, manifest }) => (plugin.writes ?? []).filter(n => n.startsWith(`${manifest.id}_`))))
  }

  /** First-party plugins ship with the app and are always loaded; their sources start disabled like any other. */
  registerBuiltIn(plugin: NuonuoPlugin): void {
    this.builtIns.set(plugin.id, plugin)
    for (const kind of plugin.sources ?? []) this.registry.register(kind)
  }

  scan(): PluginManifest[] {
    if (!existsSync(this.dir)) return []
    const out: PluginManifest[] = []
    for (const name of readdirSync(this.dir, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name.startsWith('.')) continue
      try {
        const manifest = readManifest(join(this.dir, name.name))
        if (manifest) out.push(manifest)
      } catch (error) {
        this.errors.set(name.name, (error as Error).message)
      }
    }
    return out
  }

  list(): PluginInfo[] {
    const builtIn: PluginInfo[] = [...this.builtIns.values()].map(p => ({ id: p.id, name: p.name ?? p.id, version: p.version ?? '', description: p.description ?? '',
      dir: '', entry: '', apiVersion: PLUGIN_API_VERSION, enabled: true, loaded: true, builtIn: true, sources: (p.sources ?? []).map(k => k.id), mcpServers: [], tools: [], skills: [] }))
    const external = this.scan().map(m => {
      const loaded = this.loaded.get(m.id)
      const error = this.errors.get(m.id)
      const origin = kvGet<string>(this.store, `plugin:${m.id}:origin`)
      const notes = kvGet<string[]>(this.store, `plugin:${m.id}:notes`)
      return { ...m, enabled: this.enabled(m.id), loaded: Boolean(loaded), builtIn: false, sources: (loaded?.plugin.sources ?? []).map(k => k.id),
        mcpServers: loaded ? this.mcpServers().map(c => c.name).filter(n => n.startsWith(`${m.id}_`)) : [], tools: loaded ? this.toolNames(loaded.plugin, m) : [],
        skills: (loaded?.plugin.skills ?? []).map(sk => String(sk.name)), ...(origin ? { origin } : {}), ...(notes?.length ? { notes } : {}), ...(error ? { error } : {}) }
    })
    return [...builtIn, ...external]
  }

  enabled(id: string): boolean { return kvGet<boolean>(this.store, `plugin:${id}:enabled`) ?? false }

  /** Loads every enabled plugin (at startup). Failures are kept per plugin and never stop the daemon. */
  async loadEnabled(): Promise<void> {
    for (const m of this.scan()) if (this.enabled(m.id)) await this.load(m).catch(() => {})
    this.onChange?.()
  }

  /** MCP servers of the loaded plugins, ready for the MCP manager. */
  mcpServers(): McpServerConfig[] {
    return [...this.loaded.values()].flatMap(({ plugin, manifest }) => (plugin.mcpServers ?? []).flatMap((sv): McpServerConfig[] => {
      const box = this.sandboxes.get(manifest.id)
      if (box) { const c = box.mcpServer(sv, mcpName(manifest.id, sv.name)); return c ? [c] : [] }
      return [{
      name: mcpName(manifest.id, sv.name), enabled: true, transport: sv.transport,
      ...(sv.command ? { command: sv.command } : {}), ...(sv.args ? { args: sv.args } : {}), ...(sv.env ? { env: sv.env } : {}),
      ...(sv.url ? { url: sv.url } : {}), ...(sv.headers ? { headers: sv.headers } : {}),
      cwd: manifest.dir, roles: sv.roles?.length ? sv.roles : ['worker' as const], review: true,
    }]
    }))
  }

  /**
   * Installs a plugin from a folder, GitHub, npm or a .tgz URL (see `parseOrigin`). Its code is not run: it arrives
   * switched off like a plugin copied in by hand. With `replace`, the plugin of that id is updated in place and loaded
   * again if it was on.
   */
  async install(input: string, opts: { replace?: string } = {}): Promise<PluginInfo> {
    const origin = parseOrigin(input)
    const staging = join(this.dir, `.staging-${randomBytes(4).toString('hex')}`)
    try {
      const root = await fetchPlugin(origin, staging, this.fetchImpl)
      const manifest = readManifest(root)
      if (!manifest) throw new Error('package.json 里没有 nuonuo.plugin 字段，这不是 Nuonuo 插件')
      if (this.builtIns.has(manifest.id)) throw new Error(`「${manifest.id}」是内置插件的名字`)
      if (opts.replace && manifest.id !== opts.replace) throw new Error(`新版本的 id 是「${manifest.id}」，和「${opts.replace}」对不上`)
      const existing = this.scan().find(m => m.id === manifest.id)
      if (existing && !opts.replace) throw new Error(`已经装了「${existing.name}」，要换新版本请用「更新」`)
      const deps = await installDependencies(root, this.fetchImpl)
      const wasOn = Boolean(existing) && this.enabled(manifest.id)
      if (existing) { await this.unload(manifest.id); rmSync(existing.dir, { recursive: true, force: true }) }
      const target = existing?.dir ?? join(this.dir, manifest.id)
      if (existsSync(target)) throw new Error(`插件文件夹里已经有 ${manifest.id}/，但它不是插件；请先移走它`)
      renameSync(root, target)
      kvSet(this.store, `plugin:${manifest.id}:origin`, input.trim())
      kvSet(this.store, `plugin:${manifest.id}:notes`, deps.notes.length ? deps.notes : null)
      this.errors.delete(manifest.id)
      if (wasOn) await this.load(readManifest(target)!).catch(() => {})
      this.onChange?.()
      return this.list().find(p => p.id === manifest.id)!
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Installs the newest version from where the plugin came from. */
  async update(id: string): Promise<PluginInfo> {
    const origin = kvGet<string>(this.store, `plugin:${id}:origin`)
    if (!origin) throw new Error('这个插件是手动放进文件夹的，没法自动更新；请重新安装或手动替换文件')
    return this.install(origin, { replace: id })
  }

  /** Runs the plugin's code again (after its files were edited). */
  async reload(id: string): Promise<PluginInfo> {
    const manifest = this.scan().find(m => m.id === id)
    if (!manifest) throw new Error(`没有插件 ${id}`)
    await this.unload(id)
    if (this.enabled(id)) await this.load(manifest).finally(() => this.onChange?.())
    return this.list().find(p => p.id === id)!
  }

  /** Stops the plugin, deletes its folder and forgets its settings, including the settings and secrets of its sources. */
  async uninstall(id: string): Promise<void> {
    if (this.builtIns.has(id)) throw new Error('内置插件不能卸载')
    const manifest = this.scan().find(m => m.id === id)
    if (!manifest) throw new Error(`没有插件 ${id}`)
    const sources = [...new Set([...(this.loaded.get(id)?.plugin.sources ?? []).map(k => k.id), ...(kvGet<string[]>(this.store, `plugin:${id}:sources`) ?? [])])]
    const kinds = new Map((this.loaded.get(id)?.plugin.sources ?? []).map(k => [k.id, k]))
    await this.unload(id)
    for (const source of sources) this.registry.forget(source, kinds.get(source))
    rmSync(manifest.dir, { recursive: true, force: true })
    for (const { key } of this.store.db.select({ key: schema.kv.key }).from(schema.kv).all()) if (key.startsWith(`plugin:${id}:`)) kvSet(this.store, key, null)
    this.skills?.removePlugin(id)
    this.errors.delete(id)
    this.onChange?.()
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
    const manifest = this.scan().find(m => m.id === id)
    if (!manifest) throw new Error(`没有插件 ${id}`)
    kvSet(this.store, `plugin:${id}:enabled`, enabled)
    try {
      if (enabled) await this.load(manifest)
      else await this.unload(id)
    } finally { this.onChange?.() }
    return this.list().find(p => p.id === id)!
  }

  private async load(manifest: PluginManifest): Promise<void> {
    if (this.loaded.has(manifest.id)) return
    this.errors.delete(manifest.id)
    try {
      if (manifest.apiVersion > PLUGIN_API_VERSION) throw new Error(`需要插件接口版本 ${manifest.apiVersion}，当前是 ${PLUGIN_API_VERSION}`)
      const plugin = this.sandboxed ? await this.startSandbox(manifest) : await importPlugin(manifest)
      if (!plugin || typeof plugin !== 'object' || typeof plugin.id !== 'string') throw new Error('插件必须导出包含 id 的对象')
      for (const kind of plugin.sources ?? []) {
        if (!ID.test(kind.id)) throw new Error(`来源 id "${kind.id}" 不合法`)
        if (this.registry.has(kind.id)) throw new Error(`来源 id "${kind.id}" 已被占用`)
        if (!kind.schema || typeof kind.start !== 'function') throw new Error(`来源 ${kind.id} 缺少 schema 或 start`)
      }
      for (const kind of plugin.sources ?? []) this.registry.register(kind, { thirdParty: true })
      for (const sv of plugin.mcpServers ?? []) {
        if (!sv || typeof sv.name !== 'string' || !/^[a-z0-9_-]{1,24}$/.test(sv.name)) throw new Error(`MCP 服务名「${String(sv?.name)}」不合法`)
        if (sv.transport === 'stdio' ? !sv.command : sv.transport === 'http' ? !sv.url : true) throw new Error(`MCP 服务 ${sv.name} 缺少 command 或 url`)
      }
      if (plugin.skills !== undefined && !Array.isArray(plugin.skills)) throw new Error('skills 必须是数组')
      this.loaded.set(manifest.id, { plugin, manifest })
      kvSet(this.store, `plugin:${manifest.id}:sources`, (plugin.sources ?? []).map(k => k.id))
      this.skills?.syncPlugin(manifest.id, plugin.skills ?? [])
      for (const kind of plugin.sources ?? []) if (this.registry.settings(kind.id).enabled) await this.registry.save(kind.id, this.registry.settings(kind.id))
    } catch (error) {
      this.errors.set(manifest.id, error instanceof Error ? error.message : String(error))
      await this.sandboxes.get(manifest.id)?.stop()
      this.sandboxes.delete(manifest.id)
      throw error
    }
  }

  /** Stops every plugin process (the service is shutting down). */
  async close(): Promise<void> {
    await Promise.all([...this.sandboxes.values()].map(b => b.stop()))
    this.sandboxes.clear()
  }

  private async startSandbox(manifest: PluginManifest): Promise<NuonuoPlugin> {
    const box = new PluginSandbox(manifest, {
      store: this.store, ...(this.registry.secretStore ? { secrets: this.registry.secretStore } : {}),
      onExit: reason => {
        if (this.sandboxes.get(manifest.id) !== box) return
        this.errors.set(manifest.id, reason)
        void this.unload(manifest.id).finally(() => this.onChange?.())
      },
    })
    this.sandboxes.set(manifest.id, box)
    return box.start()
  }

  private async unload(id: string): Promise<void> {
    const entry = this.loaded.get(id)
    const box = this.sandboxes.get(id)
    this.sandboxes.delete(id)
    if (entry) for (const kind of entry.plugin.sources ?? []) await this.registry.unregister(kind.id)
    this.loaded.delete(id)
    await box?.stop()
  }
}

/** Resolves with undefined when `p` takes longer than `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([p, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms) })]).finally(() => clearTimeout(timer))
}

const mcpName = (pluginId: string, name: string) => `${pluginId}_${name}`

/** The plugin described by `<dir>/package.json`, or undefined when that package is not a Nuonuo plugin. */
function readManifest(dir: string): PluginManifest | undefined {
  const pkgFile = join(dir, 'package.json')
  if (!existsSync(pkgFile)) return undefined
  let pkg: Record<string, any>
  try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch (error) { throw new Error(`无法读取 package.json：${(error as Error).message}`) }
  // `super-assistant` is the manifest key from before the project was renamed.
  const meta = pkg['nuonuo'] ?? pkg['super-assistant'] ?? {}
  if (!meta.plugin) return undefined
  const id = String(meta.id ?? pkg.name ?? dir.split(sep).pop()).replace(/^@[^/]+\//, '').toLowerCase()
  const entry = resolve(dir, meta.plugin)
  if (!ID.test(id)) throw new Error(`插件 id "${id}" 不合法`)
  if (!entry.startsWith(dir + sep)) throw new Error('入口文件必须在插件目录内')
  return { id, name: meta.name ?? pkg.name ?? id, version: pkg.version ?? '0.0.0', description: meta.description ?? pkg.description ?? '', dir, entry,
    apiVersion: Number(meta.apiVersion ?? 1) }
}

/** Runs a plugin inside the service (sandbox off). A query string busts Node's module cache so a re-enabled plugin picks up edits. */
async function importPlugin(manifest: PluginManifest): Promise<NuonuoPlugin> {
  const mod = await import(`${pathToFileURL(manifest.entry).href}?v=${Date.now()}`) as { default?: PluginModule }
  const exported = mod.default
  if (!exported) throw new Error('入口模块没有 default 导出')
  return typeof exported === 'function' ? await exported(sdk) : exported
}
