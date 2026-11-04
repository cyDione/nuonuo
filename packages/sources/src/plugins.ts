/**
 * Third-party plugins: a folder in `<home>/plugins/` with a package.json whose `superagent.plugin` names an ES module.
 * The manifest is read to list the plugin; its code runs only once the owner enables it (plugins run with the daemon's
 * own rights, so enabling one is a decision of trust). The module's default export is a plugin object or a function that
 * receives the SDK, so a plugin needs no dependencies of its own.
 */
import { kvGet, kvSet, type Store } from '@super-agent/db'
import { jsonSchema, tool } from 'ai'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { SourceKind } from './kind'
import type { SourceRegistry } from './registry'

export interface SuperAgentPlugin {
  id: string
  name?: string
  version?: string
  description?: string
  sources?: SourceKind[]
}

export const PLUGIN_API_VERSION = 1
export const definePlugin = <T extends SuperAgentPlugin>(plugin: T): T => plugin

/** Everything a plugin may use from the host, passed to its factory. */
export const sdk = { apiVersion: PLUGIN_API_VERSION, definePlugin, tool, jsonSchema, z }
export type PluginSdk = typeof sdk
export type PluginModule = SuperAgentPlugin | ((sdk: PluginSdk) => SuperAgentPlugin | Promise<SuperAgentPlugin>)

export interface PluginManifest { id: string; name: string; version: string; description: string; dir: string; entry: string; apiVersion: number }

export interface PluginInfo extends PluginManifest {
  enabled: boolean
  loaded: boolean
  builtIn: boolean
  sources: string[]
  error?: string
}

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/

export class PluginManager {
  private loaded = new Map<string, { plugin: SuperAgentPlugin; manifest: PluginManifest }>()
  private errors = new Map<string, string>()
  private builtIns = new Map<string, SuperAgentPlugin>()

  constructor(private dir: string, private registry: SourceRegistry, private store: Store) {}

  /** First-party plugins ship with the app and are always loaded; their sources start disabled like any other. */
  registerBuiltIn(plugin: SuperAgentPlugin): void {
    this.builtIns.set(plugin.id, plugin)
    for (const kind of plugin.sources ?? []) this.registry.register(kind)
  }

  scan(): PluginManifest[] {
    if (!existsSync(this.dir)) return []
    const out: PluginManifest[] = []
    for (const name of readdirSync(this.dir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const dir = join(this.dir, name.name)
      const pkgFile = join(dir, 'package.json')
      if (!existsSync(pkgFile)) continue
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
        const meta = pkg.superagent ?? {}
        if (!meta.plugin) continue
        const id = String(meta.id ?? pkg.name ?? name.name).replace(/^@[^/]+\//, '').toLowerCase()
        const entry = resolve(dir, meta.plugin)
        if (!ID.test(id)) { this.errors.set(name.name, `插件 id "${id}" 不合法`); continue }
        if (!entry.startsWith(dir + sep)) { this.errors.set(id, '入口文件必须在插件目录内'); continue }
        out.push({ id, name: meta.name ?? pkg.name ?? id, version: pkg.version ?? '0.0.0', description: meta.description ?? pkg.description ?? '', dir, entry,
          apiVersion: Number(meta.apiVersion ?? 1) })
      } catch (error) {
        this.errors.set(name.name, `无法读取 package.json：${(error as Error).message}`)
      }
    }
    return out
  }

  list(): PluginInfo[] {
    const builtIn: PluginInfo[] = [...this.builtIns.values()].map(p => ({ id: p.id, name: p.name ?? p.id, version: p.version ?? '', description: p.description ?? '',
      dir: '', entry: '', apiVersion: PLUGIN_API_VERSION, enabled: true, loaded: true, builtIn: true, sources: (p.sources ?? []).map(k => k.id) }))
    const external = this.scan().map(m => {
      const loaded = this.loaded.get(m.id)
      const error = this.errors.get(m.id)
      return { ...m, enabled: this.enabled(m.id), loaded: Boolean(loaded), builtIn: false, sources: (loaded?.plugin.sources ?? []).map(k => k.id), ...(error ? { error } : {}) }
    })
    return [...builtIn, ...external]
  }

  enabled(id: string): boolean { return kvGet<boolean>(this.store, `plugin:${id}:enabled`) ?? false }

  /** Loads every enabled plugin (at startup). Failures are kept per plugin and never stop the daemon. */
  async loadEnabled(): Promise<void> {
    for (const m of this.scan()) if (this.enabled(m.id)) await this.load(m).catch(() => {})
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
    const manifest = this.scan().find(m => m.id === id)
    if (!manifest) throw new Error(`没有插件 ${id}`)
    kvSet(this.store, `plugin:${id}:enabled`, enabled)
    if (enabled) await this.load(manifest)
    else await this.unload(id)
    return this.list().find(p => p.id === id)!
  }

  private async load(manifest: PluginManifest): Promise<void> {
    if (this.loaded.has(manifest.id)) return
    this.errors.delete(manifest.id)
    try {
      if (manifest.apiVersion > PLUGIN_API_VERSION) throw new Error(`需要插件接口版本 ${manifest.apiVersion}，当前是 ${PLUGIN_API_VERSION}`)
      // A query string busts Node's module cache so a re-enabled plugin picks up edits.
      const mod = await import(`${pathToFileURL(manifest.entry).href}?v=${Date.now()}`) as { default?: PluginModule }
      const exported = mod.default
      if (!exported) throw new Error('入口模块没有 default 导出')
      const plugin = typeof exported === 'function' ? await exported(sdk) : exported
      if (!plugin || typeof plugin !== 'object' || typeof plugin.id !== 'string') throw new Error('插件必须导出包含 id 的对象')
      for (const kind of plugin.sources ?? []) {
        if (!ID.test(kind.id)) throw new Error(`来源 id "${kind.id}" 不合法`)
        if (this.registry.has(kind.id)) throw new Error(`来源 id "${kind.id}" 已被占用`)
        if (!kind.schema || typeof kind.start !== 'function') throw new Error(`来源 ${kind.id} 缺少 schema 或 start`)
      }
      for (const kind of plugin.sources ?? []) this.registry.register(kind)
      this.loaded.set(manifest.id, { plugin, manifest })
      for (const kind of plugin.sources ?? []) if (this.registry.settings(kind.id).enabled) await this.registry.save(kind.id, this.registry.settings(kind.id))
    } catch (error) {
      this.errors.set(manifest.id, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async unload(id: string): Promise<void> {
    const entry = this.loaded.get(id)
    if (!entry) return
    for (const kind of entry.plugin.sources ?? []) await this.registry.unregister(kind.id)
    this.loaded.delete(id)
  }
}
