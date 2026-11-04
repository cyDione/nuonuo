/**
 * Conversations of the M0 direct-chat preview: the person talks to the router layer directly. In M1 each conversation
 * becomes a WebChat Thread and its messages Triggers; the tables are kept so that migration can carry history over.
 */
import { newId, schema, type Store } from '@super-agent/db'
import type { ModelHub } from '@super-agent/models'
import { generateText, streamText, type ModelMessage } from 'ai'
import { asc, desc, eq } from 'drizzle-orm'

export type Conversation = typeof schema.conversations.$inferSelect
export type Message = typeof schema.messages.$inferSelect

const SYSTEM = `你是用户的个人 Super-agent，运行在用户自己的电脑上。
当前处于 M0「直连预览」阶段：你只能对话，还不能执行任务、读写文件或访问外部服务；如果用户要求执行，坦诚说明这项能力会在后续版本提供。
回答简洁、直接；默认使用用户的语言。`

const HISTORY_LIMIT = 40

export class Conversations {
  constructor(private store: Store, private hub: ModelHub) {}

  list(): (Conversation & { lastMessage: string | null })[] {
    return this.store.sqlite.prepare(`SELECT c.id, c.title, c.pinned, c.archived, c.created_at AS createdAt, c.updated_at AS updatedAt,
        (SELECT substr(content, 1, 120) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant')
          ORDER BY created_at DESC LIMIT 1) AS lastMessage
      FROM conversations c WHERE c.archived = 0 ORDER BY c.pinned DESC, c.updated_at DESC`).all()
      .map((row: any) => ({ ...row, pinned: Boolean(row.pinned), archived: Boolean(row.archived) }))
  }

  get(id: string): Conversation | undefined {
    return this.store.db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).get()
  }

  create(title = '新对话'): Conversation {
    const id = newId('cnv')
    const at = Date.now()
    this.store.db.insert(schema.conversations).values({ id, title, createdAt: at, updatedAt: at }).run()
    return this.get(id)!
  }

  update(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): Conversation | undefined {
    this.store.db.update(schema.conversations).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.conversations.id, id)).run()
    return this.get(id)
  }

  delete(id: string): void {
    this.store.db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run()
  }

  messages(id: string): Message[] {
    return this.store.db.select().from(schema.messages).where(eq(schema.messages.conversationId, id))
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id)).all()
  }

  addMessage(conversationId: string, role: Message['role'], content: string, meta: Record<string, unknown> = {}): Message {
    const id = newId('msg')
    const at = Date.now()
    this.store.atomic(() => {
      this.store.db.insert(schema.messages).values({ id, conversationId, role, content, meta, createdAt: at }).run()
      this.store.db.update(schema.conversations).set({ updatedAt: at }).where(eq(schema.conversations.id, conversationId)).run()
    })
    return this.store.db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()!
  }

  /** Streams the router layer's reply to the latest user message; persists the reply (or the failure) when it ends. */
  reply(conversationId: string, signal: AbortSignal) {
    const history = this.store.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.createdAt)).limit(HISTORY_LIMIT).all().reverse()
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.meta.error))
    const messages: ModelMessage[] = history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    const model = this.hub.model('router', { ref: conversationId })
    return streamText({ model, system: SYSTEM, messages, abortSignal: signal, maxRetries: 1 })
  }

  /** Names a conversation after its first exchange with the summarizer layer; falls back to the first line of the request. */
  async autoTitle(conversationId: string): Promise<void> {
    const conversation = this.get(conversationId)
    if (!conversation || conversation.title !== '新对话') return
    const [first] = this.messages(conversationId).filter(m => m.role === 'user')
    if (!first) return
    let title = first.content.split('\n')[0]!.slice(0, 24)
    try {
      const result = await generateText({ model: this.hub.model('summarizer', { ref: conversationId }), maxOutputTokens: 400,
        prompt: `为下面这条请求起一个不超过 14 个字的对话标题，只输出标题本身，不要标点和引号：\n\n${first.content.slice(0, 2000)}` })
      const named = result.text.trim().replace(/^["'“”「」《》]+|["'“”「」《》。.]+$/g, '').split('\n')[0]!.slice(0, 30)
      if (named) title = named
    } catch { /* keep the fallback title */ }
    if (this.get(conversationId)?.title === '新对话') this.update(conversationId, { title })
  }
}
