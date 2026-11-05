/** Turns a stored provider plus its key into AI SDK model objects, and lists a provider's live models. */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { EmbeddingModelV4, LanguageModelV4 } from '@ai-sdk/provider'
import type { ProviderKind } from './catalog'
import { SYSTEM_ONE_BASE, systemOneClient, type SystemOneClient } from './systemone'

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
}

export type ModelFactory = {
  language(provider: ProviderRecord, apiKey: string | undefined, model: string): LanguageModelV4
  embedding(provider: ProviderRecord, apiKey: string | undefined, model: string): EmbeddingModelV4
  /** Decision models (TypeSafe Jev). Defaults to the HTTP client. */
  systemOne?(provider: ProviderRecord, apiKey: string | undefined): SystemOneClient
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
  systemOne: (p, key) => systemOneClient(p.baseUrl, key, p.options.headers),
}

const DEFAULT_BASE: Partial<Record<ProviderKind, string>> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com',
  typesafe: SYSTEM_ONE_BASE,
}

/** Live model ids from the provider's list endpoint. */
export async function listProviderModels(p: ProviderRecord, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const base = (p.baseUrl ?? DEFAULT_BASE[p.kind] ?? '').replace(/\/+$/, '')
  if (!base) throw new Error('no base URL')
  const headers: Record<string, string> = { ...p.options.headers }
  let url = `${base}/models`
  if (p.kind === 'anthropic') { if (apiKey) headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; url += '?limit=1000' }
  else if (p.kind === 'google') { if (apiKey) headers['x-goog-api-key'] = apiKey; url += '?pageSize=1000' }
  else if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const body = await response.json() as { data?: { id: string }[]; models?: { name: string }[] }
  const ids = body.data?.map(m => m.id) ?? body.models?.map(m => m.name.replace(/^models\//, '')) ?? []
  return [...new Set(ids)].sort()
}
