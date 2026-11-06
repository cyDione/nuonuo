/**
 * 点子 (Figma v6, 18c): a few things the assistant could do for the owner, thought up from what was said lately, the
 * goals and what changed in 动态. A new batch every morning (or every week, or never: the owner chooses in the quick
 * settings). Each card can be put away with ×; kinds the owner keeps putting away are suggested less. Pressing a card's
 * button opens a side chat that starts with what the card offered.
 */
import { kvGet, kvSet, newId, schema, type Store } from '@super-assistant/db'
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import type { ModelHub } from '@super-assistant/models'
import { z } from 'zod'
import type { Feed } from './feed'
import type { Goals } from './goals'
import type { Memory } from './memory'
import { generateStructured } from './structured'

export const IDEA_KINDS = ['trip', 'shopping', 'goal', 'work', 'home', 'money', 'people', 'other'] as const
export const IDEA_TONES = ['coral', 'teal', 'lilac', 'sky', 'amber'] as const
export type IdeaKind = (typeof IDEA_KINDS)[number]
export interface Idea { id: string; kind: IdeaKind; label: string; text: string; action: string; say: string; tone: (typeof IDEA_TONES)[number]; dismissed?: boolean; done?: boolean }
export interface IdeaMore { id: string; text: string; say: string; done?: boolean }
export interface IdeaBatch { at: number; cards: Idea[]; more: IdeaMore[]; seen?: boolean }
export type IdeaCadence = 'daily' | 'weekly' | 'off'
export interface IdeaSettings { cadence: IdeaCadence; hour: number }

export const DEFAULT_IDEA_SETTINGS: IdeaSettings = { cadence: 'daily', hour: 7 }
const BATCH = 'ideas:batch'
const SETTINGS = 'ideas:settings'
const PUT_AWAY = 'ideas:put-away'
const MONTH = 30 * 86_400_000

const PROMPT = `You think up 点子 for the owner of a personal assistant: a few concrete things the assistant could do for them next.
Rules:
- Every idea comes from the context below (recent conversations, goals, changes it watched, what it knows about the owner). Never invent plans, people or facts that are not there.
- Only offer what an assistant with web access, files and messages can actually do. It never spends money or sends anything without asking first.
- Write in natural, warm Chinese, like a friend who pays attention. "text" is the idea itself in one sentence (at most 36 characters), concrete numbers when there are any.
- "label" is a short eyebrow naming what it is about (e.g. 京都 · 11.28 出发, XM6 · 7 天, 睡眠目标 · 第 9 天).
- "action" is a 2–5 character button (e.g. 排进行程, 去看看, 好啊, 帮我升级). "say" is what the owner would say to the assistant to start it, in Chinese.
- Up to 5 cards, most useful first; fewer is better than filler. Then up to 3 "more": small follow-ups, each one short line.
- Use different tones for neighbouring cards.`

const Output = z.object({
  cards: z.array(z.object({ kind: z.enum(IDEA_KINDS), label: z.string().max(24), text: z.string().min(4).max(60), action: z.string().min(1).max(8), say: z.string().min(2).max(200), tone: z.enum(IDEA_TONES) })).max(5),
  more: z.array(z.object({ text: z.string().min(2).max(30), say: z.string().min(2).max(200) })).max(3),
})
const FIELDS = `- cards: array (≤5) of { kind: one of ${IDEA_KINDS.join(', ')}; label; text; action; say; tone: one of ${IDEA_TONES.join(', ')} }
- more: array (≤3) of { text; say }`
const EXAMPLE: z.infer<typeof Output> = {
  cards: [{ kind: 'trip', label: '京都 · 11.28 出发', text: '带爸妈的话，第 2 天换成岚山小火车，少走 6 公里。', action: '排进行程', say: '把京都行程第 2 天换成岚山小火车，照顾一下爸妈的脚力', tone: 'coral' }],
  more: [{ text: '把耳机对比发给 Lin', say: '把耳机对比表发给 Lin' }],
}

export class Ideas {
  constructor(private store: Store, private hub: ModelHub, private context: () => string, private now: () => number = Date.now, private changed: () => void = () => {}) {}

  settings(): IdeaSettings { return { ...DEFAULT_IDEA_SETTINGS, ...kvGet<Partial<IdeaSettings>>(this.store, SETTINGS) } }
  saveSettings(patch: Partial<IdeaSettings>): IdeaSettings {
    const next = { ...this.settings(), ...patch }
    kvSet(this.store, SETTINGS, next)
    this.changed()
    return next
  }

  batch(): IdeaBatch | null { return kvGet<IdeaBatch>(this.store, BATCH) ?? null }

  /** Whether a new batch is due: after the morning hour, once a day or once a week. */
  due(): boolean {
    const { cadence, hour } = this.settings()
    if (cadence === 'off') return false
    const now = new Date(this.now())
    if (now.getHours() < hour) return false
    const last = this.batch()?.at
    if (!last) return true
    const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).getTime()
    return cadence === 'daily' ? last < morning : last < morning - 6 * 86_400_000
  }

  async refresh(): Promise<IdeaBatch> {
    const role = this.hub.resolve('summarizer') ? 'summarizer' : 'router'
    const counts = this.putAway()
    const avoid = Object.entries(counts).filter(([, n]) => n >= 2).map(([k, n]) => `${k} (put away ${n} times this month)`)
    const out = await generateStructured(this.hub, role, {
      system: PROMPT, schema: Output, fields: FIELDS, example: EXAMPLE, ref: 'ideas', maxOutputTokens: 2_048,
      prompt: `${this.context()}\n\n## Kinds the owner keeps putting away (suggest fewer of these)\n${avoid.join('\n') || '（无）'}`,
    })
    const batch: IdeaBatch = { at: this.now(), cards: out.cards.map(c => ({ ...c, id: newId('ida') })), more: out.more.map(m => ({ ...m, id: newId('idm') })) }
    kvSet(this.store, BATCH, batch)
    this.changed()
    return batch
  }

  private edit(id: string, f: (i: Idea | IdeaMore) => void): Idea | IdeaMore {
    const batch = this.batch()
    const item = [...(batch?.cards ?? []), ...(batch?.more ?? [])].find(i => i.id === id)
    if (!batch || !item) throw new Error(`没有点子 ${id}`)
    f(item)
    kvSet(this.store, BATCH, batch)
    this.changed()
    return item
  }

  /** ×: put away, and remembered so this kind comes up less. */
  dismiss(id: string): void {
    const item = this.edit(id, i => { (i as Idea).dismissed = true })
    if ('kind' in item) {
      const log = (kvGet<{ kind: string; at: number }[]>(this.store, PUT_AWAY) ?? []).filter(e => e.at > this.now() - MONTH)
      kvSet(this.store, PUT_AWAY, [...log, { kind: item.kind, at: this.now() }].slice(-100))
    }
  }

  /** The owner pressed the button; returns what to say in the side chat it opens. */
  take(id: string): Idea | IdeaMore { return this.edit(id, i => { i.done = true }) }

  seen(): void {
    const batch = this.batch()
    if (!batch || batch.seen) return
    kvSet(this.store, BATCH, { ...batch, seen: true })
    this.changed()
  }

  putAway(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const e of kvGet<{ kind: string; at: number }[]>(this.store, PUT_AWAY) ?? []) if (e.at > this.now() - MONTH) counts[e.kind] = (counts[e.kind] ?? 0) + 1
    return counts
  }
}

/** What the ideas are thought up from: the last week of the owner's own conversations, goals, 动态 and what it knows about them. */
export function ideasContext(store: Store, parts: { goals: Goals; feed: Feed; memory: Memory }, now = Date.now()): string {
  const week = now - 7 * 86_400_000
  const rows = store.db.select({ role: schema.messages.role, content: schema.messages.content, at: schema.messages.createdAt, title: schema.conversations.title })
    .from(schema.messages).innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.conversations.source, 'webchat'), inArray(schema.messages.role, ['user', 'assistant']), gte(schema.messages.createdAt, week)))
    .orderBy(desc(schema.messages.createdAt)).limit(80).all().reverse()
  const day = (at: number) => { const d = new Date(at); return `${d.getMonth() + 1}.${d.getDate()}` }
  const talk = rows.map(r => `[${day(r.at)} ${r.title}] ${r.role === 'user' ? 'owner' : 'assistant'}: ${r.content.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n').slice(-7_000)
  const feed = parts.feed.list().slice(0, 12).map(i => `- ${day(i.at)} ${i.title}${i.text ? ` · ${i.text}` : ''}`).join('\n')
  const known = parts.memory.list({ status: 'active' }).slice(0, 20).map(m => `- ${m.text}`).join('\n')
  const d = new Date(now)
  return `Today is ${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}.

## Recent conversations (last 7 days)
${talk || '（无）'}

## Goals
${parts.goals.describe()}

## What changed lately (动态)
${feed || '（无）'}

## What it knows about the owner
${known || '（无）'}`
}
