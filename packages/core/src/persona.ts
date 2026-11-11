/** Who the assistant is to the owner (Muse): a name, an avatar and a personality the owner chose. */
import { kvGet, kvSet, type Store } from '@nuonuo/db'

export const PERSONA_ROLES = ['all', 'life', 'work', 'study'] as const
export const PERSONA_LANGUAGES = ['zh', 'en', 'auto'] as const
export interface Persona {
  name: string; avatar: string; color: string; personality: string
  /** What it mainly helps with in the owner's life (设置 → 助理 → 角色). */
  role: (typeof PERSONA_ROLES)[number]
  /** The language it speaks to the owner in (设置 → 通用 → 它跟你说话用). */
  language: (typeof PERSONA_LANGUAGES)[number]
}

/** The assistant's official name is 糯糯 (Mochi). 小助 was the old default and is read as 糯糯. */
export const DEFAULT_PERSONA: Persona = { name: '糯糯', avatar: 'mascot', color: '#ff7a9a', personality: '', role: 'all', language: 'auto' }
const OLD_DEFAULT_NAMES = new Set(['小助'])
const OLD_DEFAULT_COLORS = new Set(['#e9845a'])

export function persona(store: Store): Persona {
  const p = { ...DEFAULT_PERSONA, ...(kvGet<Partial<Persona>>(store, 'persona') ?? {}) }
  if (OLD_DEFAULT_NAMES.has(p.name)) p.name = DEFAULT_PERSONA.name
  if (OLD_DEFAULT_COLORS.has(p.color.toLowerCase())) p.color = DEFAULT_PERSONA.color
  if (!PERSONA_ROLES.includes(p.role)) p.role = DEFAULT_PERSONA.role
  if (!PERSONA_LANGUAGES.includes(p.language)) p.language = DEFAULT_PERSONA.language
  return p
}

export function savePersona(store: Store, patch: Partial<Persona>): Persona {
  const next = { ...persona(store), ...patch }
  next.name = next.name.trim().slice(0, 24) || DEFAULT_PERSONA.name
  next.personality = next.personality.trim().slice(0, 1_000)
  kvSet(store, 'persona', next)
  return next
}

const ROLE_LINE: Record<Persona['role'], string> = {
  all: '',
  life: '\nYou are mainly the owner\'s life assistant: plans, trips, shopping, family, health and everyday errands come first.',
  work: '\nYou are mainly the owner\'s work assistant: their projects, code, email and meetings come first.',
  study: '\nYou are mainly the owner\'s study partner: what they are learning, reading and practising comes first.',
}
const LANGUAGE_LINE: Record<Persona['language'], string> = {
  zh: '\nAlways speak to the owner in 简体中文, whatever language they write in.',
  en: '\nAlways speak to the owner in English, whatever language they write in.',
  auto: '',
}

/** The part of the main agent's prompt that makes it this assistant. */
export function personaPrompt(store: Store): string {
  const p = persona(store)
  return `## Who you are
Your name is ${p.name}. Use it when it is natural (introductions, sign-offs in email) — never call yourself an AI system or "Nuonuo".${ROLE_LINE[p.role]}${LANGUAGE_LINE[p.language]}${p.personality ? `\nYour personality, as the owner described it — keep to it in every message:\n${p.personality}` : ''}`
}
