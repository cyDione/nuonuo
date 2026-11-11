/**
 * Goals (目标, Figma v6 section 19 and the right pane's 目标): long-running aims the owner sets by saying 「我想……」.
 * Each is an amount toward a target (¥6,400 / 12,000, 1 / 2 本) or days kept out of a number of days (第 9 / 21 天).
 * The assistant records progress and what it did toward each one; the owner sees them on the 目标 page.
 */
import { newId, schema, type Store } from '@nuonuo/db'
import { tool, type ToolSet } from 'ai'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { ModelHub } from '@nuonuo/models'
import type { AgentExtensions } from './agents'
import { generateStructured } from './structured'

export const GOAL_ICONS = ['target', 'moon', 'wallet', 'book', 'run', 'dumbbell', 'heart', 'music', 'code', 'leaf', 'globe', 'pen'] as const
export type GoalIcon = (typeof GOAL_ICONS)[number]
export type Goal = typeof schema.goals.$inferSelect
export type GoalLogEntry = typeof schema.goalLog.$inferSelect
export interface GoalInput { title: string; parentId?: string | null; icon?: GoalIcon; style?: 'amount' | 'days'; unit?: string; current?: number; target: number; note?: string | null }
export type GoalPatch = Partial<GoalInput & { headline: Goal['headline']; pinned: boolean; status: Goal['status'] }>

const WEEK = 7 * 86_400_000

export class Goals {
  constructor(private store: Store, private now: () => number = Date.now, private changed: () => void = () => {}) {}

  list(status: Goal['status'][] = ['active']): Goal[] {
    return this.store.db.select().from(schema.goals).where(inArray(schema.goals.status, status))
      .orderBy(desc(schema.goals.pinned), sql`${schema.goals.position} IS NULL`, schema.goals.position, schema.goals.createdAt).all()
  }

  get(id: string): Goal {
    const goal = this.store.db.select().from(schema.goals).where(eq(schema.goals.id, id)).get()
    if (!goal) throw new Error(`没有目标 ${id}`)
    return goal
  }

  create(input: GoalInput): Goal {
    if (input.parentId) { const parent = this.get(input.parentId); if (parent.parentId) throw new Error('子目标下面不能再分') }
    const at = this.now()
    const id = newId('gol')
    this.store.db.insert(schema.goals).values({
      id, title: input.title, icon: input.icon ?? 'target', style: input.style ?? 'amount', unit: input.unit ?? (input.style === 'days' ? '天' : ''),
      current: input.current ?? 0, target: input.target, note: input.note ?? null, parentId: input.parentId ?? null, createdAt: at, updatedAt: at,
    }).run()
    this.changed()
    return this.get(id)
  }

  update(id: string, patch: GoalPatch): Goal {
    this.get(id)
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    // Only one goal is pinned: it is the colour card at the top of the page.
    if (patch.pinned) this.store.db.update(schema.goals).set({ pinned: false }).run()
    this.store.db.update(schema.goals).set({ ...clean, updatedAt: this.now() }).where(eq(schema.goals.id, id)).run()
    this.changed()
    return this.get(id)
  }

  /** The owner dragged goals into this order (ids first to last); others keep theirs after. */
  reorder(ids: string[]): Goal[] {
    this.store.atomic(() => ids.forEach((id, i) => { this.get(id); this.store.db.update(schema.goals).set({ position: i }).where(eq(schema.goals.id, id)).run() }))
    this.changed()
    return this.list()
  }

  /** Records something done toward a goal; `delta` moves its progress (a day kept, money saved, a book read). */
  log(id: string, text: string, delta?: number): Goal {
    const goal = this.get(id)
    const at = this.now()
    this.store.atomic(() => {
      this.store.db.insert(schema.goalLog).values({ id: newId('glg'), goalId: id, at, text, delta: delta ?? null }).run()
      if (delta) {
        const current = Math.max(0, goal.current + delta)
        this.store.db.update(schema.goals).set({ current, updatedAt: at, ...(current >= goal.target && goal.status === 'active' ? { status: 'done' as const } : {}) }).where(eq(schema.goals.id, id)).run()
      }
    })
    this.changed()
    return this.get(id)
  }

  remove(id: string): void {
    this.store.db.delete(schema.goals).where(eq(schema.goals.parentId, id)).run()
    this.store.db.delete(schema.goals).where(eq(schema.goals.id, id)).run()
    this.changed()
  }

  /** What was done toward the goals in the last seven days, newest first. */
  week(): (GoalLogEntry & { goal: string })[] {
    return this.store.db.select({ entry: schema.goalLog, goal: schema.goals.title }).from(schema.goalLog)
      .innerJoin(schema.goals, eq(schema.goals.id, schema.goalLog.goalId))
      .where(and(gte(schema.goalLog.at, this.now() - WEEK))).orderBy(desc(schema.goalLog.at)).all()
      .map(r => ({ ...r.entry, goal: r.goal }))
  }

  describe(): string {
    const goals = this.list()
    if (!goals.length) return '（还没有目标）'
    const line = (g: Goal) => `${g.id} "${g.title}" ${g.style === 'days' ? `第 ${g.current} / ${g.target} 天` : `${g.current} / ${g.target}${g.unit}`}${g.note ? ` · ${g.note}` : ''}`
    return goals.filter(g => !g.parentId || !goals.some(p => p.id === g.parentId))
      .map(g => [line(g), ...goals.filter(c => c.parentId === g.id).map(c => `  └ ${line(c)}`)].join('\n')).join('\n')
  }
}

const GoalFields = {
  title: z.string().min(1).max(40).describe('Short, in the owner\'s words, e.g. 睡得更早, 攒钱买相机, 每月读两本书'),
  icon: z.enum(GOAL_ICONS).optional(),
  style: z.enum(['amount', 'days']).optional().describe('"days": keep something up for a number of days (target = days); "amount": reach a number (money, books, km)'),
  unit: z.string().max(8).optional().describe('e.g. ¥ is written as unit "元"; 本, km, 次'),
  target: z.number().positive(),
  current: z.number().min(0).optional(),
  note: z.string().max(60).optional().describe('One line on how it is going, e.g. 照现在的速度，2 月底就够了'),
  parent_id: z.string().optional().describe('Make it a step (子目标) of this goal; only one level'),
}

/** The main agent sets goals when the owner says 「我想……」; workers record what they did toward one. */
export function goalsExtension(goals: Goals): AgentExtensions {
  const logTool = tool({
    description: 'Record something you did toward one of the owner\'s goals (shown under 这周它帮你做的), and optionally move its progress.',
    inputSchema: z.object({ goal_id: z.string(), text: z.string().min(1).max(80).describe('What you did, in Chinese, e.g. 23:00 提醒你放下手机'), delta: z.number().optional().describe('Progress to add: 1 day kept, 300 saved, 1 book') }),
    execute: async ({ goal_id, text, delta }) => { const g = goals.log(goal_id, text, delta); return { ok: true, progress: `${g.current} / ${g.target}`, status: g.status } },
  })
  const listTool = tool({ description: 'List the owner\'s active goals with their progress.', inputSchema: z.object({}), execute: async () => goals.describe() })
  return {
    routerPrompt: () => `## Goals
When the owner wants something long-running (「我想每周跑三次」「攒钱买相机」「睡得更早」), set a goal with set_goal and confirm it in one sentence. A big goal can get 2–4 concrete steps as sub-goals (set_goal with parent_id); offer them in one sentence rather than adding them unasked. Record progress and what you did toward a goal with log_goal; change, pin, finish or drop one with update_goal. Active goals:
${goals.describe()}`,
    routerTools: (): ToolSet => ({
      set_goal: tool({
        description: 'Create a goal for the owner (目标). Use style "days" for habits kept over a number of days, "amount" for reaching a number.',
        inputSchema: z.object(GoalFields),
        execute: async ({ parent_id, ...input }) => ({ ok: true, goal: goals.create({ ...input, ...(parent_id ? { parentId: parent_id } : {}) }) }),
      }),
      update_goal: tool({
        description: 'Change a goal: its numbers, its one-line note, the big number on its card (headline), pin it to the top, mark it done or drop it.',
        inputSchema: z.object({
          goal_id: z.string(), ...Object.fromEntries(Object.entries(GoalFields).map(([k, v]) => [k, v.optional()])),
          headline: z.object({ value: z.string().max(12), unit: z.string().max(8).optional(), note: z.string().max(40).optional() }).optional().describe('The big number on the pinned card, e.g. {value: "6.8", unit: "小时", note: "这周平均每晚，比上周多 20 分钟"}'),
          pinned: z.boolean().optional(), status: z.enum(['active', 'done', 'dropped']).optional(),
        }),
        execute: async ({ goal_id, ...patch }) => { const { parent_id: _parent, ...rest } = patch as Record<string, unknown>; return { ok: true, goal: goals.update(goal_id, rest as GoalPatch) } },
      }),
      log_goal: logTool,
      list_goals: listTool,
    }),
    workerTools: (): ToolSet => ({ log_goal: logTool, list_goals: listTool }),
  }
}

const StepsSchema = z.object({ steps: z.array(z.object({ title: z.string().min(1).max(40), target: z.number().positive(), unit: z.string().max(8).optional(), style: z.enum(['amount', 'days']).optional() })).min(1).max(4) })
export type GoalSteps = z.infer<typeof StepsSchema>['steps']

/** 拆成几步: 2–4 concrete sub-goals proposed for a goal; the owner picks which to add. */
export async function suggestSteps(hub: ModelHub, goal: Goal, existing: Goal[]): Promise<GoalSteps> {
  const role = hub.resolve('summarizer') ? 'summarizer' : 'router'
  const { steps } = await generateStructured(hub, role, {
    system: 'You help a person break a long-running goal into 2–4 concrete, measurable steps they can track. Titles are short and in the goal\'s language. Do not repeat steps that exist.',
    schema: StepsSchema, ref: goal.id, maxOutputTokens: 1_024,
    fields: 'steps: array of { title (≤ 40 chars), target (number), unit (optional, e.g. 次, 本, 元), style ("amount" or "days") }',
    example: { steps: [{ title: '每周跑三次', target: 12, unit: '次', style: 'amount' }, { title: '连续早睡 21 天', target: 21, style: 'days' }] },
    prompt: `Goal: ${goal.title} (${goal.current} / ${goal.target}${goal.unit})${goal.note ? `\nNote: ${goal.note}` : ''}\nExisting steps: ${existing.map(e => e.title).join('、') || 'none'}`,
  })
  return steps
}
