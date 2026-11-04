/** Opens the SQLite state database with WAL, foreign keys and pending migrations applied. */
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { MIGRATIONS } from './migrations'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>

export interface Store {
  readonly sqlite: Database.Database
  readonly db: Db
  /** Runs `fn` in one transaction (nested calls become savepoints); actions passed to `afterCommit` run only if the outermost one commits. */
  atomic<T>(fn: () => T): T
  afterCommit(action: () => void): void
  close(): void
}

export function openStore(file: string): Store {
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  migrate(sqlite)
  const db = drizzle(sqlite, { schema })
  let pending: (() => void)[] | undefined
  let depth = 0

  const atomic = <T>(fn: () => T): T => {
    const outer = depth === 0
    if (outer) pending = []
    depth++
    try {
      const result = sqlite.transaction(fn)()
      depth--
      if (outer) {
        const actions = pending ?? []
        pending = undefined
        for (const action of actions) action()
      }
      return result
    } catch (error) {
      depth--
      if (outer) pending = undefined
      throw error
    }
  }

  return {
    sqlite, db, atomic,
    afterCommit(action) {
      if (pending) pending.push(action)
      else action()
    },
    close() { sqlite.close() },
  }
}

export function migrate(sqlite: Database.Database): number {
  const current = sqlite.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) throw new Error(`state database schema ${current} is newer than this build (${MIGRATIONS.length})`)
  for (let version = current; version < MIGRATIONS.length; version++) {
    sqlite.transaction(() => {
      sqlite.exec(MIGRATIONS[version]!)
      sqlite.pragma(`user_version = ${version + 1}`)
    })()
  }
  return MIGRATIONS.length
}
