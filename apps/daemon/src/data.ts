/**
 * 数据和隐私 (设置 → 数据和隐私): how long chats are kept, exporting everything as one JSON file, and clearing memories
 * or chats. Secrets never leave the keychain, so an export holds no API keys.
 */
import { kvGet, kvSet, type Store } from '@nuonuo/db'
import { z } from 'zod'

export const RETENTION = ['forever', '365', '90', '30'] as const
export const PrivacySchema = z.object({ keep: z.enum(RETENTION) })
export type PrivacySettings = z.infer<typeof PrivacySchema>
const KEY = 'settings:privacy'
const DAY = 86_400_000

export const privacySettings = (store: Store): PrivacySettings => ({ keep: 'forever', ...kvGet<Partial<PrivacySettings>>(store, KEY) })
export function savePrivacySettings(store: Store, patch: Partial<PrivacySettings>): PrivacySettings {
  const next = PrivacySchema.parse({ ...privacySettings(store), ...patch })
  kvSet(store, KEY, next)
  return next
}

/**
 * Deletes chat messages older than the kept period, then the side chats left empty (never the main chat, never one with
 * work still open). Returns how many messages went.
 */
export function pruneChats(store: Store, main: string, open: (conversationId: string) => boolean, now = Date.now()): number {
  const { keep } = privacySettings(store)
  if (keep === 'forever') return 0
  const cutoff = now - Number(keep) * DAY
  const removed = store.sqlite.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff).changes
  const empty = store.sqlite.prepare('SELECT id FROM conversations WHERE id != ? AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)').all(main, cutoff) as { id: string }[]
  for (const { id } of empty) if (!open(id)) store.sqlite.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  return removed
}

const TABLES: { name: string; drop?: string[] }[] = [
  { name: 'conversations' }, { name: 'messages' }, { name: 'memories', drop: ['embedding'] }, { name: 'goals' }, { name: 'goal_log' },
  { name: 'feed' }, { name: 'routines' }, { name: 'artifacts' }, { name: 'tickets' }, { name: 'reports' }, { name: 'audit_log' },
]

/** Everything that is the owner's, as plain rows. Model provider keys stay in the keychain and are not part of it. */
export function exportAll(store: Store, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extra, exportedAt: new Date().toISOString() }
  for (const t of TABLES) {
    try {
      out[t.name] = (store.sqlite.prepare(`SELECT * FROM ${t.name}`).all() as Record<string, unknown>[]).map(row => {
        const r = { ...row }
        for (const k of t.drop ?? []) delete r[k]
        return r
      })
    } catch { /* table from a newer or older version */ }
  }
  return out
}

/** The owner's side chats, which 清除全部聊天 removes (not the main chat, not ones kept for the system such as the watchdog's). */
export const sideChats = (store: Store, keep: string[]): string[] =>
  (store.sqlite.prepare("SELECT id FROM conversations WHERE source = 'webchat'").all() as { id: string }[]).map(r => r.id).filter(id => !keep.includes(id))

/** 清除全部聊天: every message goes; side chats go too, and the main chat keeps its place but starts empty. */
export function clearChats(store: Store, keep: string[]): number {
  return store.atomic(() => {
    const n = store.sqlite.prepare('DELETE FROM messages').run().changes
    for (const id of sideChats(store, keep)) store.sqlite.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    return n
  })
}

/** How long the runtime's own bookkeeping is kept; the owner's chats follow 聊天记录保留 instead. */
export const RUNTIME_KEEP = { inboxDays: 7, jobsDays: 30, markersDays: 30, blobsDays: 90 } as const

/**
 * Trims what the runtime piles up on its own: delivered inbox rows, finished background commands, tool-call markers
 * (only needed to spot calls a crash interrupted) and spilled tool output. Task records, reports, artifacts and
 * conversation history are left alone. A `recall` of a removed blob answers that it is gone.
 */
export function pruneRuntime(store: Store, now = Date.now(), keep = RUNTIME_KEEP): Record<string, number> {
  const before = (days: number) => now - days * DAY
  return store.atomic(() => ({
    inbox: store.sqlite.prepare('DELETE FROM session_inbox WHERE taken_at IS NOT NULL AND taken_at < ?').run(before(keep.inboxDays)).changes,
    jobs: store.sqlite.prepare("DELETE FROM jobs WHERE status != 'running' AND COALESCE(ended_at, started_at) < ?").run(before(keep.jobsDays)).changes,
    markers: store.sqlite.prepare(`DELETE FROM session_events WHERE kind = 'marker' AND at < ?
      AND json_extract(payload, '$.type') IN ('tool-start', 'tool-end')
      AND session_id NOT IN (SELECT id FROM sessions WHERE state = 'running')`).run(before(keep.markersDays)).changes,
    blobs: store.sqlite.prepare('DELETE FROM blobs WHERE created_at < ?').run(before(keep.blobsDays)).changes,
  }))
}
