/**
 * ⌘K search: one box over the conversations, what was made (成果) and what 糯糯 remembers. Plain substring matching,
 * newest first, a handful per group: the box is for finding something you half remember, not for browsing.
 */
import { schema, type Store } from '@super-assistant/db'
import { and, desc, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm'

export interface SearchHit { id: string; text: string; at: number; conversationId?: string | null; conversation?: string; main?: boolean; ticketId?: string; kind?: string }
export interface SearchResults { messages: SearchHit[]; artifacts: SearchHit[]; memories: SearchHit[] }

const PER_GROUP = 6
/** `LIKE` with the query's own % and _ taken literally. */
const contains = (col: SQLWrapper, q: string) => sql`${col} LIKE ${`%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`} ESCAPE '\\'`
/** The stretch of a long message around the first match, so the match is on screen. */
export function around(text: string, q: string, width = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const i = flat.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0 || flat.length <= width) return flat.slice(0, width)
  const start = Math.max(0, Math.min(i - 16, flat.length - width))
  return `${start ? '…' : ''}${flat.slice(start, start + width)}${start + width < flat.length ? '…' : ''}`
}

export function search(store: Store, raw: string): SearchResults {
  const q = raw.trim().slice(0, 80)
  if (!q) return { messages: [], artifacts: [], memories: [] }
  const { db } = store
  const messages = db.select({ id: schema.messages.id, content: schema.messages.content, at: schema.messages.createdAt, conversationId: schema.messages.conversationId,
    title: schema.conversations.title, meta: schema.conversations.meta })
    .from(schema.messages).innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(inArray(schema.messages.role, ['user', 'assistant']), eq(schema.conversations.archived, false), contains(schema.messages.content, q)))
    .orderBy(desc(schema.messages.createdAt)).limit(PER_GROUP).all()
    .map(m => ({ id: m.id, text: around(m.content, q), at: m.at, conversationId: m.conversationId, conversation: m.title, main: m.meta?.main === true }))
  const artifacts = db.select().from(schema.artifacts).where(contains(schema.artifacts.name, q)).orderBy(desc(schema.artifacts.createdAt)).limit(PER_GROUP).all()
    .map(a => ({ id: a.id, text: a.name, at: a.createdAt, ticketId: a.ticketId }))
  const memories = db.select().from(schema.memories).where(and(eq(schema.memories.status, 'active'), contains(schema.memories.text, q)))
    .orderBy(desc(schema.memories.validFrom)).limit(PER_GROUP).all()
    .map(m => ({ id: m.id, text: around(m.text, q), at: m.validFrom, kind: m.kind }))
  return { messages, artifacts, memories }
}
