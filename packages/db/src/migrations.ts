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
  /* 2: M1 domain (threads, triggers, tickets, subscriptions, assignments, reports) and agent runtime (sessions, inbox, jobs, blobs) */ `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE triggers (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    source TEXT NOT NULL,
    actor TEXT NOT NULL,
    human INTEGER NOT NULL,
    text TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    disposition TEXT NOT NULL DEFAULT '{}',
    at INTEGER NOT NULL
  );
  CREATE INDEX triggers_thread ON triggers(thread_id, at);
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    note TEXT,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    origin TEXT NOT NULL,
    mandate TEXT NOT NULL,
    directory TEXT NOT NULL,
    session_id TEXT NOT NULL,
    latest_report TEXT,
    attention TEXT,
    ended TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tickets_thread ON tickets(thread_id);
  CREATE TABLE subscriptions (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    kind TEXT NOT NULL DEFAULT 'own',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (ticket_id, thread_id)
  );
  CREATE INDEX subscriptions_thread ON subscriptions(thread_id);
  CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT
  );
  CREATE INDEX assignments_ticket ON assignments(ticket_id, started_at);
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    assignment_id TEXT,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    human_action TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX reports_ticket ON reports(ticket_id, at);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    model_role TEXT NOT NULL,
    ticket_id TEXT,
    state TEXT NOT NULL DEFAULT 'idle',
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX session_events_session ON session_events(session_id, id);
  CREATE TABLE session_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    human INTEGER NOT NULL DEFAULT 0,
    wake INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    taken_at INTEGER
  );
  CREATE INDEX session_inbox_pending ON session_inbox(session_id, taken_at);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    background INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER,
    output TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX jobs_session ON jobs(session_id, started_at);
  CREATE TABLE blobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  ALTER TABLE messages ADD COLUMN ticket_id TEXT;
  ALTER TABLE messages ADD COLUMN trigger_id TEXT;
  `,
  /* 3: M2 external sources (mirror conversations for external threads, unread state) and routines */ `
  ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'webchat';
  ALTER TABLE conversations ADD COLUMN thread_id TEXT;
  ALTER TABLE conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner';
  ALTER TABLE conversations ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE conversations ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX conversations_thread ON conversations(thread_id) WHERE thread_id IS NOT NULL;
  ALTER TABLE subscriptions ADD COLUMN closed TEXT;
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    conversation_id TEXT,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 4: M3 review (approvals waiting for the owner, audit log) */ `
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    risk TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX approvals_pending ON approvals(status, created_at);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    ticket_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    tool TEXT,
    input TEXT,
    risk TEXT,
    decision TEXT NOT NULL,
    reason TEXT
  );
  CREATE INDEX audit_log_at ON audit_log(at);
  `,
  /* 5: M5 deliverables a task produced (shown as attachments and in the library) */ `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX artifacts_path ON artifacts(ticket_id, path);
  `,
  /* 6: M6 memory runtime (entries with provenance, trust, confidence, TTL) and task-scoped grants */ `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scope TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    trust TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1,
    source_refs TEXT NOT NULL DEFAULT '[]',
    supersedes TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    expires_at INTEGER,
    superseded_by TEXT,
    embedding TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX memories_status ON memories(status, kind, scope);
  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE UNIQUE INDEX grants_key ON grants(ticket_id, tool, key);
  `,
  /* 7: v6 goals (long-running aims with progress) and what the assistant did toward them */ `
  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'target',
    style TEXT NOT NULL DEFAULT 'amount',
    unit TEXT NOT NULL DEFAULT '',
    current REAL NOT NULL DEFAULT 0,
    target REAL NOT NULL,
    note TEXT,
    headline TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE goal_log (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    text TEXT NOT NULL,
    delta REAL
  );
  CREATE INDEX goal_log_at ON goal_log(goal_id, at);
  `,
]
