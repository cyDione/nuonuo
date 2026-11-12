/**
 * TypeSafe's System One API (the Jev models): a decision model, not a chat model. A request is a state plus typed questions;
 * a choice question returns the picked option, per-option probabilities and a confidence. It has no chat endpoint, so it is
 * called directly here and only serves layers that need a decision (the reviewer). https://docs.typesafe.ai/api/system-one
 */
import { APICallError } from '@ai-sdk/provider'
import { SYSTEM_ONE_BASE } from './catalog'

export type SystemOneQuestion =
  | { type: 'choice'; instructions?: unknown; criteria: Record<string, unknown> }
  | { type: 'noul'; instructions?: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'score'; instructions?: unknown; criteria: unknown[] }

export interface SystemOneRequest {
  model: string
  state: unknown
  questions: Record<string, SystemOneQuestion>
}

export type SystemOneAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, unknown> }

export interface SystemOneResponse {
  model: string
  answers: Record<string, SystemOneAnswer>
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
}

export type SystemOneClient = (request: SystemOneRequest, options?: { abortSignal?: AbortSignal }) => Promise<SystemOneResponse>

/**
 * Where a provider serves decisions. TypeSafe itself: `/systemone`. A multi-provider gateway (one-api / new-api style, or
 * OpenRouter) offers Jev on a decisions endpoint of its own next to chat/completions, so for those the known paths are
 * tried in order and the first that exists is remembered. `options.decisionsUrl` on the provider pins one.
 */
export function decisionEndpoints(baseUrl: string | null, kind: string, pinned?: unknown): string[] {
  if (typeof pinned === 'string' && pinned.trim()) return [pinned.trim()]
  const base = decisionBase(baseUrl)
  if (kind === 'typesafe') return [`${base}/systemone`]
  const urls = [`${base}/systemone`, `${base}/decisions`]
  // OpenRouter: https://openrouter.ai/api/v1 → https://openrouter.ai/api/alpha/decisions
  if (/\/v1$/.test(base)) urls.push(`${base.replace(/\/v1$/, '')}/alpha/decisions`, `${base.replace(/\/v1$/, '')}/v1/alpha/decisions`)
  return [...new Set(urls)]
}

/**
 * The API root a decision endpoint hangs off. People often paste a gateway's bare host (`https://gw.example`) or the full
 * endpoint (`…/v1/systemone`); on a gateway the bare host's `/systemone` is its web console, which answers 401 asking for a
 * sign-in cookie. So a trailing endpoint is dropped and a missing version segment becomes `/v1`.
 */
export function decisionBase(baseUrl: string | null): string {
  let base = (baseUrl?.trim() || SYSTEM_ONE_BASE).replace(/\/+$/, '')
  base = base.replace(/\/(systemone|decisions|alpha\/decisions)$/, '')
  if (!/\/v\d+(alpha|beta)?\d*$/.test(base)) base += '/v1'
  return base
}

function looksLikeApiError(text: string): boolean {
  try { return typeof JSON.parse(text) === 'object' } catch { return false }
}

const working = new Map<string, string>()

/**
 * A client for one provider. Errors are APICallErrors, so the hub's retry and fallback rules apply (429 and 5xx retry).
 * A 404 or 405 moves on to the next candidate endpoint.
 */
export function systemOneClient(endpoints: string | string[], apiKey: string | undefined, headers: Record<string, string> = {}, fetchImpl: typeof fetch = fetch): SystemOneClient {
  const candidates = typeof endpoints === 'string' ? [endpoints] : endpoints
  const cacheKey = candidates.join(' ')
  return async (request, options = {}) => {
    const known = working.get(cacheKey)
    const order = known ? [known, ...candidates.filter(u => u !== known)] : candidates
    let lastError: unknown
    for (const url of order) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
        body: JSON.stringify(request),
        signal: options.abortSignal ?? AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      if (!response.ok) {
        const status = `${response.status} ${response.statusText}`.trim()
        const hint = !looksLikeApiError(text)
          ? `：${url} 回的不是 API 的 JSON，Base URL 可能指向了网页而不是 API（网关一般要以 /v1 结尾）`
          : response.status === 401 || response.status === 403 ? '：密钥无效或没有权限，检查 API Key' : ''
        lastError = new APICallError({ message: status + hint, url, requestBodyValues: { model: request.model },
          statusCode: response.status, responseBody: text, isRetryable: response.status === 429 || response.status >= 500 })
        if ((response.status === 404 || response.status === 405) && url !== order.at(-1)) continue
        if (response.status === 404 || response.status === 405) {
          throw new APICallError({ message: `没有找到决策接口（试过 ${order.join('、')}）。如果网关的地址不同，在供应商选项里设置 decisionsUrl`,
            url, requestBodyValues: { model: request.model }, statusCode: response.status, responseBody: text.slice(0, 300), isRetryable: false })
        }
        throw lastError
      }
      let parsed: SystemOneResponse | undefined
      try { parsed = JSON.parse(text) as SystemOneResponse } catch { /* a gateway's web page, not this API */ }
      if (!parsed || typeof parsed.answers !== 'object' || parsed.answers === null) {
        lastError = new APICallError({ message: `${url} 的回复不是决策结果（没有 answers）`, url, requestBodyValues: { model: request.model }, statusCode: response.status, responseBody: text.slice(0, 300), isRetryable: false })
        if (url !== order.at(-1)) continue
        throw lastError
      }
      working.set(cacheKey, url)
      return parsed
    }
    throw lastError
  }
}
