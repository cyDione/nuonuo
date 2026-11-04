/**
 * Routines: work the owner scheduled ("每天 9 点给我一份简报"). Each routine has its own conversation; when it fires, its prompt
 * arrives at the router as the owner's request from the `cron` source, and the results land in that conversation.
 * A laptop that slept through a run catches up once on waking (if the run is less than 12 hours old).
 */
import { newId, schema, type Store } from '@super-agent/db'
import { tool } from 'ai'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { lastRunBetween, nextRun, parseCron } from './cron'
import type { SourceContext, SourceKind } from './kind'

const CATCH_UP_MS = 12 * 3600_000
export type Routine = typeof schema.routines.$inferSelect

export class Routines {
  constructor(private store: Store) {}
  list(): (Routine & { next: number | null })[] {
    return this.store.db.select().from(schema.routines).orderBy(asc(schema.routines.createdAt)).all()
      .map(r => ({ ...r, next: r.enabled ? nextRun(parseCron(r.schedule), new Date())?.getTime() ?? null : null }))
  }
  get(id: string): Routine | undefined { return this.store.db.select().from(schema.routines).where(eq(schema.routines.id, id)).get() }
  create(input: { name: string; schedule: string; prompt: string; enabled?: boolean }): Routine {
    parseCron(input.schedule)
    const id = newId('rtn')
    const at = Date.now()
    this.store.db.insert(schema.routines).values({ id, name: input.name.slice(0, 60), schedule: input.schedule.trim(), prompt: input.prompt, enabled: input.enabled ?? true,
      lastFiredAt: at, createdAt: at, updatedAt: at }).run()
    return this.get(id)!
  }
  update(id: string, patch: Partial<Pick<Routine, 'name' | 'schedule' | 'prompt' | 'enabled'>>): Routine {
    if (!this.get(id)) throw new Error(`没有定时任务 ${id}`)
    if (patch.schedule) parseCron(patch.schedule)
    this.store.db.update(schema.routines).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.routines.id, id)).run()
    return this.get(id)!
  }
  delete(id: string): void { this.store.db.delete(schema.routines).where(eq(schema.routines.id, id)).run() }

  /** Fires every routine whose schedule passed since it last fired; returns the ones fired. */
  tick(fire: (routine: Routine, at: Date) => void, now = Date.now()): Routine[] {
    const fired: Routine[] = []
    for (const r of this.list()) {
      if (!r.enabled) continue
      const since = Math.max(r.lastFiredAt ?? r.createdAt, now - CATCH_UP_MS)
      const due = lastRunBetween(parseCron(r.schedule), since, now)
      if (!due) continue
      this.store.db.update(schema.routines).set({ lastFiredAt: now }).where(eq(schema.routines.id, r.id)).run()
      fire(r, due)
      fired.push(r)
    }
    return fired
  }

  /** Runs a routine right away (the settings page's "run now"). */
  runNow(id: string, fire: (routine: Routine, at: Date) => void): void {
    const r = this.get(id)
    if (!r) throw new Error(`没有定时任务 ${id}`)
    fire(r, new Date())
  }
}

export function fireRoutine(ctx: Pick<SourceContext<unknown>, 'engine' | 'store'>, routine: Routine, at: Date): void {
  const threadId = `cron:${routine.id}`
  const result = ctx.engine.receive({
    id: `cron:${routine.id}:${at.toISOString()}`, source: 'cron', threadId, actor: 'owner', human: true, addressed: true, at: Date.now(),
    text: `⏰ 定时任务「${routine.name}」到点了（${routine.schedule}）：\n${routine.prompt}`,
    meta: { routineId: routine.id }, thread: { title: `⏰ ${routine.name}`, meta: { routineId: routine.id } },
  })
  if (result.status === 'stored') {
    const conversationId = ctx.engine.conversationOfThread(threadId)
    if (conversationId) ctx.store.db.update(schema.routines).set({ conversationId }).where(eq(schema.routines.id, routine.id)).run()
  }
}

export function routinesKind(routines: Routines): SourceKind<Record<string, never>> {
  const fire = (ctx: SourceContext<unknown>) => (r: Routine, at: Date) => fireRoutine(ctx, r, at)
  return {
    id: 'cron',
    title: '定时任务',
    description: '按计划自动执行的任务（例如每天 9 点的简报）。可以直接对主 Agent 说「每天早上 9 点…」来创建，也可以在「定时任务」页管理。',
    defaultEnabled: true,
    schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    fields: [],
    start(ctx) {
      const tick = () => { try { routines.tick(fire(ctx)); ctx.health('ok', `${routines.list().filter(r => r.enabled).length} 个启用`) } catch (e) { ctx.health('error', String(e)) } }
      tick()
      const timer = setInterval(tick, 20_000)
      return () => clearInterval(timer)
    },
    allowed: (_ctx, actor) => actor === 'owner',
    routerPrompt: () => `## Routines
The owner can ask for work on a schedule ("每天早上 9 点给我简报", "每周一提醒我…"). Create it with schedule_routine (5-field cron, local time, e.g. "0 9 * * *"), confirm the schedule in one sentence, and list or change routines with list_routines / update_routine. When a routine fires you receive a <message source="cron"> in that routine's conversation: treat it as the owner's request (usually start_task) and answer there.`,
    routerTools: ctx => ({
      schedule_routine: tool({
        description: 'Create a routine: the prompt is delivered to you as the owner\'s request at every matching time (5-field cron, local time).',
        inputSchema: z.object({ name: z.string().min(1).max(40), schedule: z.string().describe('cron, e.g. "0 9 * * 1-5"'), prompt: z.string().min(1).describe('What to do each time, written as the owner\'s request') }),
        execute: async input => {
          const r = routines.create(input)
          const next = nextRun(parseCron(r.schedule), new Date())
          return { ok: true, routine_id: r.id, next_run: next?.toString() }
        },
      }),
      list_routines: tool({
        description: 'List routines with their schedules and next run.',
        inputSchema: z.object({}),
        execute: async () => routines.list().map(r => `${r.id} "${r.name}" ${r.schedule} ${r.enabled ? `next ${r.next ? new Date(r.next).toString() : '-'}` : 'disabled'}: ${r.prompt.slice(0, 80)}`).join('\n') || '（没有定时任务）',
      }),
      update_routine: tool({
        description: 'Change, pause (enabled=false), resume or delete a routine.',
        inputSchema: z.object({ routine_id: z.string(), name: z.string().optional(), schedule: z.string().optional(), prompt: z.string().optional(), enabled: z.boolean().optional(), delete: z.boolean().optional() }),
        execute: async ({ routine_id, delete: remove, ...patch }) => {
          if (remove) { routines.delete(routine_id); return { ok: true, deleted: true } }
          const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
          return { ok: true, routine: routines.update(routine_id, clean) }
        },
      }),
    }),
  }
}
