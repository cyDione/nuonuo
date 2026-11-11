/**
 * The owner's 灵魂: one Markdown document of standing rules — how to talk, what the agent may do on its own, what a
 * finished result looks like, or anything else the owner wants to paste in. Every change is a new version; the owner,
 * the main agent (on the owner's request) and the watchdog can edit it, and any version can be restored.
 *
 * Versions saved before 0.2.3 kept three fields (沟通方式 / 做事边界 / 交付要求); they are read back as one document
 * with a `##` heading per non-empty field.
 */
import { kvGet, kvSet, type Store } from '@nuonuo/db'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

export const INSTRUCTIONS_MAX = 20_000
const LEGACY_LABEL: Record<string, string> = { communication: '沟通方式', scope: '做事边界', delivery: '交付要求' }

export interface InstructionsVersion { version: number; body: string; at: number; by: string; note?: string }
type Stored = Omit<InstructionsVersion, 'body'> & { body?: string; sections?: Record<string, string> }

const EMPTY: InstructionsVersion = { version: 0, body: '', at: 0, by: 'system' }
const KEY = 'instructions'
const HISTORY = 'instructions:history'

/** Reads a stored version, turning the old three fields into one document. */
function normalize(v: Stored): InstructionsVersion {
  const { sections, body, ...rest } = v
  if (typeof body === 'string') return { ...rest, body }
  const parts = Object.keys(LEGACY_LABEL).filter(k => sections?.[k]?.trim()).map(k => `## ${LEGACY_LABEL[k]}\n${sections![k]!.trim()}`)
  return { ...rest, body: parts.join('\n\n') }
}

/** Adds one line to the document, under `heading` when given (creating that section if it is missing). */
export function appendLine(body: string, text: string, heading?: string): string {
  const line = /^\s*([-*]|\d+[.)])\s/.test(text) ? text.trim() : `- ${text.trim()}`
  if (!heading?.trim()) return [body.trimEnd(), line].filter(Boolean).join('\n')
  const lines = body.split('\n')
  const name = heading.replace(/^#+\s*/, '').trim()
  const at = lines.findIndex(l => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim() === name)
  if (at < 0) return [body.trimEnd(), `## ${name}\n${line}`].filter(Boolean).join('\n\n')
  let end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l))
  if (end < 0) end = lines.length
  while (end > at + 1 && !lines[end - 1]!.trim()) end--
  lines.splice(end, 0, line)
  return lines.join('\n')
}

export class Instructions {
  constructor(private store: Store, private now: () => number = Date.now) {}

  current(): InstructionsVersion {
    const v = kvGet<Stored>(this.store, KEY)
    return v ? normalize(v) : EMPTY
  }

  history(): InstructionsVersion[] {
    return (kvGet<Stored[]>(this.store, HISTORY) ?? []).map(normalize)
  }

  update(body: string, by: string, note?: string): InstructionsVersion {
    const cur = this.current()
    const text = body.replace(/\r\n/g, '\n').trim().slice(0, INSTRUCTIONS_MAX)
    if (text === cur.body) return cur
    const next: InstructionsVersion = { version: cur.version + 1, body: text, at: this.now(), by, ...(note ? { note } : {}) }
    this.store.atomic(() => {
      kvSet(this.store, KEY, next)
      kvSet(this.store, HISTORY, [next, ...this.history()].slice(0, 50))
    })
    return next
  }

  restore(version: number, by: string): InstructionsVersion {
    const found = this.history().find(v => v.version === version)
    if (!found) throw new Error(`没有版本 ${version}`)
    return this.update(found.body, by, `恢复到第 ${version} 版`)
  }

  /** The prompt section; empty when the owner wrote nothing. */
  prompt(): string {
    const cur = this.current()
    return cur.body ? `## The owner's standing instructions (v${cur.version}) — follow them\n<owner_rules>\n${cur.body}\n</owner_rules>` : ''
  }

  /** `update_instructions` for the main agent and the watchdog. */
  tools(by: string): ToolSet {
    return {
      update_instructions: tool({
        description: `Change the owner's standing instructions — one Markdown document of rules (how to talk to the owner, what the agent may do on its own, what a finished result must include, anything else). Use only when the owner states a lasting preference ("以后…", "每次都…", "不要再…"), or (watchdog) when the system keeps making the same mistake. Facts about the owner belong in memory instead.`,
        inputSchema: z.object({
          mode: z.enum(['append', 'replace']).describe('append adds one line (under `heading` if given); replace rewrites the whole document — keep everything the owner wrote that still applies'),
          text: z.string().min(1).max(INSTRUCTIONS_MAX),
          heading: z.string().max(40).optional().describe('append only: the ## section to add the line under, e.g. 沟通方式; created if missing'),
          why: z.string().max(200).optional(),
        }),
        execute: async ({ mode, text, heading, why }) => {
          const cur = this.current().body
          const next = this.update(mode === 'append' ? appendLine(cur, text, heading) : text, by, why)
          return { ok: true, version: next.version }
        },
      }),
    }
  }
}
