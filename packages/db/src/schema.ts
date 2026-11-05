/** Drizzle table definitions. The SQL in migrations.ts is the source of truth for the on-disk shape; keep both in sync. */
import { sql } from 'drizzle-orm'
import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = sql`(unixepoch('subsec') * 1000)`

export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
})

/** A configured model provider. The API key itself lives in the secret store; `secretRef` names it. */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  secretRef: text('secret_ref'),
  options: text('options', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

/** One row per execution layer (router, worker, ...), holding its model chain and limits as JSON. */
export const modelRoles = sqliteTable('model_roles', {
  role: text('role').primaryKey(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const usageLedger = sqliteTable('usage_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  role: text('role').notNull(),
  providerId: text('provider_id').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  costUsd: real('cost_usd'),
  ref: text('ref'),
  ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
  error: text('error'),
})

/** Durable side-effect queue: one row per (kind, key); a row is deleted once its handler succeeds. */
export const effects = sqliteTable('effects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  key: text('key').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  dueAt: integer('due_at').notNull(),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull().default(now),
}, t => [uniqueIndex('effects_kind_key').on(t.kind, t.key)])

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  /** `webchat` for the owner's own topics; an external source (`github`, `cron`) for a thread mirrored into the web. */
  source: text('source').notNull().default('webchat'),
  threadId: text('thread_id'),
  /** `agent` when the agent opened it (a routine, a GitHub thread, a notification). */
  origin: text('origin').notNull().default('owner'),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  lastReadAt: integer('last_read_at').notNull().default(0),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system', 'event'] }).notNull(),
  content: text('content').notNull(),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  ticketId: text('ticket_id'),
  triggerId: text('trigger_id'),
  createdAt: integer('created_at').notNull().default(now),
})

const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  ref: text('ref').notNull(),
  meta: json<Record<string, unknown>>('meta').notNull().default({}),
  createdAt: integer('created_at').notNull(),
})

export const triggers = sqliteTable('triggers', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull(),
  source: text('source').notNull(),
  actor: text('actor').notNull(),
  human: integer('human', { mode: 'boolean' }).notNull(),
  text: text('text').notNull(),
  meta: json<Record<string, unknown>>('meta').notNull().default({}),
  disposition: json<Record<string, unknown>>('disposition').notNull().default({}),
  at: integer('at').notNull(),
})

export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  title: text('title').notNull(),
  note: text('note'),
  threadId: text('thread_id').notNull(),
  origin: json<{ triggerIds: string[] }>('origin').notNull(),
  mandate: json<Record<string, unknown>>('mandate').notNull(),
  directory: text('directory').notNull(),
  sessionId: text('session_id').notNull(),
  latestReport: json<Record<string, unknown> | null>('latest_report'),
  attention: json<Record<string, unknown> | null>('attention'),
  ended: json<Record<string, unknown> | null>('ended'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const subscriptions = sqliteTable('subscriptions', {
  ticketId: text('ticket_id').notNull(),
  threadId: text('thread_id').notNull(),
  kind: text('kind').notNull().default('own'),
  createdAt: integer('created_at').notNull(),
  closed: json<{ at: number; outcome: string } | null>('closed'),
})

export const routines = sqliteTable('routines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  schedule: text('schedule').notNull(),
  prompt: text('prompt').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  conversationId: text('conversation_id'),
  lastFiredAt: integer('last_fired_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const assignments = sqliteTable('assignments', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').notNull(),
  status: text('status').notNull(),
  reason: text('reason').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  endReason: text('end_reason'),
})

export const reports = sqliteTable('reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: text('ticket_id').notNull(),
  assignmentId: text('assignment_id'),
  status: text('status').notNull(),
  summary: text('summary').notNull(),
  humanAction: json<Record<string, unknown> | null>('human_action'),
  at: integer('at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  modelRole: text('model_role').notNull(),
  ticketId: text('ticket_id'),
  state: text('state').notNull().default('idle'),
  meta: json<Record<string, unknown>>('meta').notNull().default({}),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const sessionEvents = sqliteTable('session_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  kind: text('kind').notNull(),
  payload: json<any>('payload').notNull(),
  at: integer('at').notNull(),
})

export const sessionInbox = sqliteTable('session_inbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  payload: json<any>('payload').notNull(),
  human: integer('human', { mode: 'boolean' }).notNull().default(false),
  wake: integer('wake', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
  takenAt: integer('taken_at'),
})

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  command: text('command').notNull(),
  cwd: text('cwd').notNull(),
  status: text('status').notNull(),
  background: integer('background', { mode: 'boolean' }).notNull().default(false),
  exitCode: integer('exit_code'),
  output: text('output').notNull().default(''),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
})

export const blobs = sqliteTable('blobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  meta: json<Record<string, unknown>>('meta').notNull().default({}),
  createdAt: integer('created_at').notNull(),
})

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').notNull(),
  sessionId: text('session_id').notNull(),
  tool: text('tool').notNull(),
  input: json<Record<string, unknown>>('input').notNull(),
  risk: text('risk').notNull(),
  reason: text('reason').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull().default('pending'),
  decidedBy: text('decided_by'),
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  decidedAt: integer('decided_at'),
})

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  ticketId: text('ticket_id'),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  tool: text('tool'),
  input: text('input'),
  risk: text('risk'),
  decision: text('decision').notNull(),
  reason: text('reason'),
})

/** A file a task delivered (relative to its working directory). */
export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at').notNull(),
})
