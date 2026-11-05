/**
 * Proactive intake (article §3.1, §3.4): events nobody addressed to the agent pass a program filter (Fast Path), then the
 * filter layer reads them against the owner's natural-language strategy (Slow Path). In `observe` mode the decision is
 * only recorded ("I would have…"); in `auto` mode a silent task works on it and the result reaches the owner only if it
 * is worth their attention.
 */
import { kvGet, kvSet, schema, type Store } from '@super-assistant/db'
import type { ModelHub } from '@super-assistant/models'
import { generateText, Output } from 'ai'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { clip, type Engine } from './engine'

export type ProactiveMode = 'off' | 'observe' | 'auto'

export interface ProactiveSettings {
  mode: ProactiveMode
  /** The owner's strategy in their own words: what is worth acting on, what to leave alone. */
  strategy: string
  /** Sources whose unaddressed events are screened; empty means every external source. */
  sources: string[]
  /** Accounts never screened (noisy bots). */
  ignoreActors: string[]
  /** Speculative work has a cost: at most this many silent tasks at once, and per day. */
  budget: { concurrent: number; daily: number }
  /** Every change is a new version; decisions and silent tasks record the version they were made under. */
  version: number
  by?: string
  at?: number
}

export const DEFAULT_STRATEGY = `- 我关注的仓库里 CI 失败、或有人报告了看起来能复现的 bug：先在本地悄悄复现、定位，准备好修复方案再告诉我；复现不了就算了，不用告诉我。
- 有人问的问题能直接查到答案：起草一个回复给我过目，不要自己发出去。
- 闲聊、感谢、已经有人在处理的事、机器人的例行通知：不用管。`

export const DEFAULT_PROACTIVE: ProactiveSettings = { mode: 'off', strategy: DEFAULT_STRATEGY, sources: [], ignoreActors: ['dependabot[bot]', 'renovate[bot]'],
  budget: { concurrent: 2, daily: 10 }, version: 0 }

const KEY = 'settings:proactive'
const HISTORY = 'settings:proactive:history'
const POLICY: (keyof ProactiveSettings)[] = ['mode', 'strategy', 'sources', 'ignoreActors', 'budget']

export function proactiveSettings(store: Store): ProactiveSettings {
  const saved = kvGet<Partial<ProactiveSettings>>(store, KEY) ?? {}
  return { ...DEFAULT_PROACTIVE, ...saved, budget: { ...DEFAULT_PROACTIVE.budget, ...(saved.budget ?? {}) } }
}

export function proactiveHistory(store: Store): ProactiveSettings[] {
  return kvGet<ProactiveSettings[]>(store, HISTORY) ?? []
}

/** Saves a change as a new policy version (unchanged settings keep their version). */
export function saveProactiveSettings(store: Store, patch: Partial<ProactiveSettings>, by = 'owner'): ProactiveSettings {
  const cur = proactiveSettings(store)
  const merged = { ...cur, ...patch, budget: { ...cur.budget, ...(patch.budget ?? {}) } }
  if (POLICY.every(k => JSON.stringify(merged[k]) === JSON.stringify(cur[k]))) return cur
  const next: ProactiveSettings = { ...merged, version: cur.version + 1, by, at: Date.now() }
  store.atomic(() => {
    kvSet(store, KEY, next)
    kvSet(store, HISTORY, [next, ...proactiveHistory(store)].slice(0, 30))
  })
  return next
}

/** Fast Path: cheap program rules. Returns why an event is not screened, or undefined to screen it. */
export function fastPath(settings: ProactiveSettings, t: { source: string; actor: string; text: string }): string | undefined {
  if (settings.mode === 'off') return 'proactive_off'
  if (t.source === 'webchat' || t.source === 'cron' || t.source === 'watchdog') return 'internal'
  if (settings.sources.length && !settings.sources.includes(t.source)) return 'source_not_watched'
  if (settings.ignoreActors.some(a => a.toLowerCase() === t.actor.toLowerCase())) return 'actor_ignored'
  if (t.text.trim().length < 2) return 'empty'
  return undefined
}

const FILTER_PROMPT = `You screen events for the owner's personal agent. The events were not addressed to the agent; most deserve nothing.
Decide, strictly by the owner's strategy below, whether the agent should quietly work on this one. When in doubt, do not act.
Acting means: a silent background task investigates or prepares something; nothing is posted anywhere without the owner.
Answer with act (boolean), reason (one short sentence in the owner's language, Chinese by default) and, when acting, title (≤ 16 characters, the owner's language) and goal (one sentence: what the silent task should find out or prepare).`

export const FilterVerdict = z.object({
  act: z.boolean(),
  reason: z.string(),
  title: z.string().optional(),
  goal: z.string().optional(),
})
export type FilterVerdict = z.infer<typeof FilterVerdict>

export class Screener {
  constructor(private store: Store, private hub: ModelHub, private engine: Engine) {}

  /** Slow Path for one trigger; records the decision and, in auto mode, starts the silent task. */
  async screen(triggerId: string): Promise<FilterVerdict | undefined> {
    const trigger = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()
    if (!trigger) return undefined
    const settings = proactiveSettings(this.store)
    if (settings.mode === 'off') { this.engine.proactiveDecision(triggerId, { act: false, reason: '主动处理已关闭' }, 'off'); return undefined }
    const thread = this.store.db.select().from(schema.threads).where(eq(schema.threads.id, trigger.threadId)).get()
    const earlier = this.store.db.select().from(schema.triggers).where(eq(schema.triggers.threadId, trigger.threadId))
      .orderBy(desc(schema.triggers.at)).limit(7).all().filter(t => t.id !== trigger.id).slice(0, 6).reverse()
    const tasks = this.engine.tickets({ threadId: trigger.threadId }).slice(0, 5)
    const prompt = [
      `## The owner's strategy\n${settings.strategy}`,
      `## Event\nsource: ${trigger.source}\nfrom: ${trigger.actor}${trigger.human ? '' : ' (bot)'}\nthread: ${(thread?.meta as { title?: string })?.title ?? trigger.threadId}`,
      earlier.length ? `earlier in this thread:\n${earlier.map(e => `- ${e.actor}: ${clip(e.text.replace(/\s+/g, ' '), 200)}`).join('\n')}` : '',
      tasks.length ? `agent tasks on this thread: ${tasks.map(t => `"${t.title}" ${t.ended ? 'ended' : 'open'}`).join(', ')}` : '',
      `text:\n${clip(trigger.text, 4_000)}`,
    ].filter(Boolean).join('\n\n')
    const { output } = await generateText({
      // The filter layer is optional; without it the main agent's model screens (roles.ts: "关闭时由主 Agent 兼做").
      model: this.hub.model(this.hub.resolve('filter') ? 'filter' : 'router', { ref: triggerId }), system: FILTER_PROMPT, prompt, maxRetries: 1,
      output: Output.object({ schema: FilterVerdict }),
    })
    this.engine.proactiveDecision(triggerId, output, settings.mode)
    return output
  }
}
