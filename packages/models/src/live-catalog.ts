/**
 * The live model table. A preset's suggestions used to be a list written into the code, so they went stale the week a
 * provider shipped a new model. Now they come from models.dev (a public, community-kept table of every provider's models
 * with release dates), fetched in the background, trimmed to what the settings page needs and cached in the data
 * directory. Offline, or before the first fetch, the bundled `suggestedModels` of each preset are used instead.
 *
 * `NUONUO_MODEL_CATALOG_URL` points at another copy of the table (same shape); `off` turns fetching off.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { PROVIDER_PRESETS, type ProviderPreset } from './catalog'

export const MODEL_CATALOG_URL = 'https://models.dev/api.json'
const DAY = 24 * 60 * 60 * 1000

/** Which models.dev provider each preset is. Local runtimes and custom endpoints have none: their own list is the truth. */
export const CATALOG_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: 'anthropic', openai: 'openai', google: 'google', deepseek: 'deepseek', openrouter: 'openrouter',
  dashscope: 'alibaba-cn', moonshot: 'moonshotai-cn', zhipu: 'zhipuai', siliconflow: 'siliconflow-cn',
}

export interface CatalogModel {
  id: string
  name?: string
  family?: string
  releaseDate?: string
  /** USD per million tokens. */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  context?: number
}

export interface CatalogSnapshot { fetchedAt: number; source: string; providers: Record<string, CatalogModel[]> }

/** On an aggregator the newest models are mostly small or free previews; suggest the major labs' models only. */
const AGGREGATOR_VENDORS: Readonly<Record<string, RegExp>> = {
  openrouter: /^(anthropic|openai|google|deepseek|qwen|moonshotai|z-ai|x-ai|mistralai|meta-llama|minimax)\/[^:]+$/,
}

/** How many suggestions a preset shows; the rest of a provider's models come from its own live list once a key is set. */
const KEEP = 8

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * The newest chat models of each preset's provider: text out, tool calling (every layer uses tools), not deprecated or
 * experimental, newest first, one per family so a provider's three dated snapshots of one model do not crowd out the rest.
 */
export function parseCatalog(body: unknown, source = MODEL_CATALOG_URL, now = Date.now()): CatalogSnapshot {
  if (!body || typeof body !== 'object') throw new Error('模型表格式不对')
  const table = body as Record<string, { models?: Record<string, Record<string, unknown>> }>
  const providers: Record<string, CatalogModel[]> = {}
  for (const [preset, providerId] of Object.entries(CATALOG_PROVIDER)) {
    const models = table[providerId]?.models
    if (!models || typeof models !== 'object') continue
    const usable = Object.values(models).filter(m => {
      const out = (m.modalities as { output?: unknown } | undefined)?.output
      return str(m.id) && m.tool_call === true && m.status !== 'deprecated' && m.experimental !== true
        && (!Array.isArray(out) || out.includes('text')) && (AGGREGATOR_VENDORS[preset]?.test(String(m.id)) ?? true)
    })
    usable.sort((a, b) => (str(b.release_date) ?? '').localeCompare(str(a.release_date) ?? '') || String(a.id).localeCompare(String(b.id)))
    const families = new Set<string>()
    const list: CatalogModel[] = []
    for (const m of usable) {
      const family = str(m.family)
      if (family && families.has(family)) continue
      if (family) families.add(family)
      const cost = m.cost as Record<string, unknown> | undefined
      const limit = m.limit as Record<string, unknown> | undefined
      const prices = cost && { input: num(cost.input), output: num(cost.output), cacheRead: num(cost.cache_read), cacheWrite: num(cost.cache_write) }
      list.push({ id: String(m.id), ...(str(m.name) ? { name: str(m.name) } : {}), ...(family ? { family } : {}),
        ...(str(m.release_date) ? { releaseDate: str(m.release_date) } : {}),
        ...(prices && Object.values(prices).some(v => v !== undefined) ? { cost: Object.fromEntries(Object.entries(prices).filter(([, v]) => v !== undefined)) } : {}),
        ...(num(limit?.context) ? { context: num(limit?.context) } : {}) })
      if (list.length >= KEEP) break
    }
    if (list.length) providers[preset] = list
  }
  if (!Object.keys(providers).length) throw new Error('模型表里没有认识的供应商')
  return { fetchedAt: now, source, providers }
}

export interface LiveCatalogOptions {
  /** Cache file, normally `<home>/model-catalog.json`. */
  file?: string
  url?: string
  fetch?: typeof fetch
  now?: () => number
  /** How old a snapshot may get before it is fetched again. */
  maxAgeMs?: number
}

export class LiveCatalog {
  private snapshot: CatalogSnapshot | undefined
  private inflight: Promise<CatalogSnapshot> | undefined
  private lastError: string | undefined
  readonly url: string | undefined
  private readonly maxAge: number

  constructor(private options: LiveCatalogOptions = {}) {
    const url = options.url ?? process.env.NUONUO_MODEL_CATALOG_URL?.trim() ?? MODEL_CATALOG_URL
    this.url = url && url !== 'off' ? url : undefined
    this.maxAge = options.maxAgeMs ?? DAY
    if (options.file && existsSync(options.file)) {
      try {
        const saved = JSON.parse(readFileSync(options.file, 'utf8')) as CatalogSnapshot
        if (saved && typeof saved.fetchedAt === 'number' && saved.providers) this.snapshot = saved
      } catch { /* a broken cache is fetched again */ }
    }
  }

  private now() { return (this.options.now ?? Date.now)() }

  /** The live suggestions for a preset, else its bundled ones. */
  suggestions(preset: ProviderPreset): string[] {
    const live = this.snapshot?.providers[preset.id]?.map(m => m.id)
    return live?.length ? live : preset.suggestedModels
  }

  /** What the table says about one model of a preset (price, context, release date). */
  model(presetId: string, model: string): CatalogModel | undefined {
    return this.snapshot?.providers[presetId]?.find(m => m.id === model)
  }

  /** The presets with live suggestions in place of the bundled ones. */
  presets(): ProviderPreset[] {
    return PROVIDER_PRESETS.map(p => ({ ...p, suggestedModels: this.suggestions(p) }))
  }

  status(): { source: string | null; fetchedAt: number | null; live: boolean; error?: string } {
    return { source: this.url ?? null, fetchedAt: this.snapshot?.fetchedAt ?? null, live: Boolean(this.snapshot),
      ...(this.lastError ? { error: this.lastError } : {}) }
  }

  stale(): boolean { return Boolean(this.url) && (!this.snapshot || this.now() - this.snapshot.fetchedAt >= this.maxAge) }

  /** Fetches the table now (one request at a time); keeps the previous snapshot when it fails. */
  refresh(): Promise<CatalogSnapshot> {
    if (!this.url) return Promise.reject(new Error('已关闭在线模型表（NUONUO_MODEL_CATALOG_URL=off）'))
    this.inflight ??= (async () => {
      try {
        const res = await (this.options.fetch ?? fetch)(this.url!, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`模型表返回 ${res.status}`)
        const next = parseCatalog(await res.json(), this.url, this.now())
        this.snapshot = next
        this.lastError = undefined
        if (this.options.file) { try { writeFileSync(this.options.file, JSON.stringify(next)) } catch { /* read-only home: keep it in memory */ } }
        return next
      } catch (error) {
        this.lastError = (error as Error).message
        throw error
      } finally { this.inflight = undefined }
    })()
    return this.inflight
  }

  /** Refreshes when the snapshot is older than a day; failures are kept in `status()` and never thrown. */
  async refreshIfStale(): Promise<void> {
    if (this.stale()) await this.refresh().catch(() => undefined)
  }
}
