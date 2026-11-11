/**
 * SourceRegistry: owns the installed source kinds and their saved settings, starts and stops them, and serves the engine
 * (who may ask for work, outgoing messages through the `reply` effect) and the agents (tools, prompt text, environment).
 */
import type { AgentExtensions, Engine, SourcePort, Ticket } from '@super-assistant/core'
import { kvGet, kvSet, type Effects, type Store } from '@super-assistant/db'
import type { ToolSet } from 'ai'
import type { Health, OutgoingMessage, SourceContext, SourceKind } from './kind'

export interface SourceSettings { enabled: boolean; config: unknown }

export interface SecretPort { get(ref: string): string | undefined; set(ref: string, value: string): void; delete(ref: string): void }

/** What the settings form receives for a secret field. */
export const SECRET_SET = '••••••'

interface Instance { kind: SourceKind; ctx: SourceContext<any>; stop?: () => void | Promise<void>; abort: AbortController }

export class SourceRegistry implements SourcePort {
  private kinds = new Map<string, SourceKind>()
  /** Kinds from installed third-party plugins: they get the narrowed context (see `outsiderContext`). */
  private outsiders = new Set<string>()
  private instances = new Map<string, Instance>()
  private healths = new Map<string, Health>()
  private factsBy = new Map<string, Record<string, string>>()
  engine!: Engine

  constructor(private store: Store, private effects: Effects, private secrets?: SecretPort) {
    effects.handle<OutgoingMessage & { source: string }>('reply', async payload => this.deliver(payload), { concurrency: 2, baseDelayMs: 5_000, maxDelayMs: 300_000 })
  }

  register(kind: SourceKind, opts: { thirdParty?: boolean } = {}): void {
    if (this.kinds.has(kind.id)) throw new Error(`source ${kind.id} already registered`)
    this.kinds.set(kind.id, kind)
    if (opts.thirdParty) this.outsiders.add(kind.id)
    else this.outsiders.delete(kind.id)
  }

  has(id: string): boolean { return this.kinds.has(id) }

  /** Removes a kind (a plugin being disabled), stopping it first. */
  async unregister(id: string): Promise<void> {
    await this.stop(id)
    this.kinds.delete(id)
    this.outsiders.delete(id)
  }

  private secretKeys(kind: SourceKind | undefined): string[] {
    return kind?.fields.filter(f => f.type === 'secret').map(f => f.key) ?? []
  }

  /** Settings with secret values read back from the secret store (what the source itself sees). */
  private withSecrets(kind: SourceKind, config: Record<string, unknown>): Record<string, unknown> {
    const out = { ...config }
    for (const key of this.secretKeys(kind)) out[key] = this.secrets?.get(`source:${kind.id}:${key}`) ?? ''
    return out
  }

  list() {
    return [...this.kinds.values()].map(kind => {
      const saved = this.settings(kind.id)
      const config = { ...(saved.config as Record<string, unknown>) }
      for (const key of this.secretKeys(kind)) config[key] = this.secrets?.get(`source:${kind.id}:${key}`) ? SECRET_SET : ''
      const ctx = kind.authorized && (this.instances.get(kind.id)?.ctx ?? this.makeInstance(kind).ctx)
      const authorized = ctx ? kind.authorized!(ctx) : undefined
      const actions = (kind.actions ?? []).filter(a => !a.show || authorized === undefined || (a.show === 'authorized') === authorized)
      return { id: kind.id, title: kind.title, description: kind.description, fields: kind.fields, actions, authorized, enabled: saved.enabled, config,
        health: this.healths.get(kind.id) ?? { status: 'off', at: Date.now() }, facts: this.factsBy.get(kind.id) ?? {} }
    })
  }

  settings(id: string): SourceSettings {
    const kind = this.kinds.get(id)
    const saved = kvGet<SourceSettings>(this.store, `source:${id}`)
    const parsed = kind?.schema.safeParse(kind ? this.withSecrets(kind, (saved?.config ?? {}) as Record<string, unknown>) : {})
    return { enabled: saved?.enabled ?? kind?.defaultEnabled ?? false, config: parsed?.success ? parsed.data : kind?.schema.safeParse({}).data ?? {} }
  }

  /** Validates and saves a source's settings, then restarts it. */
  async save(id: string, input: SourceSettings): Promise<SourceSettings> {
    const kind = this.kinds.get(id)
    if (!kind) throw new Error(`没有来源 ${id}`)
    const config = { ...((input.config ?? {}) as Record<string, unknown>) }
    // Secret fields: a new value goes to the secret store; the masked placeholder keeps the stored one; empty clears it.
    for (const key of this.secretKeys(kind)) {
      const value = config[key]
      const ref = `source:${id}:${key}`
      if (typeof value === 'string' && value && value !== SECRET_SET) this.secrets?.set(ref, value)
      else if (value === '' || value === undefined) this.secrets?.delete(ref)
      config[key] = this.secrets?.get(ref) ?? ''
    }
    const parsed = kind.schema.safeParse(config)
    if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
    const stored = { ...(parsed.data as Record<string, unknown>) }
    for (const key of this.secretKeys(kind)) delete stored[key]
    kvSet(this.store, `source:${id}`, { enabled: input.enabled, config: stored })
    await this.stop(id)
    if (input.enabled) this.start(id)
    return this.settings(id)
  }

  /** Routes an HTTP request to a source's endpoint; undefined when it has none for this path. */
  async http(id: string, request: Request, path: string, info: { public: boolean; origin: string }): Promise<Response | undefined> {
    const kind = this.kinds.get(id)
    if (!kind?.http) return undefined
    const instance = this.instances.get(id) ?? this.makeInstance(kind)
    return kind.http(instance.ctx, request, path, info)
  }

  async pollNow(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`来源 ${id} 未启用`)
    await instance.kind.poll?.(instance.ctx)
  }

  startAll(): void {
    for (const id of this.kinds.keys()) if (this.settings(id).enabled) this.start(id)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map(id => this.stop(id)))
  }

  // ── SourcePort for the engine ──────────────────────────────────────────────

  allowed(source: string, actor: string): boolean {
    const instance = this.instances.get(source) ?? this.idleInstance(source)
    return instance?.kind.allowed?.(instance.ctx, actor) ?? false
  }

  hasChannel(source: string): boolean {
    return Boolean(this.kinds.get(source)?.send)
  }

  send(message: OutgoingMessage & { source: string }): void {
    this.effects.enqueue('reply', message.messageId, message)
  }

  // ── Extensions for the agents ──────────────────────────────────────────────

  /** `readOnly`: sources the owner set to 只能看 in 权限; their acting tools are left out. */
  agentExtensions(readOnly: (sourceId: string) => boolean = () => false): AgentExtensions {
    const running = () => [...this.instances.values()]
    const touches = (ticket: Ticket, kind: SourceKind) => this.engine.subscribersOfTicket(ticket.id).some(threadId => threadId.startsWith(`${kind.id}:`))
    return {
      routerPrompt: () => running().map(i => i.kind.routerPrompt?.(i.ctx)).filter(Boolean).join('\n\n'),
      routerTools: () => Object.assign({}, ...running().map(i => this.ownTools(i.kind, i.kind.routerTools?.(i.ctx) ?? {}))) as ToolSet,
      workerPrompt: ticket => running().filter(i => touches(ticket, i.kind)).map(i => i.kind.workerPrompt?.(i.ctx, ticket)).filter(Boolean).join('\n\n'),
      workerTools: (ticket, turn) => Object.assign({}, ...running().map(i => {
        const tools = this.ownTools(i.kind, i.kind.workerTools?.(i.ctx, ticket, turn) ?? {})
        if (!readOnly(i.kind.id) || !i.kind.writes?.length) return tools
        return Object.fromEntries(Object.entries(tools).filter(([name]) => !i.kind.writes!.includes(name)))
      })) as ToolSet,
      workerEnv: ticket => Object.assign({}, ...running().filter(i => touches(ticket, i.kind)).map(i => i.kind.workerEnv?.(i.ctx, ticket) ?? {})),
      threadInfo: threadId => {
        const instance = this.instances.get(threadId.split(':')[0] ?? '')
        return instance?.kind.threadInfo?.(instance.ctx, threadId)
      },
    }
  }

  /**
   * Acting tools of third-party sources (their `writes`): the owner is asked before each call, whatever 权限 says,
   * since the app cannot know what they change.
   */
  askFirstTools(): Set<string> {
    return new Set([...this.instances.values()].filter(i => this.outsiders.has(i.kind.id)).flatMap(i => i.kind.writes ?? []))
  }

  /** A third-party source's tools must be named `<id>_…`; others are dropped so they cannot pass for the app's own. */
  private ownTools(kind: SourceKind, tools: ToolSet): ToolSet {
    if (!this.outsiders.has(kind.id)) return tools
    const ok = Object.entries(tools).filter(([name]) => name.startsWith(`${kind.id}_`))
    if (ok.length < Object.keys(tools).length) console.warn(`[${kind.id}] 插件工具名必须以 ${kind.id}_ 开头，已忽略：${Object.keys(tools).filter(n => !n.startsWith(`${kind.id}_`)).join(', ')}`)
    return Object.fromEntries(ok)
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private start(id: string): void {
    const kind = this.kinds.get(id)!
    const instance = this.makeInstance(kind)
    this.instances.set(id, instance)
    instance.ctx.health('starting')
    try {
      const stop = kind.start(instance.ctx)
      if (stop) instance.stop = stop
    } catch (error) {
      instance.ctx.health('error', error instanceof Error ? error.message : String(error))
    }
  }

  private async stop(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) return
    this.instances.delete(id)
    instance.abort.abort()
    await instance.stop?.()
    this.healths.set(id, { status: 'off', at: Date.now() })
  }

  /** A context for a configured but stopped source, so `allowed` and `send` keep working while it is off. */
  private idleInstance(id: string): Instance | undefined {
    const kind = this.kinds.get(id)
    return kind && this.settings(id).enabled ? this.makeInstance(kind) : undefined
  }

  private makeInstance(kind: SourceKind): Instance {
    const abort = new AbortController()
    const settings = this.settings(kind.id)
    const registry = this
    const ctx: SourceContext<any> = {
      id: kind.id, config: settings.config, signal: abort.signal,
      ...(this.outsiders.has(kind.id) ? outsiderContext(kind.id, this.engine) : { engine: this.engine, store: this.store }),
      state: {
        get: <T>(key: string) => kvGet<T>(registry.store, `source:${kind.id}:${key}`),
        set: (key: string, value: unknown) => kvSet(registry.store, `source:${kind.id}:${key}`, value),
      },
      facts: facts => { registry.factsBy.set(kind.id, { ...(registry.factsBy.get(kind.id) ?? {}), ...facts }) },
      health: (status, detail) => { registry.healths.set(kind.id, { status, ...(detail ? { detail } : {}), at: Date.now() }) },
      log: (...args) => console.log(`[${kind.id}]`, ...args),
      secret: {
        get: name => registry.secrets?.get(`source:${kind.id}:runtime:${name}`),
        set: (name, value) => { if (!registry.secrets) throw new Error('没有可用的密钥存储'); registry.secrets.set(`source:${kind.id}:runtime:${name}`, value) },
        delete: name => registry.secrets?.delete(`source:${kind.id}:runtime:${name}`),
      },
      notify: (text, opts) => {
        const conversationId = registry.engine.mirrorConversation(`${kind.id}:notices`, { title: opts?.title ?? `🔔 ${kind.title}` })
        registry.engine.reply({ conversationId, text })
      },
    }
    return { kind, ctx, abort }
  }

  private async deliver(message: OutgoingMessage & { source: string }): Promise<void> {
    const instance = this.instances.get(message.source) ?? this.idleInstance(message.source)
    if (!instance?.kind.send) {
      this.engine.delivered(message.messageId, { ok: false, error: `来源 ${message.source} 未启用`, final: true })
      return
    }
    try {
      const result = await instance.kind.send(instance.ctx, message)
      if (result === 'gone') this.engine.delivered(message.messageId, { ok: false, error: '对方会话已不存在', final: true })
      else this.engine.delivered(message.messageId, { ok: true, ...(result.url ? { url: result.url } : {}) })
    } catch (error) {
      this.engine.delivered(message.messageId, { ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}

const ENGINE_FOR_PLUGINS = ['receive', 'followed', 'follow', 'threadClosed', 'mainConversation', 'conversationOfThread'] as const

/**
 * What a third-party plugin's source sees instead of the whole engine and database: it can report events and follow
 * threads only under its own `<id>:` prefix, see the threads it follows, and look up conversations. Anything else (the
 * database, ending tasks, writing memory, other sources' threads) throws, so a plugin cannot reach past its own channel.
 * Built-in sources keep the full context.
 */
export function outsiderContext(id: string, engine: Engine): { engine: Engine; store: Store } {
  const own = (threadId: string) => {
    if (typeof threadId !== 'string' || !threadId.startsWith(`${id}:`)) throw new Error(`插件来源 ${id} 只能使用以 "${id}:" 开头的线程，收到 ${String(threadId)}`)
  }
  const facade: Pick<Engine, typeof ENGINE_FOR_PLUGINS[number]> = {
    receive: t => {
      if (t.source !== id) throw new Error(`插件来源 ${id} 不能以 ${t.source} 的名义送来消息`)
      own(t.threadId)
      return engine.receive(t)
    },
    followed: () => engine.followed().filter(f => f.threadId.startsWith(`${id}:`)),
    follow: (ticketId, threadId, kind, info) => { own(threadId); engine.follow(ticketId, threadId, kind, info) },
    threadClosed: (threadId, outcome) => { own(threadId); engine.threadClosed(threadId, outcome) },
    mainConversation: () => engine.mainConversation(),
    conversationOfThread: threadId => engine.conversationOfThread(threadId),
  }
  const refuse = (what: string) => { throw new Error(`第三方插件不能使用 ${what}（见 docs/04-plugin-sdk.md 的「插件能用的接口」）`) }
  const narrowed = new Proxy(facade, {
    get: (target, prop) => (typeof prop === 'string' && prop in target ? (target as any)[prop] : typeof prop === 'string' ? refuse(`engine.${prop}`) : undefined),
  }) as unknown as Engine
  const store = new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' && prop !== 'then' ? refuse('store') : undefined) }) as Store
  return { engine: narrowed, store }
}
