/**
 * The service's side of a sandboxed plugin: one Node process per plugin, started with the permission model so it can
 * read and write only its own folder (no other files, programs, threads or native addons; the network stays open).
 * Here the plugin becomes an ordinary NuonuoPlugin whose sources and tools forward to that process. Questions the
 * service asks synchronously (prompt text, tool lists, authorization, who may ask for work) are answered from the
 * snapshot the process keeps sending; everything else is a message round trip.
 */
import type { McpServerConfig } from '@nuonuo/agent-runtime'
import { kvGet, kvSet, schema, type Store } from '@nuonuo/db'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { SourceContext, SourceKind } from './kind'
import type { NuonuoPlugin, PluginManifest, PluginMcpServer } from './plugins'
import type { SecretPort } from './registry'

interface ToolDef { description: string; inputSchema: Record<string, unknown> }
interface SourceSnapshot { authorized?: boolean; routerPrompt?: string; workerPrompt?: string; workerEnv?: Record<string, string>; routerTools: Record<string, ToolDef>; workerTools: Record<string, ToolDef>; threadInfo: Record<string, string>; homeThread?: string }
interface Snapshot { plugin: { routerPrompt?: string; workerPrompt?: string; routerTools: Record<string, ToolDef>; workerTools: Record<string, ToolDef> }; sources: Record<string, SourceSnapshot> }
interface HelloSource { id: string; title: string; icon?: string; description: string; fields: SourceKind['fields']; defaultEnabled?: boolean; actions?: SourceKind['actions']; writes?: string[]; configSchema: Record<string, unknown> | null; capabilities?: SourceKind['capabilities']; has: Record<string, boolean>; validStart: boolean }
interface Hello { plugin: { id: string; name?: string; version?: string; description?: string; writes: string[]; skills: NuonuoPlugin['skills']; mcpServers: PluginMcpServer[]; sources: HelloSource[]; hasInlineContext?: boolean; windowCalls?: string[] }; snapshot: Snapshot }

const here = dirname(fileURLToPath(import.meta.url))
/** The runner sits next to this module in the repository and next to cli.mjs in the built service. */
export function runnerPath(): string {
  const candidates = [join(here, 'plugin-runner.mjs'), join(here, '..', 'plugin-runner.mjs')]
  const found = candidates.find(existsSync)
  if (!found) throw new Error('找不到插件沙箱的运行文件 plugin-runner.mjs')
  return found
}

/** Node 22.13 made the permission model stable; 22.12 (the oldest Node the service runs on) still calls it experimental. */
export function permissionFlag(version = process.versions.node): string {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 13) ? '--permission' : '--experimental-permission'
}

/** Turned off with NUONUO_PLUGIN_SANDBOX=off (plugin development); then plugins run inside the service. */
export const sandboxWanted = () => process.env.NUONUO_PLUGIN_SANDBOX !== 'off'

export interface SandboxHost {
  store: Store
  secrets?: SecretPort
  /** The plugin's own settings (secrets included), handed to the process at start. */
  settings?(): Record<string, unknown>
  /** Called when the process ends on its own (crash, exit), with why. */
  onExit(reason: string): void
}

const ANSWER_TIMEOUT = 120_000

export class PluginSandbox {
  private child: ChildProcess | undefined
  private seq = 0
  private waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>()
  private snap: Snapshot = { plugin: { routerTools: {}, workerTools: {} }, sources: {} }
  /** Source contexts the registry gave us, by source id: where events from the process go. */
  private ctxs = new Map<string, SourceContext<any>>()
  /** Who may ask for work, as the process judged it when it reported each event. */
  private allowedActors = new Map<string, Map<string, boolean>>()
  private sentConfig = new Map<string, string>()
  private stopping = false
  private engineTimer: NodeJS.Timeout | undefined

  constructor(private manifest: PluginManifest, private host: SandboxHost) {}

  /** Starts the process, loads the plugin in it, and returns the plugin as the service sees it. */
  async start(): Promise<NuonuoPlugin> {
    const dir = realpathSync(this.manifest.dir)
    const runner = runnerPath()
    const zodEntry = createRequire(import.meta.url).resolve('zod')
    const zodDir = realpathSync(packageRoot(zodEntry))
    const child = fork(runner, [realpathSync(zodEntry), realpathSync(this.manifest.entry), this.manifest.id, dir], {
      execArgv: [permissionFlag(), `--allow-fs-read=${realpathSync(runner)}`, `--allow-fs-read=${realpathSync(join(dirname(runner), 'channel.mjs'))}`, `--allow-fs-read=${realpathSync(join(dirname(runner), 'auth.mjs'))}`, `--allow-fs-read=${zodDir}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`],
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: pluginEnv(), serialization: 'json',
    })
    this.child = child
    const prefix = `[plugin ${this.manifest.id}]`
    child.stdout?.on('data', d => console.log(prefix, String(d).trimEnd()))
    child.stderr?.on('data', d => console.warn(prefix, String(d).trimEnd()))
    const hello = new Promise<Hello>((resolveHello, rejectHello) => {
      const timer = setTimeout(() => rejectHello(new Error('插件 30 秒内没有启动完成')), 30_000)
      child.on('message', (msg: any) => {
        if (msg?.kind === 'tell' && msg.type === 'hello') { clearTimeout(timer); resolveHello(msg as Hello) }
        else if (msg?.kind === 'tell' && msg.type === 'fatal') { clearTimeout(timer); rejectHello(new Error(msg.error)) }
        else this.onMessage(msg)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        const reason = `插件进程退出了（${signal ?? code}）`
        for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error(reason)) }
        this.waiting.clear()
        clearInterval(this.engineTimer)
        rejectHello(new Error(reason))
        if (!this.stopping) this.host.onExit(reason)
      })
    })
    let info: Hello
    try { info = await hello } catch (error) { this.stopping = true; throw error }
    this.snap = info.snapshot
    this.engineTimer = setInterval(() => this.pushEngineView(), 3_000)
    this.engineTimer.unref()
    return this.asPlugin(info)
  }

  async stop(): Promise<void> {
    this.stopping = true
    clearInterval(this.engineTimer)
    const child = this.child
    if (!child || child.exitCode !== null) return
    await new Promise<void>(done => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done() }, 3_000)
      child.once('exit', () => { clearTimeout(timer); done() })
      child.disconnect?.()
      child.kill()
    })
  }

  /** A plugin's stdio MCP server may only be `node <file in its folder>`, run under the same permissions. */
  mcpServer(sv: PluginMcpServer, name: string): McpServerConfig | undefined {
    const base = { name, enabled: true, roles: sv.roles?.length ? sv.roles : ['worker' as const], review: true }
    if (sv.transport === 'http') return { ...base, transport: 'http', url: sv.url!, ...(sv.headers ? { headers: sv.headers } : {}) }
    const dir = realpathSync(this.manifest.dir)
    const script = sv.args?.[0] ? resolve(dir, sv.args[0]) : ''
    if (!['node', 'node.exe'].includes(String(sv.command)) || !script.startsWith(dir + sep) || !existsSync(script)) {
      console.warn(`[plugin ${this.manifest.id}] 沙箱里的 MCP 服务只能是「node <插件文件夹里的文件>」，已忽略 ${sv.name}`)
      return undefined
    }
    return { ...base, transport: 'stdio', command: process.execPath, cwd: dir, ...(sv.env ? { env: sv.env } : {}),
      args: [permissionFlag(), `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, script, ...(sv.args ?? []).slice(1)] }
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  private call<T = unknown>(type: string, body: Record<string, unknown> = {}): Promise<T> {
    const child = this.child
    if (!child?.connected) return Promise.reject(new Error('插件进程没有在运行'))
    const id = ++this.seq
    return new Promise<T>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => { this.waiting.delete(id); rejectCall(new Error(`插件 ${this.manifest.id} 没有回应（${type}）`)) }, ANSWER_TIMEOUT)
      this.waiting.set(id, { resolve: resolveCall as (v: unknown) => void, reject: rejectCall, timer })
      child.send({ kind: 'call', id, type, ...body })
    })
  }

  private answer(id: number, value: unknown, error?: string) { this.child?.send({ kind: 'answer', id, ...(error ? { error } : { value }) }) }

  private onMessage(msg: any): void {
    if (msg?.kind === 'answer') {
      const w = this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      clearTimeout(w.timer)
      msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.value)
      return
    }
    if (msg?.kind === 'ask' && msg.type === 'init') { this.answer(msg.id, { pluginState: this.readState(`plugin:${this.manifest.id}:state:`), pluginSettings: this.host.settings?.() ?? {} }); return }
    if (msg?.kind === 'ask' && msg.type === 'approval') {
      const ctx = typeof msg.source === 'string' ? this.ctxs.get(msg.source) : undefined
      Promise.resolve().then(() => {
        if (!ctx?.approvals) throw new Error('还不能在这里回答确认')
        return ctx.approvals.answer(String(msg.approvalId), Boolean(msg.approve), String(msg.by ?? ''))
      }).then(() => this.answer(msg.id, null), error => this.answer(msg.id, null, (error as Error).message ?? String(error)))
      return
    }
    if (msg?.kind === 'ask' && msg.type === 'saveFile') {
      const ctx = typeof msg.source === 'string' ? this.ctxs.get(msg.source) : undefined
      Promise.resolve().then(() => {
        if (!ctx?.saveFile) throw new Error('没有附件文件夹')
        return ctx.saveFile({ name: String(msg.name ?? 'file'), ...(msg.mime ? { mime: String(msg.mime) } : {}), bytes: new Uint8Array(Buffer.from(String(msg.data ?? ''), 'base64')) })
      }).then(saved => this.answer(msg.id, saved), error => this.answer(msg.id, null, (error as Error).message ?? String(error)))
      return
    }
    if (msg?.kind !== 'tell') return
    try { this.onTell(msg) } catch (error) { console.warn(`[plugin ${this.manifest.id}]`, (error as Error).message) }
  }

  private onTell(msg: any): void {
    const ctx = typeof msg.source === 'string' ? this.ctxs.get(msg.source) : undefined
    switch (msg.type) {
      case 'snapshot': this.snap = msg.snapshot; return
      case 'log': console.log(`[plugin ${this.manifest.id}]`, String(msg.text).slice(0, 4_000)); return
      case 'state': {
        const key = msg.scope === 'plugin' ? `plugin:${this.manifest.id}:state:${msg.key}` : `source:${msg.source}:${msg.key}`
        if (msg.scope !== 'plugin' && !this.ownsSource(msg.source)) return
        kvSet(this.host.store, key, msg.value ?? null)
        return
      }
      case 'secret': {
        if (!this.ownsSource(msg.source) || !this.host.secrets) return
        const ref = `source:${msg.source}:runtime:${msg.name}`
        msg.value === null ? this.host.secrets.delete(ref) : this.host.secrets.set(ref, String(msg.value))
        const names = new Set(kvGet<string[]>(this.host.store, `source:${msg.source}:__secrets`) ?? [])
        msg.value === null ? names.delete(msg.name) : names.add(String(msg.name))
        kvSet(this.host.store, `source:${msg.source}:__secrets`, [...names])
        return
      }
      case 'receive': {
        if (!ctx) return
        const actors = this.allowedActors.get(msg.source) ?? new Map<string, boolean>()
        if (msg.trigger?.actor) actors.set(String(msg.trigger.actor), Boolean(msg.allowed))
        this.allowedActors.set(msg.source, actors)
        ctx.engine.receive(msg.trigger)
        this.pushEngineView()
        return
      }
      case 'follow': ctx?.engine.follow(msg.ticketId, msg.threadId, msg.followKind, msg.info); this.pushEngineView(); return
      case 'threadClosed': ctx?.engine.threadClosed(msg.threadId, msg.outcome); this.pushEngineView(); return
      case 'facts': ctx?.facts(msg.facts ?? {}); return
      case 'health': ctx?.health(msg.status, msg.detail); return
      case 'notify': ctx?.notify(String(msg.text), msg.title ? { title: String(msg.title) } : undefined); return
    }
  }

  private ownsSource(id: unknown): boolean { return typeof id === 'string' && this.ctxs.has(id) }

  private readState(prefix: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const { key, value } of this.host.store.db.select({ key: schema.kv.key, value: schema.kv.value }).from(schema.kv).all())
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) out[key.slice(prefix.length)] = value
    return out
  }

  /** What the process may know of the engine (its own threads only), sent on changes and every few seconds. */
  private pushEngineView(): void {
    const ctx = [...this.ctxs.values()][0]
    if (!ctx || !this.child?.connected) return
    try {
      const followed = [...this.ctxs.values()].flatMap(c => c.engine.followed())
      const threads = Object.fromEntries(followed.map(f => [f.threadId, ctx.engine.conversationOfThread(f.threadId)]).filter(([, v]) => v))
      this.call('engine', { view: { main: ctx.engine.mainConversation(), followed, threads } }).catch(() => {})
    } catch {}
  }

  /** Hands the process the plugin's settings after the owner changed them. */
  updateSettings(values: Record<string, unknown>): Promise<unknown> { return this.call('settings', { values }) }

  /** Hands the process the context of one of its sources (settings, state, runtime secrets) when it changes. */
  private prepare(ctx: SourceContext<any>): Promise<unknown> {
    this.ctxs.set(ctx.id, ctx)
    const key = JSON.stringify(ctx.config ?? {})
    if (this.sentConfig.get(ctx.id) === key) return Promise.resolve()
    this.sentConfig.set(ctx.id, key)
    const names = kvGet<string[]>(this.host.store, `source:${ctx.id}:__secrets`) ?? []
    const secrets = Object.fromEntries(names.map(n => [n, ctx.secret.get(n)]).filter(([, v]) => v !== undefined))
    const state = this.readState(`source:${ctx.id}:`)
    delete state.__secrets
    return this.call('prepare', { source: ctx.id, config: ctx.config, state, secrets }).catch(error => { this.sentConfig.delete(ctx.id); throw error })
  }

  // ── The plugin as the service sees it ──────────────────────────────────────

  private tools(defs: Record<string, ToolDef> | undefined, run: (name: string, args: unknown) => Promise<unknown>): ToolSet {
    const out: ToolSet = {}
    for (const [name, def] of Object.entries(defs ?? {})) {
      out[name] = tool({ description: def.description, inputSchema: jsonSchema((def.inputSchema ?? { type: 'object', properties: {} }) as any), execute: async (args: unknown) => run(name, args) })
    }
    return out
  }

  private asPlugin(hello: Hello): NuonuoPlugin {
    const p = hello.plugin
    const sandbox = this
    const sources: SourceKind[] = p.sources.map(s => {
      if (!s.validStart) throw new Error(`来源 ${s.id} 缺少 schema 或 start`)
      const snap = () => sandbox.snap.sources[s.id]
      const has = (m: string) => Boolean(s.has[m])
      const configSchema = (s.configSchema ? (() => { try { return z.fromJSONSchema(s.configSchema as any) } catch { return z.any() } })() : z.any()) as z.ZodType<any>
      const sync = (ctx: SourceContext<any>) => { void sandbox.prepare(ctx).catch(() => {}) }
      const kind: SourceKind = {
        id: s.id, title: s.title, ...(typeof s.icon === 'string' ? { icon: s.icon } : {}), description: s.description, fields: s.fields ?? [], schema: configSchema,
        ...(s.capabilities ? { capabilities: s.capabilities } : {}),
        ...(s.defaultEnabled ? { defaultEnabled: true } : {}), ...(s.actions ? { actions: s.actions } : {}), ...(s.writes ? { writes: s.writes } : {}),
        start(ctx) {
          void sandbox.prepare(ctx).then(() => sandbox.call('start', { source: s.id })).catch(error => ctx.health('error', (error as Error).message))
          return async () => { await sandbox.call('stop', { source: s.id }).catch(() => {}) }
        },
        ...(has('authorized') ? { authorized: ctx => { sync(ctx); return Boolean(snap()?.authorized) } } : {}),
        ...(has('poll') ? { poll: async ctx => { await sandbox.prepare(ctx); await sandbox.call('poll', { source: s.id }) } } : {}),
        ...(has('allowed') ? { allowed: (_ctx, actor) => sandbox.allowedActors.get(s.id)?.get(actor) ?? false } : {}),
        ...(has('send') ? { send: async (ctx, message) => { await sandbox.prepare(ctx); return await sandbox.call('send', { source: s.id, message }) as { url?: string } | 'gone' } } : {}),
        ...(has('threadInfo') ? { threadInfo: (_ctx, threadId) => snap()?.threadInfo?.[threadId] } : {}),
        ...(has('homeThread') ? { homeThread: () => snap()?.homeThread } : {}),
        ...(has('routerPrompt') ? { routerPrompt: () => snap()?.routerPrompt } : {}),
        ...(has('workerPrompt') ? { workerPrompt: () => snap()?.workerPrompt } : {}),
        ...(has('workerEnv') ? { workerEnv: () => snap()?.workerEnv ?? {} } : {}),
        ...(has('routerTools') ? { routerTools: () => sandbox.tools(snap()?.routerTools, (name, args) => sandbox.call('tool', { scope: 'source', source: s.id, role: 'router', name, args })) } : {}),
        ...(has('workerTools') ? { workerTools: () => sandbox.tools(snap()?.workerTools, (name, args) => sandbox.call('tool', { scope: 'source', source: s.id, role: 'worker', name, args })) } : {}),
        ...(has('http') ? {
          http: async (ctx, request, path, info) => {
            await sandbox.prepare(ctx)
            const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer()).toString('base64')
            const res = await sandbox.call<{ status: number; headers: [string, string][]; body: string } | null>('http', {
              source: s.id, path, info, request: { method: request.method, url: request.url, headers: [...request.headers.entries()], ...(body ? { body } : {}) } })
            return res ? new Response(res.status === 204 || res.status === 304 ? null : Buffer.from(res.body, 'base64'), { status: res.status, headers: res.headers }) : undefined
          },
        } : {}),
      }
      return kind
    })
    const plugin: NuonuoPlugin & { sandbox: PluginSandbox } = {
      id: p.id, ...(p.name ? { name: p.name } : {}), ...(p.version ? { version: p.version } : {}), ...(p.description ? { description: p.description } : {}),
      sources, mcpServers: p.mcpServers ?? [], writes: p.writes ?? [], ...(p.skills ? { skills: p.skills } : {}),
      routerTools: () => this.tools(this.snap.plugin.routerTools, (name, args) => this.call('tool', { scope: 'plugin', role: 'router', name, args })),
      workerTools: () => this.tools(this.snap.plugin.workerTools, (name, args) => this.call('tool', { scope: 'plugin', role: 'worker', name, args })),
      routerPrompt: () => this.snap.plugin.routerPrompt,
      workerPrompt: () => this.snap.plugin.workerPrompt,
      ...(p.hasInlineContext ? { inlineContext: (_ctx, input) => this.call<string | null>('inlineContext', { input }).then(t => t ?? undefined) } : {}),
      ...(p.windowCalls?.length ? { windowCalls: Object.fromEntries(p.windowCalls.map(name => [name, (_ctx: unknown, input: unknown) => this.call('windowCall', { name, input })])) } : {}),
      sandbox: this,
    }
    return plugin
  }
}

function packageRoot(file: string): string {
  let dir = dirname(file)
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

/** The plugin process gets a plain environment: no keys or tokens from the service's own. */
function pluginEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
  return Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
}
