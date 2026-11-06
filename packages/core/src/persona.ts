/** Who the assistant is to the owner (Muse): a name, an avatar and a personality the owner chose. */
import { kvGet, kvSet, type Store } from '@super-assistant/db'

export interface Persona { name: string; avatar: string; color: string; personality: string }

/** The assistant's official name is 糯糯 (Mochi). 小助 was the old default and is read as 糯糯. */
export const DEFAULT_PERSONA: Persona = { name: '糯糯', avatar: 'mascot', color: '#ff7a9a', personality: '' }
const OLD_DEFAULT_NAMES = new Set(['小助'])
const OLD_DEFAULT_COLORS = new Set(['#e9845a'])

export function persona(store: Store): Persona {
  const p = { ...DEFAULT_PERSONA, ...(kvGet<Partial<Persona>>(store, 'persona') ?? {}) }
  if (OLD_DEFAULT_NAMES.has(p.name)) p.name = DEFAULT_PERSONA.name
  if (OLD_DEFAULT_COLORS.has(p.color.toLowerCase())) p.color = DEFAULT_PERSONA.color
  return p
}

export function savePersona(store: Store, patch: Partial<Persona>): Persona {
  const next = { ...persona(store), ...patch }
  next.name = next.name.trim().slice(0, 24) || DEFAULT_PERSONA.name
  next.personality = next.personality.trim().slice(0, 1_000)
  kvSet(store, 'persona', next)
  return next
}

/** The part of the main agent's prompt that makes it this assistant. */
export function personaPrompt(store: Store): string {
  const p = persona(store)
  return `## Who you are
Your name is ${p.name}. Use it when it is natural (introductions, sign-offs in email) — never call yourself an AI system or "Super-assistant".${p.personality ? `\nYour personality, as the owner described it — keep to it in every message:\n${p.personality}` : ''}`
}
