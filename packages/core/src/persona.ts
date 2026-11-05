/** Who the assistant is to the owner (Muse): a name, an avatar and a personality the owner chose. */
import { kvGet, kvSet, type Store } from '@super-assistant/db'

export interface Persona { name: string; avatar: string; color: string; personality: string }

export const DEFAULT_PERSONA: Persona = { name: '小助', avatar: 'mascot', color: '#e9845a', personality: '' }

export function persona(store: Store): Persona {
  return { ...DEFAULT_PERSONA, ...(kvGet<Partial<Persona>>(store, 'persona') ?? {}) }
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
