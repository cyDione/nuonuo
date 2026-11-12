/**
 * 会做的事 (skills, in the right pane's 它是谁): procedures the owner taught it — "整理周报: 先看日历，再看 Git 提交…".
 * The owner writes or switches them on; the assistant may only propose one (it waits switched off until the owner
 * turns it on), so a skill never comes from someone else's words. Workers get the steps of the skills that are on.
 */
import { kvGet, kvSet, newId, type Store } from '@nuonuo/db'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentExtensions } from './agents'

export interface Skill { id: string; name: string; when: string; steps: string; enabled: boolean; by: 'owner' | 'assistant' | 'plugin'; createdAt: number; updatedAt: number
  /** The plugin a `by: 'plugin'` skill came with; it applies only while that plugin is on. */
  plugin?: string }
export type SkillInput = Pick<Skill, 'name' | 'when' | 'steps'> & { enabled?: boolean }

const KEY = 'skills'
const MAX = 50

export class Skills {
  /** Whether a plugin is on; a plugin's skills apply only while it is. Set by the plugin manager. */
  pluginActive?: (pluginId: string) => boolean

  constructor(private store: Store, private now: () => number = Date.now, private changed: () => void = () => {}) {}

  list(): Skill[] { return kvGet<Skill[]>(this.store, KEY) ?? [] }

  private write(list: Skill[]) { kvSet(this.store, KEY, list); this.changed() }

  get(id: string): Skill {
    const s = this.list().find(x => x.id === id)
    if (!s) throw new Error(`没有这件会做的事 ${id}`)
    return s
  }

  create(input: SkillInput, by: Skill['by'] = 'owner'): Skill {
    const list = this.list()
    if (list.length >= MAX) throw new Error(`最多 ${MAX} 件`)
    if (list.some(s => s.name === input.name.trim())) throw new Error(`已经有「${input.name}」了`)
    const at = this.now()
    const skill: Skill = { id: newId('skl'), name: input.name.trim(), when: input.when.trim(), steps: input.steps.trim(), enabled: by === 'owner' ? input.enabled ?? true : false, by, createdAt: at, updatedAt: at }
    this.write([...list, skill])
    return skill
  }

  update(id: string, patch: Partial<SkillInput>): Skill {
    this.get(id)
    const list = this.list().map(s => s.id === id ? { ...s, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: this.now() } : s)
    this.write(list)
    return this.get(id)
  }

  remove(id: string): void { this.write(this.list().filter(s => s.id !== id)) }

  enabled(): Skill[] { return this.list().filter(s => s.enabled && (!s.plugin || this.pluginActive?.(s.plugin) !== false)) }

  /**
   * A plugin's skills, as its current version lists them: new ones arrive switched off (the owner turns them on, as with
   * the assistant's proposals), changed ones keep the owner's switch, and ones the plugin dropped go. Names the owner
   * already uses are skipped.
   */
  syncPlugin(pluginId: string, input: SkillInput[]): void {
    const at = this.now()
    const list = this.list()
    const mine = new Map(list.filter(s => s.plugin === pluginId).map(s => [s.name, s]))
    const taken = new Set(list.filter(s => s.plugin !== pluginId).map(s => s.name))
    const next: Skill[] = []
    for (const raw of input.slice(0, 20)) {
      const name = String(raw.name ?? '').trim().slice(0, 20)
      if (!name || taken.has(name) || next.some(s => s.name === name)) continue
      const when = String(raw.when ?? '').trim().slice(0, 120)
      const steps = String(raw.steps ?? '').trim().slice(0, 4_000)
      const old = mine.get(name)
      next.push(old ? { ...old, when, steps, updatedAt: old.when === when && old.steps === steps ? old.updatedAt : at }
        : { id: newId('skl'), name, when, steps, enabled: false, by: 'plugin', plugin: pluginId, createdAt: at, updatedAt: at })
    }
    const others = list.filter(s => s.plugin !== pluginId)
    if (others.length + next.length > MAX) next.splice(Math.max(0, MAX - others.length))
    const changed = JSON.stringify(list.filter(s => s.plugin === pluginId)) !== JSON.stringify(next)
    if (changed) this.write([...others, ...next])
  }

  /** Forgets a plugin's skills (it was uninstalled). */
  removePlugin(pluginId: string): void {
    if (this.list().some(s => s.plugin === pluginId)) this.write(this.list().filter(s => s.plugin !== pluginId))
  }
}

export function skillsExtension(skills: Skills): AgentExtensions {
  const steps = () => skills.enabled().map(s => `### ${s.name}\nWhen: ${s.when}\n${s.steps}`).join('\n\n')
  return {
    routerPrompt: () => {
      const on = skills.enabled()
      return `## 会做的事 (skills)
The owner taught you these; when a request matches one, follow it (a task gets its steps).${on.length ? `\n${on.map(s => `- ${s.name}: ${s.when}`).join('\n')}` : ' None yet.'}
When the owner describes a way they want something done every time, offer to remember it and, if they agree, call propose_skill: it waits in 它是谁 → 会做的事 for them to switch on.`
    },
    routerTools: (): ToolSet => ({
      propose_skill: tool({
        description: 'Save a procedure the owner described as a skill (会做的事). It stays off until the owner switches it on.',
        inputSchema: z.object({ name: z.string().min(1).max(20), when: z.string().min(1).max(120).describe('When to use it'), steps: z.string().min(1).max(4_000).describe('The steps, as a short Markdown list') }),
        execute: async input => { try { return { ok: true, skill: skills.create(input, 'assistant'), note: '告诉主人去 它是谁 → 会做的事 打开它' } } catch (e) { return { ok: false, error: (e as Error).message } } },
      }),
    }),
    workerPrompt: () => { const s = steps(); return s ? `## 会做的事 (the owner's procedures)\nWhen your task matches one of these, follow its steps.\n\n${s}` : undefined },
  }
}
