/**
 * 数据和隐私 (设置 → 数据和隐私): how long chats are kept, exporting everything as one JSON file, and clearing memories
 * or chats. Secrets never leave the keychain, so an export holds no API keys.
 */
import { kvGet, kvSet, type Store } from '@super-assistant/db'
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
