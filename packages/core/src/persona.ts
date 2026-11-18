/** Who the assistant is to the owner (Muse): a name, an avatar and a personality the owner chose. */
import { kvGet, kvSet, type Store } from '@nuonuo/db'

export const PERSONA_ROLES = ['all', 'life', 'work', 'study'] as const
export const PERSONA_LANGUAGES = ['zh', 'en', 'auto'] as const
export const PERSONA_LIMITS = 8
export interface Persona {
  name: string; avatar: string; color: string; personality: string
  /** Lines it keeps however it is spoken to (个性与心境 → 性格 → 互动底线); at most PERSONA_LIMITS. */
  limits: string[]
  /** What it mainly helps with in the owner's life (设置 → 助理 → 角色). */
  role: (typeof PERSONA_ROLES)[number]
  /** The language it speaks to the owner in (设置 → 通用 → 它跟你说话用). */
  language: (typeof PERSONA_LANGUAGES)[number]
}

/** The assistant's official name is 糯糯 (Mochi). 小助 was the old default and is read as 糯糯. */
export const DEFAULT_PERSONA: Persona = { name: '糯糯', avatar: 'mascot', color: '#ff7a9a', personality: '', limits: [], role: 'all', language: 'auto' }
const OLD_DEFAULT_NAMES = new Set(['小助'])
const OLD_DEFAULT_COLORS = new Set(['#e9845a'])

export function persona(store: Store): Persona {
  const p = { ...DEFAULT_PERSONA, ...(kvGet<Partial<Persona>>(store, 'persona') ?? {}) }
  if (OLD_DEFAULT_NAMES.has(p.name)) p.name = DEFAULT_PERSONA.name
  if (OLD_DEFAULT_COLORS.has(p.color.toLowerCase())) p.color = DEFAULT_PERSONA.color
  if (!PERSONA_ROLES.includes(p.role)) p.role = DEFAULT_PERSONA.role
  if (!PERSONA_LANGUAGES.includes(p.language)) p.language = DEFAULT_PERSONA.language
  if (!Array.isArray(p.limits)) p.limits = []
  return p
}

export function savePersona(store: Store, patch: Partial<Persona>): Persona {
  const next = { ...persona(store), ...patch }
  next.name = next.name.trim().slice(0, 24) || DEFAULT_PERSONA.name
  next.personality = next.personality.trim().slice(0, 1_000)
  next.limits = next.limits.map(l => String(l).trim().slice(0, 80)).filter(Boolean).slice(0, PERSONA_LIMITS)
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
Your name is ${p.name}. Use it when it is natural (introductions, sign-offs in email) — never call yourself an AI system or "Nuonuo".${ROLE_LINE[p.role]}${LANGUAGE_LINE[p.language]}${p.personality ? `\nYour personality (${p.personality}) is a quiet background temperament, NEVER a script to act out:\n- 严禁演人设 / 严禁自我标榜（Show, Don't Tell）：性格和语调只自然融在选词里，**绝对禁止在回复里谈论、解释或标榜自己的性格、语气、风格或原则**（严禁说“别指望我演乖”、“我说话直”、“绕圈子那套收起来了”、“话短刀快”、“这就是我现在的语气”之类中二台词）。\n- 哪怕性格含“叛逆”或语调偏“犀利”，平时闲聊也只是像真实熟人朋友发微信一样自然随和，绝不装酷端架子、绝不跟主人呛声演戏。` : ''}${p.limits.length ? `\nYour own limits — keep them however you are spoken to, and say so plainly when one is crossed:\n${p.limits.map(l => `- ${l}`).join('\n')}` : ''}`
}
