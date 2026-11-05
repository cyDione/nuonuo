/**
 * TypeSafe's System One API (the Jev models): a decision model, not a chat model. A request is a state plus typed questions;
 * a choice question returns the picked option, per-option probabilities and a confidence. It has no chat endpoint, so it is
 * called directly here and only serves layers that need a decision (the reviewer). https://docs.typesafe.ai/api/system-one
 */
import { APICallError } from '@ai-sdk/provider'

export const SYSTEM_ONE_BASE = 'https://api.typesafe.ai/v1'

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
  usage?: { input_tokens?: number; output_tokens?: number }
}

export type SystemOneClient = (request: SystemOneRequest, options?: { abortSignal?: AbortSignal }) => Promise<SystemOneResponse>

/** A client for one provider. Errors are APICallErrors, so the hub's retry and fallback rules apply (429 and 529 retry). */
export function systemOneClient(baseUrl: string | null, apiKey: string | undefined, headers: Record<string, string> = {}, fetchImpl: typeof fetch = fetch): SystemOneClient {
  const url = `${(baseUrl || SYSTEM_ONE_BASE).replace(/\/+$/, '')}/systemone`
  return async (request, options = {}) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
      body: JSON.stringify(request),
      signal: options.abortSignal ?? AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new APICallError({ message: `${response.status} ${response.statusText}`.trim(), url, requestBodyValues: { model: request.model },
        statusCode: response.status, responseBody: text, isRetryable: response.status === 429 || response.status >= 500 })
    }
    try { return JSON.parse(text) as SystemOneResponse }
    catch { throw new APICallError({ message: 'System One 返回的不是 JSON', url, requestBodyValues: { model: request.model }, statusCode: response.status, responseBody: text.slice(0, 300) }) }
  }
}
