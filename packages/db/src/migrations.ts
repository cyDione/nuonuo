/** Ordered schema migrations, tracked through `PRAGMA user_version`. Never edit a released step; append a new one. */
export const MIGRATIONS: readonly string[] = [
  /* 1 */ `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT,
    secret_ref TEXT,
    options TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE TABLE model_roles (
    role TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE TABLE usage_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    role TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    ref TEXT,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT
  );
  CREATE INDEX usage_ledger_at ON usage_ledger(at);
  CREATE INDEX usage_ledger_role_at ON usage_ledger(role, at);
  CREATE TABLE effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE UNIQUE INDEX effects_kind_key ON effects(kind, key);
  CREATE INDEX effects_due ON effects(kind, due_at);
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, created_at);
  `,
]
