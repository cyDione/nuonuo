import { eq } from 'drizzle-orm'
import type { Store } from './database'
import { kv } from './schema'

export function kvGet<T>(store: Store, key: string): T | undefined {
  return store.db.select().from(kv).where(eq(kv.key, key)).get()?.value as T | undefined
}

/** Stores a JSON value; null or undefined removes the key. */
export function kvSet(store: Store, key: string, value: unknown): void {
  if (value === null || value === undefined) { store.db.delete(kv).where(eq(kv.key, key)).run(); return }
  store.db.insert(kv).values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } }).run()
}
