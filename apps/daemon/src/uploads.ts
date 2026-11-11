/** Files the owner attaches to messages: kept under <home>/uploads/<id>/<name>, listed in the uploads table. */
import { newId, schema, type Store } from '@super-assistant/db'
import type { Attachment } from '@super-assistant/core'
import { eq, inArray } from 'drizzle-orm'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

export const MAX_UPLOAD = 50 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json' }

/** A file name that is safe on every platform and keeps its extension. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+/, '_').trim()
  return (base || 'file').slice(-120)
}

export class Uploads {
  constructor(private store: Store, private dir: string, private now: () => number = Date.now) {}

  save(input: { name: string; mime?: string; bytes: Uint8Array; conversationId?: string }): Attachment {
    if (input.bytes.byteLength > MAX_UPLOAD) throw new Error('文件超过 50MB')
    const id = newId('upl')
    const name = safeName(input.name)
    const folder = join(this.dir, id)
    mkdirSync(folder, { recursive: true })
    const path = join(folder, name)
    writeFileSync(path, input.bytes)
    const mime = input.mime && input.mime !== 'application/octet-stream' ? input.mime : MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream'
    const row = { id, conversationId: input.conversationId ?? null, messageId: null, name, mime, size: input.bytes.byteLength, path, createdAt: this.now() }
    this.store.db.insert(schema.uploads).values(row).run()
    return { id, name, mime, size: row.size, path }
  }

  get(id: string) { return this.store.db.select().from(schema.uploads).where(eq(schema.uploads.id, id)).get() }

  /** Attachments for a new message, in the order given; unknown or already-sent ids are refused. */
  take(ids: string[]): Attachment[] {
    if (!ids.length) return []
    const rows = this.store.db.select().from(schema.uploads).where(inArray(schema.uploads.id, ids)).all()
    return ids.map(id => {
      const r = rows.find(x => x.id === id)
      if (!r) throw new Error(`没有附件 ${id}`)
      if (r.messageId) throw new Error(`附件 ${r.name} 已经发过了`)
      return { id: r.id, name: r.name, mime: r.mime, size: r.size, path: r.path }
    })
  }

  /** Removes an attachment that was never sent (the × on its chip). */
  discard(id: string): boolean {
    const row = this.get(id)
    if (!row || row.messageId) return false
    this.store.db.delete(schema.uploads).where(eq(schema.uploads.id, id)).run()
    rmSync(join(this.dir, id), { recursive: true, force: true })
    return true
  }
}
