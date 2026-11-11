/**
 * Inline & Spill for tool output: long text goes to a blob and the model sees its head, tail and a `blob_…` ref it can page
 * through with `recall`, so the context window keeps room for what matters.
 */
import { newId, schema, type Store } from '@nuonuo/db'
import { eq } from 'drizzle-orm'

export const SPILL_CHARS = 12_000
export const PAGE_CHARS = 10_000

export class Blobs {
  constructor(private store: Store) {}

  save(kind: string, content: string, meta: Record<string, unknown> = {}): string {
    const id = newId('blob')
    this.store.db.insert(schema.blobs).values({ id, kind, content, meta, createdAt: Date.now() }).run()
    return id
  }

  read(id: string): string | undefined {
    return this.store.db.select().from(schema.blobs).where(eq(schema.blobs.id, id)).get()?.content
  }

  /** One page of a blob, 1-based, with how many pages there are. */
  page(id: string, page = 1): { text: string; page: number; pages: number } | undefined {
    const content = this.read(id)
    if (content === undefined) return undefined
    const pages = Math.max(1, Math.ceil(content.length / PAGE_CHARS))
    const p = Math.min(Math.max(1, Math.floor(page)), pages)
    return { text: content.slice((p - 1) * PAGE_CHARS, p * PAGE_CHARS), page: p, pages }
  }

  /** Returns `text` unchanged when short; otherwise head + tail + a ref to the full text. */
  spill(kind: string, text: string, limit = SPILL_CHARS): string {
    if (text.length <= limit) return text
    const id = this.save(kind, text)
    const head = text.slice(0, Math.floor(limit * 0.6))
    const tail = text.slice(-Math.floor(limit * 0.25))
    return `${head}\n\n…[已截断：共 ${text.length} 字符，完整内容见 ${id}，用 recall("${id}", page) 分页读取]…\n\n${tail}`
  }
}
