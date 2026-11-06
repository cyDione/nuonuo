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
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openai-compatible' | 'typesafe'
export interface Preset { id: string; kind: ProviderKind; label: string; baseUrl?: string; keyRequired: boolean; suggestedModels: string[]; docsUrl?: string }
export type RoleId = 'router' | 'worker' | 'subagent' | 'filter' | 'reviewer' | 'watchdog' | 'summarizer' | 'embedding' | 'vision'
export interface RoleSpec { id: RoleId; label: string; duty: string; advice: string; inherits?: RoleId; optional?: boolean; kind: 'language' | 'embedding' }
export interface Catalog { presets: Preset[]; roles: RoleSpec[]; reasoningLevels: string[] }
export interface Provider { id: string; kind: ProviderKind; name: string; baseUrl: string | null; options: { prices?: Record<string, Price>; decisionsUrl?: string }; hasKey: boolean; keyHint?: string; keyEnv?: string }
export interface Price { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
export interface ModelRef { providerId: string; model: string }
export interface RoleConfig { chain: ModelRef[]; enabled: boolean; reasoning?: string; temperature?: number; maxOutputTokens?: number; dailyTokenLimit?: number; dailyCostLimitUsd?: number }
export interface Resolved { source: RoleId; model: ModelRef; today: { tokens: number; costUsd: number } }
export interface RolesResponse { configs: Partial<Record<RoleId, RoleConfig>>; resolved: Record<RoleId, Resolved | null> }
export interface Conversation { id: string; title: string; pinned: boolean; archived: boolean; createdAt: number; updatedAt: number; lastMessage?: string | null
  source: string; origin: 'owner' | 'agent'; threadId: string | null; meta: { url?: string; [k: string]: unknown }; unread?: number; lastReadAt?: number }
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant' | 'system' | 'event'; content: string; meta: Record<string, any>; ticketId: string | null; triggerId: string | null; createdAt: number }
export interface UsageRow { role: RoleId; providerId: string; model: string; calls: number; failures: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number; costUsd: number | null }
export interface Check { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string; fix?: string }
export interface Release { tag: string; version: string; url: string; notes: string; publishedAt: string | null; hasPackage: boolean }
export interface UpdateStatus { current: string; install: 'package' | 'source' | 'desktop' | 'other'; canUpdate: boolean; checkedAt: number | null; latest: Release | null
  available: boolean; checkError: string | null; hint: string
  run: { state: 'running' | 'installed' | 'failed'; target: string; startedAt: number; log: string; error?: string } | null }
export interface AccessStatus {
  desktop: boolean
  running: { host: string; port: number; web: boolean }
  saved: { host: string; port: number; web: boolean }
  sources: { host: 'flag' | 'env' | 'file' | 'default'; port: 'flag' | 'env' | 'file' | 'default' }
  localUrl: string; networkUrls: string[]; restartNeeded: boolean; canRestart: boolean
}
export interface Health { ok: boolean; version: string; home: string; pid: number; uptimeMs: number; secrets: string; effects: { kind: string; pending: number; failing: number }[] }

export type Stage = 'person/approve' | 'person/answer' | 'person/blocked' | 'person/failed' | 'queued' | 'working' | 'idle' | 'ended'
export interface Report { status: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; humanAction?: { question: string; options?: string[]; kind?: 'question' | 'handoff' }; at: number }
export interface Ticket {
  id: string; title: string; name: string; note: string | null; stage: Stage; stageLabel: string; conversationId: string | null; source: string; directory: string
  latestReport: Report | null; attention: { question: string; options?: string[]; kind?: 'question' | 'handoff'; at: number } | null
  approvals: { id: string; command: string; reason: string; risk: string; createdAt: number }[]
  ended: { at: number; by: string; outcome: 'completed' | 'stopped' | 'dropped'; reason?: string } | null; createdAt: number; updatedAt: number
  proactive: boolean; why: string | null
}
export interface Artifact { id: string; ticketId: string; path: string; name: string; size: number; createdAt: number; title: string; conversationId: string | null; text: boolean }
export interface ActivityEvent { id: string; source: string; actor: string; human: boolean; at: number; text: string; url: string | null; conversationId: string | null; thread: string
  proactive: { act: boolean; reason: string; mode: string; title?: string; goal?: string } | null; feedback: { useful: boolean } | null; ticketId: string | null; outcome: { tone: 'ok' | 'muted' | 'warn' | 'accent'; text: string } }
export interface ProactiveSettings { mode: 'off' | 'observe' | 'auto'; strategy: string; sources: string[]; ignoreActors: string[]; budget: { concurrent: number; daily: number }; version: number; by?: string; at?: number }
export interface AttentionStats { days: number; approvals: number; questions: number; screened: number; picked: number; silent: number; told: number; useful: number; useless: number }
export type SectionId = 'communication' | 'scope' | 'delivery'
export interface InstructionsVersion { version: number; sections: Record<SectionId, string>; at: number; by: string; note?: string }
export interface InstructionsState { current: InstructionsVersion; history: InstructionsVersion[]; sections: { id: SectionId; label: string }[] }
export type TranscriptItem =
  | { id: string; kind: 'input'; text: string; at: number }
  | { id: string; kind: 'text' | 'reasoning'; text: string; at: number }
  | { id: string; kind: 'tool-call'; callId: string; tool: string; input: any; at: number }
  | { id: string; kind: 'tool-result'; callId: string; tool: string; output: string; at: number }
  | { id: string; kind: 'marker'; type: string; message?: string; at: number }
  | { id: string; kind: 'compaction'; summary: string; at: number }
export interface TicketDetail { ticket: Ticket; reports: (Report & { id: number; humanAction: Report['humanAction'] | null })[]; transcript: TranscriptItem[]; running: boolean; jobs: { jobId: string; command: string; startedAt: number }[]; browser: boolean; project: string | null; usage: { tokens: number; costUsd: number | null }; files?: { id: string; name: string; size: number }[] }
export interface SandboxSettings { mode: 'off' | 'external' | 'all'; image: string; network: 'bridge' | 'none' }
export interface ExecutionSettings { maxWorkers: number; foregroundSeconds: number; timeoutMinutes: number; blockedCommands: string[]; workspaceRoots: string[]; sandbox: SandboxSettings }
export type Level = 'allow' | 'review' | 'ask' | 'deny'
export interface ReviewSettings { external: Level; destructive: Exclude<Level, 'allow'>; mode: 'model' | 'ask'; rules: string[]; allow: string[]; deny: string[] }
export interface AuditEntry { id: number; at: number; ticketId: string | null; actor: string; action: string; tool: string | null; input: string | null; risk: string | null; decision: string; reason: string | null }
export interface Persona { name: string; avatar: string; color: string; personality: string }

export type ServerEvent =
  | { type: 'message.created'; conversationId: string; messageId: string }
  | { type: 'reply.delta'; conversationId: string; callId: string; text: string }
  | { type: 'ticket.updated'; ticketId: string }
  | { type: 'session.state'; role: string; sessionId: string; ticketId?: string | null; state: string }
  | { type: 'worker.part'; ticketId: string; part: { kind: string; delta?: string; tool?: string; id?: string } }
  | { type: 'conversation.updated'; conversationId: string }
  | { type: 'activity.updated' }
  | { type: 'persona.updated' }
  | { type: 'goals.updated' }
  | { type: 'feed.updated' }
  | { type: 'ideas.updated' }

type FieldLinks = { links?: { label: string; href: string }[] }
export type FieldSpec = FieldLinks & (
  | { key: string; label: string; hint?: string; advanced?: true; type: 'switch' }
  | { key: string; label: string; hint?: string; advanced?: true; type: 'number'; min: number; max: number }
  | { key: string; label: string; hint?: string; advanced?: true; type: 'text' | 'list'; placeholder?: string }
  | { key: string; label: string; hint?: string; advanced?: true; type: 'select'; options: { value: string; label: string }[] }
  | { key: string; label: string; hint?: string; advanced?: true; type: 'secret'; placeholder?: string })
export interface SourceAction { id: string; label: string; path: string; show?: 'authorized' | 'unauthorized'; confirm?: string; primary?: true }
export interface SourceInfo { id: string; title: string; description: string; fields: FieldSpec[]; actions: SourceAction[]; authorized?: boolean; enabled: boolean; config: Record<string, any>
  health: { status: 'off' | 'starting' | 'ok' | 'error'; detail?: string; at: number }; facts: Record<string, string> }
export interface Routine { id: string; name: string; schedule: string; prompt: string; enabled: boolean; conversationId: string | null; lastFiredAt: number | null; next: number | null }
export interface PluginInfo { id: string; name: string; version: string; description: string; dir: string; enabled: boolean; loaded: boolean; builtIn: boolean; sources: string[]; error?: string }
export interface McpServer { name: string; enabled: boolean; transport: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; roles: ('worker' | 'router')[]; review: boolean }
export interface McpStatus { name: string; state: 'off' | 'connecting' | 'connected' | 'error'; tools: { name: string; description: string }[]; error?: string }
export type GoalIcon = 'target' | 'moon' | 'wallet' | 'book' | 'run' | 'dumbbell' | 'heart' | 'music' | 'code' | 'leaf' | 'globe' | 'pen'
export interface Goal { id: string; title: string; icon: GoalIcon; style: 'amount' | 'days'; unit: string; current: number; target: number; note: string | null
  headline: { value: string; unit?: string; note?: string } | null; pinned: boolean; status: 'active' | 'done' | 'dropped'; createdAt: number; updatedAt: number }
export type FeedIcon = 'bell' | 'tag' | 'weather' | 'mail' | 'wifi' | 'plane' | 'calendar' | 'package' | 'chart' | 'news' | 'home' | 'heart'
export interface FeedItem { id: string; at: number; title: string; text: string; icon: FeedIcon; card: { label?: string; value: number; was?: number; unit?: string; note?: string; series?: number[] } | null
  action: { label: string; say: string } | null; conversationId: string | null; ticketId: string | null; seen: boolean; dismissed: boolean }
export type IdeaTone = 'coral' | 'teal' | 'lilac' | 'sky' | 'amber'
export interface Idea { id: string; kind: string; label: string; text: string; action: string; say: string; tone: IdeaTone; dismissed?: boolean; done?: boolean }
export interface IdeaBatch { at: number; cards: Idea[]; more: { id: string; text: string; say: string; done?: boolean }[]; seen?: boolean }
export interface IdeaSettings { cadence: 'daily' | 'weekly' | 'off'; hour: number }
export interface GoalLogEntry { id: string; goalId: string; at: number; text: string; delta: number | null; goal: string }
