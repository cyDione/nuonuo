/** Turns a stored provider plus its key into AI SDK model objects, and lists a provider's live models. */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { EmbeddingModelV4, LanguageModelV4 } from '@ai-sdk/provider'
import { DECISION_MODEL_SUGGESTIONS, KINDS, type ProviderKind } from './catalog'
import { mergeCatalogs, jevIdsIn, parseModelCatalog, type ModelInfo, type ModelType } from './discovery'
import { decisionEndpoints, systemOneClient, type SystemOneClient } from './systemone'

export interface ProviderRecord {
  id: string
  kind: ProviderKind
  name: string
  baseUrl: string | null
  secretRef: string | null
  options: ProviderOptions
}

export interface ProviderOptions {
  [key: string]: unknown
  /** USD per million tokens, keyed by model id, for cost estimates in the usage view. */
  prices?: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>
  headers?: Record<string, string>
  /** Full URL of a gateway's decisions endpoint (for Jev), when it is not at a known path. */
  decisionsUrl?: string
}

export type ModelFactory = {
  language(provider: ProviderRecord, apiKey: string | undefined, model: string): LanguageModelV4
  embedding(provider: ProviderRecord, apiKey: string | undefined, model: string): EmbeddingModelV4
  /** Decision models (TypeSafe Jev). Defaults to the HTTP client. */
  systemOne?(provider: ProviderRecord, apiKey: string | undefined): SystemOneClient
  /** Live models, as ids or tagged by type (an id alone is typed from its name). Defaults to the provider's list endpoints. */
  listModels?(provider: ProviderRecord, apiKey: string | undefined): Promise<(string | ModelInfo)[]>
}

function sdkProvider(p: ProviderRecord, apiKey: string | undefined) {
  const base = p.baseUrl ?? undefined
  const headers = p.options.headers
  switch (p.kind) {
    case 'anthropic': return createAnthropic({ apiKey, baseURL: base, headers })
    case 'openai': return createOpenAI({ apiKey, baseURL: base, headers })
    case 'google': return createGoogleGenerativeAI({ apiKey, baseURL: base, headers })
    case 'deepseek': return createDeepSeek({ apiKey, baseURL: base, headers })
    case 'openai-compatible':
      if (!base) throw new Error(`provider ${p.name} needs a base URL`)
      return createOpenAICompatible({ name: p.id, baseURL: base, apiKey: apiKey || 'none', headers, includeUsage: true })
    case 'typesafe': throw new Error(`${p.name} 是决策模型（TypeSafe Jev），没有对话接口，只能用于审核层`)
  }
}

export const defaultFactory: ModelFactory = {
  language: (p, key, model) => sdkProvider(p, key).languageModel(model) as unknown as LanguageModelV4,
  embedding: (p, key, model) => {
    const provider = sdkProvider(p, key) as any
    const make = provider.embeddingModel ?? provider.textEmbeddingModel
    if (!make) throw new Error(`${p.kind} has no embedding models`)
    return make.call(provider, model) as EmbeddingModelV4
  },
  systemOne: (p, key) => systemOneClient(decisionEndpoints(p.baseUrl, p.kind, p.options.decisionsUrl), key, p.options.headers),
}

/** The headers a provider's list endpoints take, from its kind's spec. */
function listHeaders(p: ProviderRecord, apiKey: string | undefined): Record<string, string> {
  const spec = KINDS[p.kind]
  const headers: Record<string, string> = { ...spec.headers, ...p.options.headers }
  if (apiKey) {
    if (spec.auth === 'bearer') headers.authorization = `Bearer ${apiKey}`
    else headers[spec.auth] = apiKey
  }
  return headers
}

/**
 * Every model a provider serves, tagged by type: its `/models`, plus what `/models` leaves out on OpenAI-style APIs — the
 * embeddings list OpenRouter keeps on `/embeddings/models`, and the Jev a gateway serves on its decision endpoint. The
 * extra sources are best effort; only a failed `/models` fails the call, since that is the sign the provider is unreachable.
 */
export async function listProviderModels(p: ProviderRecord, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  const spec = KINDS[p.kind]
  const base = (p.baseUrl ?? spec.baseUrl ?? '').replace(/\/+$/, '')
  if (!base) throw new Error('no base URL')
  const headers = listHeaders(p, apiKey)
  const get = async (url: string, fallback?: ModelType, timeout = 15_000) => {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return parseModelCatalog(await response.json(), p.kind, fallback)
  }
  const mainUrl = `${base}/models${spec.listQuery ? `?${spec.listQuery}` : ''}`
  const [main, embeddings, decisions] = await Promise.allSettled([
    get(mainUrl),
    spec.embeddingsList ? get(`${base}/embeddings/models`, 'embedding', 8_000) : Promise.resolve([]),
    spec.probeDecisions ? probeDecisionModels(p, apiKey, fetchImpl) : Promise.resolve([]),
  ])
  if (main.status === 'rejected') throw main.reason
  const extra = embeddings.status === 'fulfilled' ? embeddings.value : []
  // A gateway that answers any path with its whole list is not an embeddings list.
  const same = extra.length === main.value.length && extra.every(m => main.value.some(n => n.id === m.id))
  return mergeCatalogs(main.value, same ? [] : extra, decisions.status === 'fulfilled' ? decisions.value : [])
}

/**
 * The Jev models a gateway serves, which it does not list on `/models`. Asks each decision endpoint about a model that does
 * not exist, which costs nothing: a gateway that names its Jev in the error (magpie: "like typesafe/jev-latest") gives the
 * ids, and one that answers with an API error rather than "no such path" has the endpoint, so the usual Jev id is offered.
 */
export async function probeDecisionModels(p: ProviderRecord, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...p.options.headers }
  for (const url of decisionEndpoints(p.baseUrl, p.kind, p.options.decisionsUrl)) {
    let status: number
    let text: string
    try {
      const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ model: '?', state: '', questions: {} }), signal: AbortSignal.timeout(8_000) })
      status = response.status
      text = await response.text()
    } catch { continue }
    const ids = jevIdsIn(text)
    if (ids.length) return ids.map(id => ({ id, type: 'decision' as const }))
    let json = false
    try { json = typeof JSON.parse(text) === 'object' } catch { /* a web page */ }
    if (json && status >= 400 && ![401, 403, 404, 405].includes(status) && !/not.?found|no route|invalid url|unknown (path|route|endpoint)/i.test(text)) {
      return DECISION_MODEL_SUGGESTIONS.map(id => ({ id, type: 'decision' as const }))
    }
  }
  return []
}

/** Model ids from a list response, in any of the shapes {@link parseModelCatalog} reads. */
export function parseModelList(body: unknown): string[] {
  return parseModelCatalog(body).map(m => m.id)
}
