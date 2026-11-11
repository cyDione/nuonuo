/**
 * 动态 (Figma v6, 19a): what changed in the things the assistant watches for the owner. Only changes reach it, never
 * "nothing new", and at most one of them gets the big colour card. The page ends with 「就这些」: it never scrolls forever.
 */
import { newId, schema, type Store } from '@super-assistant/db'
import { tool, type ToolSet } from 'ai'
import { and, desc, eq, gte, or } from 'drizzle-orm'
import { z } from 'zod'
import type { AgentExtensions } from './agents'

export const FEED_ICONS = ['bell', 'tag', 'weather', 'mail', 'wifi', 'plane', 'calendar', 'package', 'chart', 'news', 'home', 'heart'] as const
export type FeedIcon = (typeof FEED_ICONS)[number]
export type FeedItem = typeof schema.feed.$inferSelect
export interface FeedInput { title: string; text?: string; icon?: FeedIcon; card?: FeedItem['card']; action?: FeedItem['action']; conversationId?: string | null; ticketId?: string | null }

const DAYS = 14 * 86_400_000

export class Feed {
  constructor(private store: Store, private now: () => number = Date.now, private changed: () => void = () => {}) {}

  /** The last two weeks, newest first, without what the owner put away. */
  list(): FeedItem[] {
    return this.store.db.select().from(schema.feed).where(and(eq(schema.feed.dismissed, false), or(gte(schema.feed.at, this.now() - DAYS), eq(schema.feed.saved, true)))).orderBy(desc(schema.feed.at)).all()
  }

  get(id: string): FeedItem {
    const item = this.store.db.select().from(schema.feed).where(eq(schema.feed.id, id)).get()
    if (!item) throw new Error(`没有动态 ${id}`)
    return item
  }

  post(input: FeedInput): FeedItem {
    const id = newId('fed')
    this.store.db.insert(schema.feed).values({
      id, at: this.now(), title: input.title, text: input.text ?? '', icon: input.icon ?? 'bell', card: input.card ?? null, action: input.action ?? null,
      conversationId: input.conversationId ?? null, ticketId: input.ticketId ?? null,
    }).run()
    this.changed()
    return this.get(id)
  }

  dismiss(id: string): void {
    this.get(id)
    this.store.db.update(schema.feed).set({ dismissed: true }).where(eq(schema.feed.id, id)).run()
    this.changed()
  }

  /** 👍 / 👎 on an item (null clears it). A 👎 also puts it away. */
  react(id: string, reaction: 'up' | 'down' | null): FeedItem {
    this.get(id)
    this.store.db.update(schema.feed).set({ reaction, ...(reaction === 'down' ? { dismissed: true } : {}) }).where(eq(schema.feed.id, id)).run()
    this.changed()
    return this.get(id)
  }

  /** 收藏: a saved item stays in 动态 past the two weeks. */
  save(id: string, saved: boolean): FeedItem {
    this.get(id)
    this.store.db.update(schema.feed).set({ saved }).where(eq(schema.feed.id, id)).run()
    this.changed()
    return this.get(id)
  }

  /** What the owner liked and disliked lately, for the agent deciding what is worth posting. */
  taste(): string {
    const rows = this.store.db.select().from(schema.feed).where(gte(schema.feed.at, this.now() - 60 * 86_400_000)).orderBy(desc(schema.feed.at)).all().filter(r => r.reaction).slice(0, 20)
    if (!rows.length) return ''
    return `The owner's reactions to recent 动态 items (post more like 👍, fewer like 👎):\n${rows.map(r => `- ${r.reaction === 'up' ? '👍' : '👎'} ${r.title}`).join('\n')}`
  }

  /** The owner opened 动态: everything up to now has been seen. */
  seeAll(): void {
    this.store.db.update(schema.feed).set({ seen: true }).where(eq(schema.feed.seen, false)).run()
    this.changed()
  }

  unseen(): number {
    return this.list().filter(i => !i.seen).length
  }
}

const CardFields = z.object({
  label: z.string().max(30).optional().describe('What the number is, e.g. XM6 · 京东自营'),
  value: z.number().describe('The number now, e.g. 1999'),
  was: z.number().optional().describe('What it was before, shown struck through, e.g. 2299'),
  unit: z.string().max(4).optional().describe('"¥" for money (shown before the number), otherwise after it'),
  note: z.string().max(40).optional().describe('One line on why it matters, e.g. 比你说的 ¥2,000 还低，降了 ¥300'),
  series: z.array(z.number()).max(30).optional().describe('Recent values, oldest first, drawn as a small line'),
})

/** Workers and the main agent post a change they noticed while watching something for the owner. */
export function feedExtension(feed: Feed): AgentExtensions {
  const post = (ticketId?: string) => tool({
    description: 'Post a change you noticed in something you watch for the owner to 动态 (their feed): a price that moved, a reply that came, weather that affects a plan. Only post real changes, never "nothing new". Use `card` only for the one change that matters most right now (a number that moved); use `action` when there is an obvious next step the owner can take with one tap.',
    inputSchema: z.object({
      title: z.string().min(1).max(40).describe('In Chinese, the change itself, e.g. 去京都的机票便宜了 ¥180'),
      text: z.string().max(80).optional().describe('One line of detail, e.g. 东航 MU529 · 11.28 08:35 · 你还没订'),
      icon: z.enum(FEED_ICONS).optional(),
      card: CardFields.optional(),
      action: z.object({ label: z.string().max(8).describe('e.g. 去下单, 帮我升级'), say: z.string().max(200).describe('What the owner says to you in the main chat when they tap it') }).optional(),
    }),
    execute: async input => { const item = feed.post({ ...input, ticketId: ticketId ?? null }); return { ok: true, id: item.id } },
  })
  return {
    routerPrompt: () => `## 动态
When something you watch for the owner changes, post it with post_update instead of interrupting the chat, unless it needs them now.${feed.taste() ? `\n${feed.taste()}` : ''}`,
    routerTools: (): ToolSet => ({ post_update: post() }),
    workerTools: (ticket): ToolSet => ({ post_update: post(ticket.id) }),
  }
}
