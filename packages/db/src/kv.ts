import { eq } from 'drizzle-orm'
import type { Store } from './database'
import { kv } from './schema'

export function kvGet<T>(store: Store, key: string): T | undefined {
  return store.db.select().from(kv).where(eq(kv.key, key)).get()?.value as T | undefined
}

export function kvSet(store: Store, key: string, value: unknown): void {
  store.db.insert(kv).values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } }).run()
}
