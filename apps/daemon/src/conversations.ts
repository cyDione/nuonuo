/** Conversations: the web chat's list of topics. Each is a WebChat thread; its messages are triggers and the agent's replies. */
import { newId, schema, type Store } from '@super-agent/db'
import type { ModelHub } from '@super-agent/models'
import { generateText } from 'ai'
import { asc, eq } from 'drizzle-orm'

export type Conversation = typeof schema.conversations.$inferSelect
export type Message = typeof schema.messages.$inferSelect

export const DEFAULT_TITLE = '新对话'

export class Conversations {
  constructor(private store: Store, private hub: ModelHub) {}

  list(): (Conversation & { lastMessage: string | null })[] {
    // Unread: something the owner did not write arrived after they last looked.
    return this.store.sqlite.prepare(`SELECT c.id, c.title, c.pinned, c.archived, c.source, c.origin, c.meta, c.thread_id AS threadId,
        c.created_at AS createdAt, c.updated_at AS updatedAt, c.last_read_at AS lastReadAt,
        (SELECT substr(content, 1, 120) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant')
          ORDER BY created_at DESC LIMIT 1) AS lastMessage,
        (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.created_at > c.last_read_at
          AND NOT (m.role = 'user' AND coalesce(json_extract(m.meta, '$.source'), 'webchat') = 'webchat')) AS unread
      FROM conversations c WHERE c.archived = 0 ORDER BY json_extract(c.meta, '$.main') IS 1 DESC, c.pinned DESC, c.updated_at DESC`).all()
      .map((row: any) => ({ ...row, pinned: Boolean(row.pinned), archived: Boolean(row.archived), meta: JSON.parse(row.meta ?? '{}') }))
  }

  get(id: string): Conversation | undefined {
    return this.store.db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).get()
  }

  create(title = DEFAULT_TITLE): Conversation {
    const id = newId('cnv')
    const at = Date.now()
    this.store.db.insert(schema.conversations).values({ id, title, createdAt: at, updatedAt: at }).run()
    return this.get(id)!
  }

  update(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): Conversation | undefined {
    this.store.db.update(schema.conversations).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.conversations.id, id)).run()
    return this.get(id)
  }

  markRead(id: string): void {
    this.store.db.update(schema.conversations).set({ lastReadAt: Date.now() }).where(eq(schema.conversations.id, id)).run()
  }

  delete(id: string): void {
    this.store.db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run()
  }

  messages(id: string): Message[] {
    return this.store.db.select().from(schema.messages).where(eq(schema.messages.conversationId, id))
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id)).all()
  }

  message(id: string): Message | undefined {
    return this.store.db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()
  }

  /** Names a conversation after its first message with the summarizer layer; falls back to the first line. */
  async autoTitle(conversationId: string): Promise<boolean> {
    const conversation = this.get(conversationId)
    if (!conversation || conversation.title !== DEFAULT_TITLE || conversation.source !== 'webchat') return false
    const [first] = this.messages(conversationId).filter(m => m.role === 'user')
    if (!first) return false
    let title = first.content.split('\n')[0]!.slice(0, 24)
    try {
      const result = await generateText({ model: this.hub.model('summarizer', { ref: conversationId }), maxOutputTokens: 400,
        prompt: `为下面这条请求起一个不超过 14 个字的对话标题，只输出标题本身，不要标点和引号：\n\n${first.content.slice(0, 2000)}` })
      const named = result.text.trim().replace(/^["'“”「」《》]+|["'“”「」《》。.]+$/g, '').split('\n')[0]!.slice(0, 30)
      if (named) title = named
    } catch { /* keep the fallback title */ }
    if (this.get(conversationId)?.title !== DEFAULT_TITLE) return false
    this.update(conversationId, { title })
    return true
  }
}
