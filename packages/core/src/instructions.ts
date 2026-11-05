/**
 * The owner's standing instructions (dsh-superagent 004's editable team prompt sections): how to talk, what the agent may
 * do on its own, what a finished result looks like. Every change is a new version; the owner, the main agent (on the
 * owner's request) and the watchdog can edit them, and any version can be restored.
 */
import { kvGet, kvSet, type Store } from '@super-assistant/db'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

export const SECTIONS = ['communication', 'scope', 'delivery'] as const
export type Section = (typeof SECTIONS)[number]
export const SECTION_LABEL: Record<Section, string> = { communication: '沟通方式', scope: '做事边界', delivery: '交付要求' }

export interface InstructionsVersion { version: number; sections: Record<Section, string>; at: number; by: string; note?: string }

const EMPTY: InstructionsVersion = { version: 0, sections: { communication: '', scope: '', delivery: '' }, at: 0, by: 'system' }
const KEY = 'instructions'
const HISTORY = 'instructions:history'

export class Instructions {
  constructor(private store: Store, private now: () => number = Date.now) {}

  current(): InstructionsVersion {
    return kvGet<InstructionsVersion>(this.store, KEY) ?? EMPTY
  }

  history(): InstructionsVersion[] {
    return kvGet<InstructionsVersion[]>(this.store, HISTORY) ?? []
  }

  update(patch: Partial<Record<Section, string>>, by: string, note?: string): InstructionsVersion {
    const cur = this.current()
    const sections = { ...cur.sections }
    for (const s of SECTIONS) if (patch[s] !== undefined) sections[s] = patch[s]!.trim().slice(0, 4_000)
    if (SECTIONS.every(s => sections[s] === cur.sections[s])) return cur
    const next: InstructionsVersion = { version: cur.version + 1, sections, at: this.now(), by, ...(note ? { note } : {}) }
    this.store.atomic(() => {
      kvSet(this.store, KEY, next)
      kvSet(this.store, HISTORY, [next, ...this.history()].slice(0, 50))
    })
    return next
  }

  restore(version: number, by: string): InstructionsVersion {
    const found = this.history().find(v => v.version === version)
    if (!found) throw new Error(`没有版本 ${version}`)
    return this.update(found.sections, by, `恢复到第 ${version} 版`)
  }

  /** The prompt section; empty when the owner wrote nothing. */
  prompt(): string {
    const cur = this.current()
    const parts = SECTIONS.filter(s => cur.sections[s]).map(s => `### ${SECTION_LABEL[s]}\n${cur.sections[s]}`)
    return parts.length ? `## The owner's standing instructions (v${cur.version}) — follow them\n${parts.join('\n\n')}` : ''
  }

  /** `update_instructions` for the main agent and the watchdog. */
  tools(by: string): ToolSet {
    return {
      update_instructions: tool({
        description: `Change the owner's standing instructions — sections: communication (how to talk to the owner), scope (what the agent may do on its own), delivery (what a finished result must include). Use only when the owner states a lasting preference ("以后…", "每次都…", "不要再…"), or (watchdog) when the system keeps making the same mistake. Facts about the owner belong in memory instead.`,
        inputSchema: z.object({
          section: z.enum(SECTIONS),
          mode: z.enum(['append', 'replace']).describe('append adds one line; replace rewrites the whole section'),
          text: z.string().min(1).max(2_000),
          why: z.string().max(200).optional(),
        }),
        execute: async ({ section, mode, text, why }) => {
          const cur = this.current().sections[section]
          const value = mode === 'append' ? [cur, text.startsWith('-') ? text : `- ${text}`].filter(Boolean).join('\n') : text
          const next = this.update({ [section]: value }, by, why)
          return { ok: true, version: next.version }
        },
      }),
    }
  }
}
