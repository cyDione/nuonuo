/**
 * ModelHub: the one place that knows providers, keys and the per-layer configuration. Callers ask for a layer (`router`,
 * `worker`, ...) and get a model that applies the layer's settings, walks its fallback chain, enforces its daily budget and
 * records usage — so no other code ever handles an API key.
 */
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { newId, schema, type Store } from '@super-agent/db'
import { generateText } from 'ai'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { ProviderKind } from './catalog'
import type { EmbeddingModelV4 } from '@ai-sdk/provider'
import { defaultFactory, listProviderModels, type ModelFactory, type ProviderOptions, type ProviderRecord } from './factory'
import { ENV_PROVIDERS, ENV_REF, envVarOf } from './env'
import { resolveRole, ROLE_IDS, RoleConfigSchema, type ModelRef, type ResolvedRole, type RoleConfig, type RoleId } from './roles'
import type { SecretStore } from './secrets'

export class ModelError extends Error {
  constructor(readonly code: 'no_model' | 'budget' | 'unknown_provider' | 'invalid', message: string) { super(message) }
}

export interface ProviderInput {
  kind: ProviderKind
  name: string
  baseUrl?: string | null
  /** `undefined` keeps the stored key, `null` or '' removes it. */
  apiKey?: string | null
  options?: ProviderOptions
}

export interface ProviderView extends Omit<ProviderRecord, 'secretRef'> { hasKey: boolean; keyHint?: string; keyEnv?: string }

export interface UsageSummaryRow { role: string; providerId: string; model: string; calls: number; failures: number
  inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number; costUsd: number | null }

export interface CallContext { ref?: string }

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
export function isRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable || (error.statusCode !== undefined && RETRYABLE.has(error.statusCode))
  const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code ?? '')
    || (error instanceof Error && error.name === 'TimeoutError')
}

const startOfDay = (now: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() }

export class ModelHub {
  constructor(private store: Store, private secrets: SecretStore, private factory: ModelFactory = defaultFactory,
    private now: () => number = Date.now) {}

  // ── Providers ────────────────────────────────────────────────────────────

  listProviders(): ProviderView[] {
    return this.store.db.select().from(schema.providers).all().map(row => this.view(row as ProviderRecord))
  }

  getProvider(id: string): ProviderRecord {
    const row = this.store.db.select().from(schema.providers).where(eq(schema.providers.id, id)).get()
    if (!row) throw new ModelError('unknown_provider', `no provider ${id}`)
    return row as ProviderRecord
  }

  createProvider(input: ProviderInput): ProviderView {
    const id = newId('prv')
    const secretRef = input.apiKey ? `provider:${id}` : null
    if (secretRef) this.secrets.set(secretRef, input.apiKey!)
    this.store.db.insert(schema.providers).values({ id, kind: input.kind, name: input.name.trim(), baseUrl: input.baseUrl || null,
      secretRef, options: input.options ?? {} }).run()
    return this.view(this.getProvider(id))
  }

  updateProvider(id: string, input: Partial<ProviderInput>): ProviderView {
    const current = this.getProvider(id)
    let secretRef = current.secretRef
    if (input.apiKey !== undefined && secretRef?.startsWith(ENV_REF)) throw new ModelError('invalid', `这个供应商的密钥来自环境变量 ${secretRef.slice(ENV_REF.length)}，请修改环境变量`)
    if (input.apiKey !== undefined) {
      if (input.apiKey) { secretRef = `provider:${id}`; this.secrets.set(secretRef, input.apiKey) }
      else { if (secretRef) this.secrets.delete(secretRef); secretRef = null }
    }
    this.store.db.update(schema.providers).set({
      ...(input.kind ? { kind: input.kind } : {}), ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl || null } : {}),
      ...(input.options ? { options: input.options } : {}), secretRef, updatedAt: this.now(),
    }).where(eq(schema.providers.id, id)).run()
    return this.view(this.getProvider(id))
  }

  /** Removes the provider, its key, and every layer chain entry that pointed at it. */
  deleteProvider(id: string): void {
    const current = this.getProvider(id)
    this.store.atomic(() => {
      for (const [role, config] of Object.entries(this.roleConfigs()) as [RoleId, RoleConfig][]) {
        const chain = config.chain.filter(ref => ref.providerId !== id)
        if (chain.length !== config.chain.length) this.saveRole(role, { ...config, chain })
      }
      this.store.db.delete(schema.providers).where(eq(schema.providers.id, id)).run()
    })
    if (current.secretRef) this.secrets.delete(current.secretRef)
  }

  /**
   * Registers a provider for each known `*_API_KEY` variable that is set and not yet registered. Returns the ids created.
   * A provider whose variable was later unset stays, showing no key, so layer configuration survives a shell without it.
   */
  syncEnvProviders(env: NodeJS.ProcessEnv = process.env): string[] {
    const existing = new Set(this.store.db.select({ ref: schema.providers.secretRef }).from(schema.providers).all().map(r => r.ref))
    const created: string[] = []
    for (const spec of ENV_PROVIDERS) {
      const name = envVarOf(spec, env)
      if (!name || spec.env.some(n => existing.has(`${ENV_REF}${n}`))) continue
      const id = newId('prv')
      const baseUrl = (spec.baseUrlEnv && env[spec.baseUrlEnv]?.trim()) || spec.baseUrl || null
      this.store.db.insert(schema.providers).values({ id, kind: spec.kind, name: spec.name, baseUrl,
        secretRef: `${ENV_REF}${name}`, options: {} }).run()
      created.push(id)
    }
    return created
  }

  /** First start only: puts the main layer on `model` (the other layers inherit it); does nothing once any layer is configured. */
  applyDefaultModel(providerId: string, model: string): boolean {
    this.getProvider(providerId)
    if (Object.values(this.roleConfigs()).some(c => c.chain.length > 0)) return false
    this.saveRole('router', { enabled: true, chain: [{ providerId, model }] })
    return true
  }

  async listModels(id: string): Promise<string[]> {
    const p = this.getProvider(id)
    return listProviderModels(p, this.key(p))
  }

  /** Sends a tiny request through one provider/model, bypassing layers, budgets and the ledger. */
  async testModel(ref: ModelRef): Promise<{ ok: true; latencyMs: number; text: string } | { ok: false; latencyMs: number; error: string }> {
    const started = this.now()
    try {
      const p = this.getProvider(ref.providerId)
      const result = await generateText({ model: this.factory.language(p, this.key(p), ref.model), prompt: 'Reply with the single word: OK',
        maxOutputTokens: 256, maxRetries: 0, abortSignal: AbortSignal.timeout(30_000) })
      return { ok: true, latencyMs: this.now() - started, text: result.text.trim().slice(0, 200) }
    } catch (error) {
      return { ok: false, latencyMs: this.now() - started, error: describeError(error) }
    }
  }

  // ── Layers ───────────────────────────────────────────────────────────────

  roleConfigs(): Partial<Record<RoleId, RoleConfig>> {
    const out: Partial<Record<RoleId, RoleConfig>> = {}
    for (const row of this.store.db.select().from(schema.modelRoles).all()) {
      if ((ROLE_IDS as readonly string[]).includes(row.role)) out[row.role as RoleId] = RoleConfigSchema.parse(row.config)
    }
    return out
  }

  saveRole(role: RoleId, input: unknown): RoleConfig {
    if (!ROLE_IDS.includes(role)) throw new ModelError('invalid', `unknown layer ${role}`)
    const parsed = RoleConfigSchema.safeParse(input)
    if (!parsed.success) throw new ModelError('invalid', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
    for (const ref of parsed.data.chain) this.getProvider(ref.providerId)
    this.store.db.insert(schema.modelRoles).values({ role, config: parsed.data, updatedAt: this.now() })
      .onConflictDoUpdate({ target: schema.modelRoles.role, set: { config: parsed.data, updatedAt: this.now() } }).run()
    return parsed.data
  }

  resolve(role: RoleId): ResolvedRole | undefined {
    return resolveRole(role, this.roleConfigs())
  }

  /**
   * The model for a layer. It applies the layer's reasoning/temperature/max tokens unless the call sets them, refuses calls
   * past the daily budget, tries the chain in order on retryable failures (for streams, only before the first chunk),
   * and writes one ledger row per attempt.
   */
  model(role: RoleId, context: CallContext = {}): LanguageModelV4 {
    const resolved = this.resolve(role)
    if (!resolved) throw new ModelError('no_model', `layer ${role} has no model configured`)
    const hub = this
    const first = resolved.config.chain[0]!
    const applyDefaults = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => ({
      ...options,
      ...(options.maxOutputTokens === undefined && resolved.config.maxOutputTokens ? { maxOutputTokens: resolved.config.maxOutputTokens } : {}),
      ...(options.temperature === undefined && resolved.config.temperature !== undefined ? { temperature: resolved.config.temperature } : {}),
      ...(options.reasoning === undefined && resolved.config.reasoning ? { reasoning: resolved.config.reasoning } : {}),
    })

    async function attempt<T>(run: (model: LanguageModelV4, ref: ModelRef) => Promise<T>): Promise<T> {
      hub.checkBudget(role, resolved!.config)
      let lastError: unknown
      for (const [index, ref] of resolved!.config.chain.entries()) {
        let model: LanguageModelV4
        try {
          const p = hub.getProvider(ref.providerId)
          model = hub.factory.language(p, hub.key(p), ref.model)
        } catch (error) { lastError = error; continue }
        try {
          return await run(model, ref)
        } catch (error) {
          lastError = error
          hub.record(role, ref, undefined, context, error)
          const last = index === resolved!.config.chain.length - 1
          if (last || !isRetryable(error)) throw error
        }
      }
      throw lastError
    }

    return {
      specificationVersion: 'v4',
      provider: `superagent.${role}`,
      modelId: first.model,
      supportedUrls: {},
      doGenerate: options => attempt(async (model, ref) => {
        const result = await model.doGenerate(applyDefaults(options))
        hub.record(role, ref, result.usage, context)
        return result
      }),
      doStream: options => attempt(async (model, ref) => {
        const result = await model.doStream(applyDefaults(options))
        let recorded = false
        const stream = result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === 'finish' && !recorded) { recorded = true; hub.record(role, ref, part.usage, context) }
            if (part.type === 'error' && !recorded) { recorded = true; hub.record(role, ref, undefined, context, part.error) }
            controller.enqueue(part)
          },
          flush() { if (!recorded) hub.record(role, ref, undefined, context, new Error('stream ended without usage')) },
        }))
        return { ...result, stream }
      }),
    }
  }

  // ── Usage ────────────────────────────────────────────────────────────────

  usageSince(since: number): UsageSummaryRow[] {
    return this.store.sqlite.prepare(`SELECT role, provider_id AS providerId, model, count(*) AS calls, sum(ok = 0) AS failures,
        sum(input_tokens) AS inputTokens, sum(output_tokens) AS outputTokens, sum(cache_read_tokens) AS cacheReadTokens,
        sum(reasoning_tokens) AS reasoningTokens, sum(cost_usd) AS costUsd
      FROM usage_ledger WHERE at >= ? GROUP BY role, provider_id, model ORDER BY role, model`).all(since) as UsageSummaryRow[]
  }

  usageToday(role: RoleId): { tokens: number; costUsd: number } {
    const row = this.store.db.select({
      tokens: sql<number>`coalesce(sum(${schema.usageLedger.inputTokens} + ${schema.usageLedger.outputTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${schema.usageLedger.costUsd}), 0)`,
    }).from(schema.usageLedger).where(and(eq(schema.usageLedger.role, role), gte(schema.usageLedger.at, startOfDay(this.now())))).get()
    return { tokens: row?.tokens ?? 0, costUsd: row?.cost ?? 0 }
  }

  private checkBudget(role: RoleId, config: RoleConfig): void {
    if (config.dailyTokenLimit === undefined && config.dailyCostLimitUsd === undefined) return
    const today = this.usageToday(role)
    if (config.dailyTokenLimit !== undefined && today.tokens >= config.dailyTokenLimit) {
      throw new ModelError('budget', `layer ${role} reached its daily token limit (${today.tokens}/${config.dailyTokenLimit})`)
    }
    if (config.dailyCostLimitUsd !== undefined && today.costUsd >= config.dailyCostLimitUsd) {
      throw new ModelError('budget', `layer ${role} reached its daily cost limit ($${today.costUsd.toFixed(4)}/$${config.dailyCostLimitUsd})`)
    }
  }

  private record(role: RoleId, ref: ModelRef, usage: LanguageModelV4Usage | undefined, context: CallContext, error?: unknown): void {
    const input = usage?.inputTokens.total ?? 0
    const output = usage?.outputTokens.total ?? 0
    const cacheRead = usage?.inputTokens.cacheRead ?? 0
    const cacheWrite = usage?.inputTokens.cacheWrite ?? 0
    let cost: number | null = null
    try {
      const price = this.getProvider(ref.providerId).options.prices?.[ref.model]
      if (price && usage) {
        const noCache = usage.inputTokens.noCache ?? Math.max(0, input - cacheRead - cacheWrite)
        cost = (noCache * (price.input ?? 0) + output * (price.output ?? 0) + cacheRead * (price.cacheRead ?? price.input ?? 0)
          + cacheWrite * (price.cacheWrite ?? price.input ?? 0)) / 1_000_000
      }
    } catch { /* provider deleted meanwhile */ }
    this.store.db.insert(schema.usageLedger).values({
      at: this.now(), role, providerId: ref.providerId, model: ref.model, inputTokens: input, outputTokens: output,
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: usage?.outputTokens.reasoning ?? 0,
      costUsd: cost, ref: context.ref ?? null, ok: !error, error: error ? describeError(error).slice(0, 500) : null,
    }).run()
  }

  /** The embedding layer's model, when one is configured (memory search falls back to keywords without it). */
  embeddingModel(): EmbeddingModelV4 | undefined {
    const resolved = this.resolve('embedding')
    const ref = resolved?.config.chain[0]
    if (!resolved || !ref) return undefined
    try { const p = this.getProvider(ref.providerId); return this.factory.embedding(p, this.key(p), ref.model) } catch { return undefined }
  }

  private key(p: ProviderRecord): string | undefined {
    return p.secretRef ? this.secrets.get(p.secretRef) : undefined
  }

  private view(p: ProviderRecord): ProviderView {
    const { secretRef, ...rest } = p
    const key = secretRef ? this.secrets.get(secretRef) : undefined
    return { ...rest, hasKey: Boolean(key), ...(key ? { keyHint: `…${key.slice(-4)}` } : {}),
      ...(secretRef?.startsWith(ENV_REF) ? { keyEnv: secretRef.slice(ENV_REF.length) } : {}) }
  }
}

export function describeError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const body = typeof error.responseBody === 'string' ? error.responseBody.slice(0, 300) : ''
    return `${error.statusCode ?? ''} ${error.message}${body ? ` — ${body}` : ''}`.trim()
  }
  return error instanceof Error ? error.message : String(error)
}
