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
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system', 'event'] }).notNull(),
  content: text('content').notNull(),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer('created_at').notNull().default(now),
})
