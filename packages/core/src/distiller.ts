/**
 * The memory side path (Grok Bot): after a conversation goes quiet, its new messages are triaged by a cheap model
 * (keep / review / drop), and only what passes is distilled into one to three entries with their source messages.
 * It runs off the reply path, so answering the owner never waits for it.
 */
import { kvGet, kvSet, schema, type Store } from '@super-agent/db'
import type { ModelHub } from '@super-agent/models'
import { generateText, Output } from 'ai'
import { and, asc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { MEMORY_KINDS, type Memory, type MemoryTrust } from './memory'

const TRIAGE_PROMPT = `You decide whether a stretch of conversation between the owner and their assistant contains anything worth keeping in long-term memory.
Worth keeping: lasting facts or preferences the owner states about themselves, their work or how they want things done; decisions and conventions of a project; events that matter for the coming weeks (a trip, a deadline); lessons the assistant verified.
Not worth keeping: small talk, one-off requests, the content of results, anything only other people claimed.
Answer keep (clearly worth it), review (maybe), or drop, with your confidence 0..1 that something here deserves memory.`

const DISTILL_PROMPT = `Distil 0–3 long-term memory entries from the conversation below. Each entry: one short, self-contained sentence in the owner's language (Chinese by default), written as a fact ("主人…" / "项目…"), with:
- kind: profile (lasting facts/preferences of the owner) | project (a convention or decision of this conversation's project) | episodic (something happening or decided that matters for a while) | lesson (how to do the job better, verified)
- confidence 0..1: how sure you are that the owner holds this and wants it remembered. Stated plainly by the owner → high; inferred → lower.
- ttl_days for episodic entries (how long it stays relevant).
- replaces: ids of existing entries (from the list given) that this entry corrects or updates.
Do not repeat existing entries. Never include secrets. Statements by other people are not facts about the owner.`

const Triage = z.object({ decision: z.enum(['keep', 'review', 'drop']), confidence: z.number().min(0).max(1) })
const Distilled = z.object({ entries: z.array(z.object({
  text: z.string().min(2).max(300), kind: z.enum(MEMORY_KINDS), confidence: z.number().min(0).max(1),
  ttl_days: z.number().int().min(1).max(365).optional(), replaces: z.array(z.string()).max(5).optional(),
})).max(3) })

export class Distiller {
  constructor(private store: Store, private hub: ModelHub, private memory: Memory, private scopeOf: (conversationId: string) => string | undefined) {}

  private role(preferred: 'filter' | 'summarizer') { return this.hub.resolve(preferred) ? preferred : 'router' }

  /** Distils the messages a conversation received since the last run. Returns what was added. */
  async distill(conversationId: string): Promise<{ triage: string; added: { id: string; status: string }[] }> {
    const cursorKey = `memory:cursor:${conversationId}`
    const since = kvGet<number>(this.store, cursorKey) ?? 0
    const rows = this.store.db.select().from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), gt(schema.messages.createdAt, since))).orderBy(asc(schema.messages.createdAt)).all()
      .filter(m => m.role === 'user' || m.role === 'assistant')
    if (!rows.length) return { triage: 'empty', added: [] }
    const last = rows.at(-1)!.createdAt
    const owner = (m: typeof rows[number]) => m.role === 'user' && ((m.meta as { source?: string }).source ?? 'webchat') === 'webchat'
    if (!rows.some(owner)) { kvSet(this.store, cursorKey, last); return { triage: 'no-owner-words', added: [] } }
    const transcript = rows.map(m => `[${m.id}] ${owner(m) ? 'owner' : m.role === 'assistant' ? 'assistant' : `${(m.meta as { actor?: string }).actor ?? 'someone'} (not the owner)`}: ${m.content.replace(/\s+/g, ' ').slice(0, 800)}`).join('\n').slice(-8_000)

    const { output: triage } = await generateText({ model: this.hub.model(this.role('filter'), { ref: conversationId }), system: TRIAGE_PROMPT, prompt: transcript,
      maxRetries: 1, output: Output.object({ schema: Triage }) })
    if (triage.decision === 'drop' || triage.confidence < 0.3) { kvSet(this.store, cursorKey, last); return { triage: triage.decision, added: [] } }

    const scope = this.scopeOf(conversationId)
    const existing = await this.memory.recall(transcript, { scope, k: 12 })
    const { output } = await generateText({ model: this.hub.model(this.role('summarizer'), { ref: conversationId }), system: DISTILL_PROMPT, maxRetries: 1,
      prompt: `Existing entries:\n${existing.map(m => `- [${m.id} ${m.kind}] ${m.text}`).join('\n') || '（无）'}\n\nConversation${scope ? ` (project ${this.memory.scopeName(scope)})` : ''}:\n${transcript}`,
      output: Output.object({ schema: Distilled }) })
    // What the owner said is theirs; anything an outsider said in the thread can only ask to be remembered.
    const trust: MemoryTrust = rows.every(m => m.role === 'assistant' || owner(m)) ? 'user' : 'external'
    const known = new Set(existing.map(m => m.id))
    const added: { id: string; status: string }[] = []
    for (const e of output.entries) {
      const kind = e.kind === 'project' && !scope ? 'profile' : e.kind
      // A "review" triage caps confidence below the write threshold: the owner confirms.
      const confidence = triage.decision === 'review' ? Math.min(e.confidence, 0.79) : e.confidence
      try {
        const r = this.memory.add({ kind, text: e.text, scope, trust, confidence, sources: rows.filter(owner).map(m => m.id).slice(-5), createdBy: 'distiller',
          ttlDays: e.ttl_days, supersedes: (e.replaces ?? []).filter(id => known.has(id)) })
        if (r.status !== 'dropped') added.push({ id: r.id, status: r.status })
      } catch { /* a secret or empty text: skip */ }
    }
    kvSet(this.store, cursorKey, last)
    return { triage: triage.decision, added }
  }
}
