/**
 * SourceRegistry: owns the installed source kinds and their saved settings, starts and stops them, and serves the engine
 * (who may ask for work, outgoing messages through the `reply` effect) and the agents (tools, prompt text, environment).
 */
import type { AgentExtensions, Engine, SourcePort, Ticket } from '@super-agent/core'
import { kvGet, kvSet, type Effects, type Store } from '@super-agent/db'
import type { ToolSet } from 'ai'
import type { Health, OutgoingMessage, SourceContext, SourceKind } from './kind'

export interface SourceSettings { enabled: boolean; config: unknown }

interface Instance { kind: SourceKind; ctx: SourceContext<any>; stop?: () => void | Promise<void>; abort: AbortController }

export class SourceRegistry implements SourcePort {
  private kinds = new Map<string, SourceKind>()
  private instances = new Map<string, Instance>()
  private healths = new Map<string, Health>()
  private factsBy = new Map<string, Record<string, string>>()
  engine!: Engine

  constructor(private store: Store, private effects: Effects) {
    effects.handle<OutgoingMessage & { source: string }>('reply', async payload => this.deliver(payload), { concurrency: 2, baseDelayMs: 5_000, maxDelayMs: 300_000 })
  }

  register(kind: SourceKind): void {
    if (this.kinds.has(kind.id)) throw new Error(`source ${kind.id} already registered`)
    this.kinds.set(kind.id, kind)
  }

  list() {
    return [...this.kinds.values()].map(kind => {
      const saved = this.settings(kind.id)
      return { id: kind.id, title: kind.title, description: kind.description, fields: kind.fields, enabled: saved.enabled, config: saved.config,
        health: this.healths.get(kind.id) ?? { status: 'off', at: Date.now() }, facts: this.factsBy.get(kind.id) ?? {} }
    })
  }

  settings(id: string): SourceSettings {
    const kind = this.kinds.get(id)
    const saved = kvGet<SourceSettings>(this.store, `source:${id}`)
    const parsed = kind?.schema.safeParse(saved?.config ?? {})
    return { enabled: saved?.enabled ?? kind?.defaultEnabled ?? false, config: parsed?.success ? parsed.data : kind?.schema.safeParse({}).data ?? {} }
  }

  /** Validates and saves a source's settings, then restarts it. */
  async save(id: string, input: SourceSettings): Promise<SourceSettings> {
    const kind = this.kinds.get(id)
    if (!kind) throw new Error(`没有来源 ${id}`)
    const parsed = kind.schema.safeParse(input.config ?? {})
    if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
    kvSet(this.store, `source:${id}`, { enabled: input.enabled, config: parsed.data })
    await this.stop(id)
    if (input.enabled) this.start(id)
    return this.settings(id)
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

  agentExtensions(): AgentExtensions {
    const running = () => [...this.instances.values()]
    const touches = (ticket: Ticket, kind: SourceKind) => this.engine.subscribersOfTicket(ticket.id).some(threadId => threadId.startsWith(`${kind.id}:`))
    return {
      routerPrompt: () => running().map(i => i.kind.routerPrompt?.(i.ctx)).filter(Boolean).join('\n\n'),
      routerTools: () => Object.assign({}, ...running().map(i => i.kind.routerTools?.(i.ctx) ?? {})) as ToolSet,
      workerPrompt: ticket => running().filter(i => touches(ticket, i.kind)).map(i => i.kind.workerPrompt?.(i.ctx, ticket)).filter(Boolean).join('\n\n'),
      workerTools: (ticket, turn) => Object.assign({}, ...running().map(i => i.kind.workerTools?.(i.ctx, ticket, turn) ?? {})) as ToolSet,
      workerEnv: ticket => Object.assign({}, ...running().filter(i => touches(ticket, i.kind)).map(i => i.kind.workerEnv?.(i.ctx, ticket) ?? {})),
      threadInfo: threadId => {
        const instance = this.instances.get(threadId.split(':')[0] ?? '')
        return instance?.kind.threadInfo?.(instance.ctx, threadId)
      },
    }
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
      id: kind.id, config: settings.config, engine: this.engine, store: this.store, signal: abort.signal,
      state: {
        get: <T>(key: string) => kvGet<T>(registry.store, `source:${kind.id}:${key}`),
        set: (key: string, value: unknown) => kvSet(registry.store, `source:${kind.id}:${key}`, value),
      },
      facts: facts => { registry.factsBy.set(kind.id, { ...(registry.factsBy.get(kind.id) ?? {}), ...facts }) },
      health: (status, detail) => { registry.healths.set(kind.id, { status, ...(detail ? { detail } : {}), at: Date.now() }) },
      log: (...args) => console.log(`[${kind.id}]`, ...args),
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
