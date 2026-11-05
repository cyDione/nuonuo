/**
 * Structured (JSON) answers from a layer's model — the reviewer's verdict, memory triage and distillation, the proactive
 * filter. Providers differ a lot here: some take a JSON schema, some only a "JSON mode" without one, some neither, and
 * reasoning models served through OpenAI-compatible endpoints often wrap the answer in <think> blocks or code fences.
 * So the format is always spelled out in the prompt (fields plus an example), the provider's structured output is used
 * where it exists, and the reply is parsed tolerantly. Failures say what actually went wrong: no model configured, budget,
 * a failed call, or a reply that could not be read.
 */
import type { ModelHub, RoleId } from '@super-assistant/models'
import { describeError, ModelError, roleSpec } from '@super-assistant/models'
import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError } from 'ai'
import type { z } from 'zod'

export type StructuredFailure = 'no_model' | 'budget' | 'call' | 'parse' | 'truncated'

export class StructuredCallError extends Error {
  constructor(readonly kind: StructuredFailure, message: string, readonly role: RoleId, readonly raw?: string) { super(message) }
}

export interface StructuredRequest<T> {
  system: string
  prompt: string
  schema: z.ZodType<T>
  /** One line per field: name, type, meaning. Shown to the model verbatim. */
  fields: string
  /** A valid answer, shown to the model as the shape to follow. */
  example: T
  ref?: string
  /** Used when neither the layer nor the layer it inherits from sets a limit. */
  maxOutputTokens?: number
}

/** Reasoning levels that are wasteful for a short classification; inherited ones are lowered to `low`. */
const HEAVY_REASONING = new Set(['medium', 'high', 'xhigh', 'max'])

export function formatInstructions(fields: string, example: unknown): string {
  return `## Output format
Reply with exactly one JSON object and nothing else: no prose before or after it, no Markdown code fences.
Fields:
${fields}
Example:
${JSON.stringify(example)}`
}

/**
 * Asks `role`'s model for an object matching `schema`. Settings the layer sets itself are respected; reasoning inherited
 * from another layer (e.g. the main agent's `high`) is lowered to `low`, and an output limit is set when none is configured.
 */
export async function generateStructured<T>(hub: ModelHub, role: RoleId, request: StructuredRequest<T>): Promise<T> {
  let model
  try { model = hub.model(role, { ref: request.ref }) } catch (error) { throw toStructuredError(error, role) }
  const own = hub.roleConfigs()[role]
  const resolved = hub.resolve(role)
  const settings: { reasoning?: 'low'; maxOutputTokens?: number } = {}
  if (!own?.reasoning && resolved?.config.reasoning && HEAVY_REASONING.has(resolved.config.reasoning)) settings.reasoning = 'low'
  if (!resolved?.config.maxOutputTokens) settings.maxOutputTokens = request.maxOutputTokens ?? 4_096
  const base = { model, system: `${request.system}\n\n${formatInstructions(request.fields, request.example)}`, prompt: request.prompt, maxRetries: 1, ...settings }

  try {
    const { output } = await generateText({ ...base, output: Output.object({ schema: request.schema }) })
    return output
  } catch (error) {
    const cause = rootCause(error)
    if (NoObjectGeneratedError.isInstance(cause)) return recover(request.schema, cause.text ?? '', cause.finishReason, role)
    if (rejectsResponseFormat(cause)) {
      // The endpoint refuses `response_format`: ask again without it; the prompt alone carries the format.
      try {
        const { text, finishReason } = await generateText(base)
        return recover(request.schema, text, finishReason, role)
      } catch (retryError) { throw toStructuredError(retryError, role) }
    }
    throw toStructuredError(error, role)
  }
}

function recover<T>(schema: z.ZodType<T>, text: string, finishReason: string | undefined, role: RoleId): T {
  for (const candidate of jsonCandidates(text)) {
    const result = schema.safeParse(candidate)
    if (result.success) return result.data
  }
  const label = roleLabel(role)
  if (finishReason === 'length') throw new StructuredCallError('truncated', `${label}模型的回复被截断（达到输出长度上限），读不出结论`, role, text)
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 80)
  throw new StructuredCallError('parse', `${label}模型有回复，但不是约定格式的 JSON${preview ? `（回复开头：“${preview}”）` : '（回复为空）'}`, role, text)
}

/**
 * Objects a reply may contain, most likely first: the whole reply, fenced blocks, then each balanced `{…}`.
 * Reasoning blocks (<think>…</think>) are dropped first; JSON inside them is the model thinking, not answering.
 */
export function jsonCandidates(text: string): unknown[] {
  const cleaned = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/^[\s\S]*<\/(think|thinking|reasoning)>/i, '').trim()
  const sources = [cleaned, ...[...cleaned.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)].map(m => m[1]!.trim())]
  for (let i = 0; i < cleaned.length; i++) if (cleaned[i] === '{') { const end = balancedEnd(cleaned, i); if (end > i) sources.push(cleaned.slice(i, end + 1)) }
  const out: unknown[] = []
  for (const source of sources) {
    try { const value = JSON.parse(source); if (value && typeof value === 'object') out.push(value) } catch { /* not JSON */ }
  }
  return out
}

/** Index of the `}` closing the object that opens at `start`, respecting strings; -1 when it never closes. */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

function rootCause(error: unknown): unknown {
  return RetryError.isInstance(error) ? error.lastError : error
}

/** A 400 that names the structured-output parameter: the endpoint (often an OpenAI-compatible server) does not support it. */
function rejectsResponseFormat(error: unknown): boolean {
  if (!APICallError.isInstance(error) || error.statusCode !== 400) return false
  const body = typeof error.responseBody === 'string' ? error.responseBody : ''
  return /response_format|json_schema|json_object|structured output|responseMimeType|response_schema/i.test(`${error.message} ${body}`)
}

const roleLabel = (role: RoleId) => roleSpec(role).label.replace(/（.*）$/, '')

/** Turns a model-layer failure into a StructuredCallError whose message says what went wrong, in the owner's words. */
export function toStructuredError(error: unknown, role: RoleId): StructuredCallError {
  if (error instanceof StructuredCallError) return error
  const cause = rootCause(error)
  const label = roleLabel(role)
  if (cause instanceof ModelError && cause.code === 'no_model') {
    const spec = roleSpec(role)
    const via = spec.inherits ? `，它默认继承的「${roleLabel(spec.inherits)}」层也没有` : ''
    return new StructuredCallError('no_model', `没有配置${label}模型${via}`, role)
  }
  if (cause instanceof ModelError && cause.code === 'budget') return new StructuredCallError('budget', `${label}模型今天的额度已用完（${cause.message}）`, role)
  return new StructuredCallError('call', `调用${label}模型失败：${describeError(cause).slice(0, 160)}`, role)
}
