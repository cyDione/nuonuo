/**
 * What a provider serves, by kind. A provider's `/models` is rarely the whole story: OpenRouter lists only chat models
 * there (embeddings are on `/embeddings/models`), and gateways serve Jev on a decision endpoint without listing it at all.
 * So discovery reads every list a provider may have, asks the decision endpoint which Jev it serves, and tags each model
 * with what it is for, from the list's own metadata where it has some and from the id where it does not.
 */
import { isDecisionModel, type ProviderKind } from './catalog'

export type ModelType = 'chat' | 'embedding' | 'rerank' | 'decision' | 'image' | 'audio' | 'video'
export const MODEL_TYPES: readonly ModelType[] = ['chat', 'embedding', 'rerank', 'decision', 'image', 'audio', 'video']

/** `created` is when the provider released the model (ms since epoch), from the list's own metadata when it has it. */
export interface ModelInfo { id: string; type: ModelType; created?: number }

const RERANK = /rerank/i
const EMBEDDING = /embed|(^|[/_.:-])(bge|e5|gte|m3e|bce)([-_.:]|$)/i
const IMAGE = /(^|[/_.:-])(dall-e|gpt-image|flux|sdxl|stable-diffusion|imagen|kolors|seedream|cogview|wanx|qwen-image|recraft|ideogram|midjourney)/i
const AUDIO = /(^|[/_.:-])(whisper|tts|speech|transcribe|cosyvoice|sensevoice|fish-speech|paraformer)/i
const VIDEO = /(^|[/_.:-])(sora|veo|kling|hailuo|seedance|cogvideo|wan[\d.]*-?(t2v|i2v|video))/i

/** What a model id alone suggests. */
export function typeFromId(id: string, kind: ProviderKind = 'openai-compatible'): ModelType {
  if (isDecisionModel(kind, id)) return 'decision'
  if (RERANK.test(id)) return 'rerank'
  if (EMBEDDING.test(id)) return 'embedding'
  if (VIDEO.test(id)) return 'video'
  if (IMAGE.test(id)) return 'image'
  if (AUDIO.test(id)) return 'audio'
  return 'chat'
}

/** A non-chat type a word in a list's metadata names (`type: "embedding"`, `sub_type: "reranker"`, `output_modalities: ["embeddings"]`…). */
function typeFromWord(word: string): ModelType | undefined {
  const w = word.toLowerCase()
  if (/rerank/.test(w)) return 'rerank'
  if (/embed/.test(w)) return 'embedding'
  if (/decision|systemone/.test(w)) return 'decision'
  if (/video/.test(w)) return 'video'
  if (/image|text-to-image|txt2img/.test(w)) return 'image'
  if (/audio|speech|tts|transcri|asr/.test(w)) return 'audio'
  return undefined
}

/**
 * The type a list entry declares. Only a declared non-chat type counts: gateways often mark every entry `type: "model"` or
 * list `/chat/completions` as the endpoint of an embedding model, so "chat" metadata never overrides what the id says.
 */
function typeFromMeta(o: Record<string, unknown>): ModelType | undefined {
  const words: string[] = []
  const add = (v: unknown) => { if (typeof v === 'string') words.push(v); else if (Array.isArray(v)) v.forEach(add) }
  for (const key of ['type', 'model_type', 'sub_type', 'subtype', 'task', 'category', 'mode', 'kind']) add(o[key])
  const arch = o.architecture as Record<string, unknown> | undefined
  if (arch && typeof arch === 'object') {
    const out = arch.output_modalities
    if (Array.isArray(out) && out.length && !out.includes('text')) add(out)
    if (typeof arch.modality === 'string') add(arch.modality.split('->')[1])
  }
  const methods = o.supportedGenerationMethods ?? o.supported_generation_methods
  if (Array.isArray(methods) && methods.length && !methods.includes('generateContent')) add(methods)
  const endpoints = o.supported_endpoint_types ?? o.endpoints ?? o.endpoint_types
  if (Array.isArray(endpoints) && endpoints.length && !endpoints.some(e => typeof e === 'string' && /chat|completion|response|message/i.test(e))) add(endpoints)
  for (const w of words) { const t = typeFromWord(w); if (t) return t }
  return undefined
}

/** The release time a list entry carries: OpenAI-style `created` (seconds), Anthropic `created_at` (ISO), or the like. */
function createdOf(o: Record<string, unknown>): number | undefined {
  for (const key of ['created', 'created_at', 'createdAt', 'released', 'release_date']) {
    const v = o[key]
    const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' && v.trim() ? (/^\d+$/.test(v) ? Number(v) * (v.length <= 10 ? 1000 : 1) : Date.parse(v)) : NaN
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  return undefined
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Newest first where the provider dates its models, then the undated ones by id. */
export function sortCatalog(list: ModelInfo[]): ModelInfo[] {
  return [...list].sort((a, b) => (b.created ?? -1) - (a.created ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Chat models that are not general-purpose assistants: realtime/audio/search/computer-use variants, moderation, old completions. */
const SPECIAL_CHAT = /realtime|audio|search|transcri|tts|moderation|instruct|computer-use|-codex|guard|ocr|(^|[/_.:-])(davinci|babbage)/i
const SMALL = /(^|[/_.:-])(mini|nano|lite|tiny|small|haiku|flash-lite)([-_.:]|$)|[-_:][1-9](\.\d+)?b([-_.:]|$)/i
const PREVIEW = /preview|(^|[-_.:])exp(erimental)?([-_.:]|$)|alpha|beta/i

/**
 * The model a new install starts on, chosen from what the provider lists right now rather than from a table in the code that
 * goes out of date: a general chat model, full size and released before a preview where the list allows, newest first by the
 * provider's own release dates, else the highest version by id. Undefined when the list has no chat model.
 */
export function pickDefaultModel(list: ModelInfo[]): string | undefined {
  const chat = list.filter(m => m.type === 'chat' && !SPECIAL_CHAT.test(m.id))
  if (!chat.length) return undefined
  const tiers = [chat.filter(m => !SMALL.test(m.id) && !PREVIEW.test(m.id)), chat.filter(m => !PREVIEW.test(m.id)), chat]
  const pool = tiers.find(t => t.length)!
  const dated = pool.filter(m => m.created !== undefined)
  if (dated.length) return dated.reduce((a, b) => (b.created! > a.created! ? b : a)).id
  return [...pool].sort((a, b) => collator.compare(b.id, a.id))[0]!.id
}

function entries(body: unknown): unknown[] {
  const nested = (v: unknown): unknown[] | undefined => {
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const key of ['data', 'models', 'items', 'list']) { const found = nested(o[key]); if (found) return found }
    }
    return undefined
  }
  return nested(body) ?? []
}

/**
 * Models from a list response: OpenAI `{ data: [{ id }] }`, Gemini `{ models: [{ name: 'models/…' }] }`, and the shapes
 * gateways use instead (a bare array, `{ data: { models: [...] } }`, plain strings, `name` / `model` in place of `id`).
 * `fallback` is the type for entries that declare none and whose id says nothing (a list that holds one kind only).
 */
export function parseModelCatalog(body: unknown, kind: ProviderKind = 'openai-compatible', fallback?: ModelType): ModelInfo[] {
  const out = new Map<string, ModelInfo>()
  for (const m of entries(body)) {
    let id: string | undefined
    let meta: ModelType | undefined
    let created: number | undefined
    if (typeof m === 'string') id = m.trim()
    else if (m && typeof m === 'object') {
      const o = m as Record<string, unknown>
      id = [o.id, o.model, o.name].find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim().replace(/^models\//, '')
      meta = typeFromMeta(o)
      created = createdOf(o)
    }
    if (!id || out.has(id)) continue
    const fromId = typeFromId(id, kind)
    const type = fromId === 'decision' ? 'decision' : meta ?? (fromId === 'chat' && fallback ? fallback : fromId)
    out.set(id, created === undefined ? { id, type } : { id, type, created })
  }
  return sortCatalog([...out.values()])
}

/** Merges model lists; an earlier list's entry wins, except that a specific type beats a guessed "chat". A known date is kept. */
export function mergeCatalogs(...lists: ModelInfo[][]): ModelInfo[] {
  const out = new Map<string, ModelInfo>()
  for (const list of lists) for (const m of list) {
    const seen = out.get(m.id)
    if (!seen || (seen.type === 'chat' && m.type !== 'chat')) out.set(m.id, seen?.created !== undefined && m.created === undefined ? { ...m, created: seen.created } : m)
    else if (seen.created === undefined && m.created !== undefined) out.set(m.id, { ...seen, created: m.created })
  }
  return sortCatalog([...out.values()])
}

/** Jev ids a decision endpoint names in its answer, such as magpie's "name the provider before it, like typesafe/jev-latest". */
export function jevIdsIn(text: string): string[] {
  const ids = text.match(/[\w.-]+(?:\/[\w.-]+)*\/jev[\w.:@-]*|(?<![\w/.-])jev-[\w.:@-]+/gi) ?? []
  return [...new Set(ids.map(id => id.replace(/[.:,;]+$/, '')).filter(id => isDecisionModel('openai-compatible', id)))]
}
