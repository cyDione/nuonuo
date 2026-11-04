/** Typed calls to the daemon's /api. The session cookie travels automatically (same origin). */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'http', data?.error?.message ?? res.statusText)
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: (path: string) => request<void>('DELETE', path),
}

// ── Shapes returned by the daemon ────────────────────────────────────────────
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openai-compatible'
export interface Preset { id: string; kind: ProviderKind; label: string; baseUrl?: string; keyRequired: boolean; suggestedModels: string[]; docsUrl?: string }
export type RoleId = 'router' | 'worker' | 'subagent' | 'filter' | 'reviewer' | 'watchdog' | 'summarizer' | 'embedding' | 'vision'
export interface RoleSpec { id: RoleId; label: string; duty: string; advice: string; inherits?: RoleId; optional?: boolean; kind: 'language' | 'embedding' }
export interface Catalog { presets: Preset[]; roles: RoleSpec[]; reasoningLevels: string[] }
export interface Provider { id: string; kind: ProviderKind; name: string; baseUrl: string | null; options: { prices?: Record<string, Price> }; hasKey: boolean; keyHint?: string }
export interface Price { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
export interface ModelRef { providerId: string; model: string }
export interface RoleConfig { chain: ModelRef[]; enabled: boolean; reasoning?: string; temperature?: number; maxOutputTokens?: number; dailyTokenLimit?: number; dailyCostLimitUsd?: number }
export interface Resolved { source: RoleId; model: ModelRef; today: { tokens: number; costUsd: number } }
export interface RolesResponse { configs: Partial<Record<RoleId, RoleConfig>>; resolved: Record<RoleId, Resolved | null> }
export interface Conversation { id: string; title: string; pinned: boolean; archived: boolean; createdAt: number; updatedAt: number; lastMessage?: string | null }
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant' | 'system' | 'event'; content: string; meta: Record<string, any>; createdAt: number }
export interface UsageRow { role: RoleId; providerId: string; model: string; calls: number; failures: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number; costUsd: number | null }
export interface Check { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string; fix?: string }
export interface Health { ok: boolean; version: string; home: string; pid: number; uptimeMs: number; secrets: string; effects: { kind: string; pending: number; failing: number }[] }

/** POSTs a message and reads the daemon's SSE reply stream. */
export async function sendMessage(conversationId: string, content: string, handlers: {
  onMessage(m: Message): void; onDelta(text: string): void; onDone(m: Message): void; onError(message: string, saved?: Message): void
}, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal,
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(res.status, data?.error?.code ?? 'http', data?.error?.message ?? res.statusText)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let index: number
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      let event = 'message', data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trimStart()
      }
      if (!data) continue
      const payload = JSON.parse(data)
      if (event === 'message') handlers.onMessage(payload)
      else if (event === 'delta') handlers.onDelta(payload.text)
      else if (event === 'done') handlers.onDone(payload)
      else if (event === 'error') handlers.onError(payload.message, payload.saved)
    }
  }
}
