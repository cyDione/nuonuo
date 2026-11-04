/**
 * Durable side-effect queue (ported in spirit from dsh-superagent's Effects): commands enqueue work inside their transaction,
 * handlers run it after commit, failures retry with exponential backoff, and throwing `Later` defers without counting a failure.
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import type { Store } from './database'
import { effects } from './schema'

export class Later extends Error {
  constructor(readonly delayMs = 2_000) { super('later') }
}

export interface HandlerOptions {
  /** Rows of this kind that may run at once. */
  concurrency?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

type Handler = { run: (payload: any, key: string) => Promise<void>; options: Required<HandlerOptions>; running: number }

export interface EffectHealth { kind: string; pending: number; failing: number; lastError?: string }

export class Effects {
  private handlers = new Map<string, Handler>()
  private timer: NodeJS.Timeout | undefined
  private active = new Set<Promise<void>>()
  private running = false
  private inFlight = new Set<number>()

  constructor(private store: Store, private now: () => number = Date.now, private pollMs = 500) {}

  /** Queues work; an existing waiting row with the same kind/key gets the new payload and becomes due now, keeping its place. */
  enqueue(kind: string, key: string, payload: unknown): void {
    const at = this.now()
    this.store.db.insert(effects).values({ kind, key, payload, dueAt: at })
      .onConflictDoUpdate({ target: [effects.kind, effects.key], set: { payload, dueAt: at } }).run()
    this.store.afterCommit(() => this.kick())
  }

  cancel(kind: string, key: string): void {
    this.store.db.delete(effects).where(and(eq(effects.kind, kind), eq(effects.key, key))).run()
  }

  handle<P>(kind: string, run: (payload: P, key: string) => Promise<void>, options: HandlerOptions = {}): void {
    if (this.handlers.has(kind)) throw new Error(`effect kind ${kind} already has a handler`)
    this.handlers.set(kind, { run, running: 0, options: { concurrency: 1, baseDelayMs: 2_000, maxDelayMs: 60_000, ...options } })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.kick()
  }

  /** Stops picking new rows and waits for running handlers; pending rows stay stored. */
  async drain(): Promise<void> {
    this.running = false
    clearTimeout(this.timer)
    await Promise.allSettled([...this.active])
  }

  /** Runs every due row once and waits for it; for tests and CLI one-shots. */
  async tick(): Promise<void> {
    this.pump()
    await Promise.allSettled([...this.active])
  }

  health(): EffectHealth[] {
    const rows = this.store.sqlite.prepare(
      `SELECT kind, count(*) AS pending, sum(attempts >= 3) AS failing,
        (SELECT last_error FROM effects e2 WHERE e2.kind = effects.kind AND e2.attempts >= 3 ORDER BY id LIMIT 1) AS lastError
       FROM effects GROUP BY kind`).all() as { kind: string; pending: number; failing: number; lastError: string | null }[]
    return rows.map(r => ({ kind: r.kind, pending: r.pending, failing: r.failing ?? 0, ...(r.lastError ? { lastError: r.lastError } : {}) }))
  }

  private kick(): void {
    if (!this.running) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.loop(), 0)
  }

  private loop(): void {
    if (!this.running) return
    this.pump()
    this.timer = setTimeout(() => this.loop(), this.pollMs)
  }

  private pump(): void {
    const at = this.now()
    for (const [kind, handler] of this.handlers) {
      const free = handler.options.concurrency - handler.running
      if (free <= 0) continue
      const rows = this.store.db.select().from(effects)
        .where(and(eq(effects.kind, kind), lte(effects.dueAt, at)))
        .orderBy(asc(effects.dueAt), asc(effects.id)).limit(free + this.inFlight.size).all()
        .filter(row => !this.inFlight.has(row.id)).slice(0, free)
      for (const row of rows) this.execute(handler, row)
    }
  }

  private execute(handler: Handler, row: typeof effects.$inferSelect): void {
    handler.running++
    this.inFlight.add(row.id)
    const task = (async () => {
      try {
        await handler.run(row.payload, row.key)
        // Delete only the version we ran: a re-enqueue during the run changed payload/dueAt and must run again.
        this.store.sqlite.prepare('DELETE FROM effects WHERE id = ? AND due_at = ?').run(row.id, row.dueAt)
      } catch (error) {
        if (error instanceof Later) {
          this.store.db.update(effects).set({ dueAt: this.now() + error.delayMs })
            .where(and(eq(effects.id, row.id), eq(effects.dueAt, row.dueAt))).run()
        } else {
          const attempts = row.attempts + 1
          const delay = Math.min(handler.options.baseDelayMs * 2 ** (attempts - 1), handler.options.maxDelayMs)
          this.store.db.update(effects).set({ attempts: sql`${effects.attempts} + 1`, dueAt: this.now() + delay,
            lastError: error instanceof Error ? error.message : String(error) })
            .where(and(eq(effects.id, row.id), eq(effects.dueAt, row.dueAt))).run()
        }
      } finally {
        handler.running--
        this.inFlight.delete(row.id)
      }
    })()
    this.active.add(task)
    void task.finally(() => { this.active.delete(task); if (this.running) this.kick() })
  }
}
