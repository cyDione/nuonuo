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
export interface LayerPreset { id: string; label: string; kind: ProviderKind; layers: Record<string, { model: string; reasoning?: string; enabled?: boolean }> }
export interface Catalog { presets: Preset[]; roles: RoleSpec[]; reasoningLevels: string[]; layerPresets: LayerPreset[] }
export interface Provider { id: string; kind: ProviderKind; name: string; baseUrl: string | null; options: { prices?: Record<string, Price> }; hasKey: boolean; keyHint?: string; keyEnv?: string }
export interface Price { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
export interface ModelRef { providerId: string; model: string }
export interface RoleConfig { chain: ModelRef[]; enabled: boolean; reasoning?: string; temperature?: number; maxOutputTokens?: number; dailyTokenLimit?: number; dailyCostLimitUsd?: number }
export interface Resolved { source: RoleId; model: ModelRef; today: { tokens: number; costUsd: number } }
export interface RolesResponse { configs: Partial<Record<RoleId, RoleConfig>>; resolved: Record<RoleId, Resolved | null> }
export interface Conversation { id: string; title: string; pinned: boolean; archived: boolean; createdAt: number; updatedAt: number; lastMessage?: string | null }
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant' | 'system' | 'event'; content: string; meta: Record<string, any>; ticketId: string | null; triggerId: string | null; createdAt: number }
export interface UsageRow { role: RoleId; providerId: string; model: string; calls: number; failures: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number; costUsd: number | null }
export interface Check { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string; fix?: string }
export interface Health { ok: boolean; version: string; home: string; pid: number; uptimeMs: number; secrets: string; effects: { kind: string; pending: number; failing: number }[] }

export type Stage = 'person/answer' | 'person/blocked' | 'person/failed' | 'queued' | 'working' | 'idle' | 'ended'
export interface Report { status: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; humanAction?: { question: string; options?: string[] }; at: number }
export interface Ticket {
  id: string; title: string; name: string; note: string | null; stage: Stage; stageLabel: string; conversationId: string | null; directory: string
  latestReport: Report | null; attention: { question: string; options?: string[]; at: number } | null
  ended: { at: number; by: string; outcome: 'completed' | 'stopped' | 'dropped'; reason?: string } | null; createdAt: number; updatedAt: number
}
export type TranscriptItem =
  | { id: string; kind: 'input'; text: string; at: number }
  | { id: string; kind: 'text' | 'reasoning'; text: string; at: number }
  | { id: string; kind: 'tool-call'; callId: string; tool: string; input: any; at: number }
  | { id: string; kind: 'tool-result'; callId: string; tool: string; output: string; at: number }
  | { id: string; kind: 'marker'; type: string; message?: string; at: number }
  | { id: string; kind: 'compaction'; summary: string; at: number }
export interface TicketDetail { ticket: Ticket; reports: (Report & { id: number; humanAction: Report['humanAction'] | null })[]; transcript: TranscriptItem[]; running: boolean; jobs: { jobId: string; command: string; startedAt: number }[] }
export interface ExecutionSettings { maxWorkers: number; foregroundSeconds: number; timeoutMinutes: number; blockedCommands: string[]; workspaceRoots: string[] }

export type ServerEvent =
  | { type: 'message.created'; conversationId: string; messageId: string }
  | { type: 'reply.delta'; conversationId: string; callId: string; text: string }
  | { type: 'ticket.updated'; ticketId: string }
  | { type: 'session.state'; role: string; sessionId: string; ticketId?: string | null; state: string }
  | { type: 'worker.part'; ticketId: string; part: { kind: string; delta?: string; tool?: string; id?: string } }
  | { type: 'conversation.updated'; conversationId: string }
