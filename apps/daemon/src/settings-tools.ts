/**
 * Self-configuration tools for the Router (`get_my_settings` & `update_my_settings`):
 * Lets the assistant inspect and update its own persona, 2D mood/tone pad, per-layer models & thinking effort,
 * client appearance/voice preferences (with real-time SSE push), notifications & quiet hours, ideas cadence,
 * proactive budget, and skills — while strictly enforcing the owner-only trust gate and security read-only boundary.
 */
import type { Bus, McpManager } from '@nuonuo/agent-runtime'
import {
  clip,
  isOwnerDirectTurn,
  persona,
  PERSONA_LANGUAGES,
  PERSONA_ROLES,
  proactiveSettings,
  savePersona,
  saveProactiveSettings,
  type AgentExtensions,
  type Engine,
  type Ideas,
  type Instructions,
  type LocalAccess,
  type Persona,
  type Reviewer,
  type Skills,
} from '@nuonuo/core'
import { kvGet, kvSet, type Store } from '@nuonuo/db'
import {
  DECISION_KINDS,
  defaultReasoningOf,
  presetOf,
  ROLE_IDS,
  type ModelHub,
  type ProviderKind,
  type ReasoningLevel,
  type RoleConfig,
  type RoleId,
} from '@nuonuo/models'
import {
  MOOD_PLUGIN_ID,
  moodView,
  resetMood,
  setMindConfig,
  setMoodEnabled,
  setMoodTone,
  setMoodValues,
  type ToneId,
} from '@nuonuo/plugins'
import type { PluginManager, SourceRegistry } from '@nuonuo/sources'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { notifySettings, saveNotifySettings, type NotifySettings } from './notices'

export const CLIENT_PREFS_KEY = 'settings:client_prefs'
export const TONE_PRESET_DEFAULT_STRENGTH = 0.78

export const CONFIGURABLE_ROLES = [
  'router',
  'voice',
  'worker',
  'subagent',
  'filter',
  'watchdog',
  'summarizer',
  'embedding',
  'vision',
  'transcribe',
  'speech',
] as const
export type ConfigurableRoleId = (typeof CONFIGURABLE_ROLES)[number]

export const CLIENT_THEMES = ['light', 'dark', 'system'] as const
export const CLIENT_ACCENTS = ['berry', 'ink', 'mint', 'sea', 'grape', 'slate'] as const
export const CLIENT_UI_LANGUAGES = ['zh', 'en', 'system'] as const
export const CLIENT_TEXT_SIZES = ['small', 'normal', 'large'] as const
export const CLIENT_VOICE_LANGS = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'ja-JP'] as const
export const CLIENT_VOICE_RATES = ['slow', 'normal', 'fast'] as const
export const CLIENT_CLOSE_ACTIONS = ['hide', 'quit'] as const

export interface ClientPrefs {
  theme: (typeof CLIENT_THEMES)[number]
  accent: (typeof CLIENT_ACCENTS)[number]
  uiLanguage: (typeof CLIENT_UI_LANGUAGES)[number]
  text: (typeof CLIENT_TEXT_SIZES)[number]
  reduceMotion: boolean
  voiceInput: boolean
  voiceLang: string
  autoSend: boolean
  readAloud: boolean
  voiceRate: (typeof CLIENT_VOICE_RATES)[number]
  showRaw: boolean
  openAtLogin?: boolean | undefined
  tray?: boolean | undefined
  close?: (typeof CLIENT_CLOSE_ACTIONS)[number] | undefined
}

export const DEFAULT_CLIENT_PREFS: ClientPrefs = {
  theme: 'system',
  accent: 'berry',
  uiLanguage: 'system',
  text: 'normal',
  reduceMotion: false,
  voiceInput: true,
  voiceLang: 'zh-CN',
  autoSend: false,
  readAloud: false,
  voiceRate: 'normal',
  showRaw: false,
}

export function clientPrefs(store: Store): ClientPrefs {
  const saved = kvGet<Partial<ClientPrefs>>(store, CLIENT_PREFS_KEY) ?? {}
  return { ...DEFAULT_CLIENT_PREFS, ...saved }
}

export function saveClientPrefs(
  store: Store,
  input: Record<string, unknown>,
): { next: ClientPrefs; patch: Record<string, unknown> } {
  const cur = clientPrefs(store)
  const normalized: Partial<ClientPrefs> = {}
  const patch: Record<string, unknown> = {}

  const theme = input.theme
  if (typeof theme === 'string' && (CLIENT_THEMES as readonly string[]).includes(theme)) {
    normalized.theme = theme as ClientPrefs['theme']
    patch.theme = theme
  }
  const accent = input.accent
  if (typeof accent === 'string' && (CLIENT_ACCENTS as readonly string[]).includes(accent)) {
    normalized.accent = accent as ClientPrefs['accent']
    patch.accent = accent
  }
  const uiLang = input.ui_language ?? input.uiLanguage
  if (typeof uiLang === 'string' && (CLIENT_UI_LANGUAGES as readonly string[]).includes(uiLang)) {
    normalized.uiLanguage = uiLang as ClientPrefs['uiLanguage']
    patch.uiLanguage = uiLang
    patch.ui_language = uiLang
  }
  const textSize = input.text_size ?? input.text
  if (typeof textSize === 'string' && (CLIENT_TEXT_SIZES as readonly string[]).includes(textSize)) {
    normalized.text = textSize as ClientPrefs['text']
    patch.text = textSize
    patch.text_size = textSize
  }
  const reduceMotion = input.reduce_motion ?? input.reduceMotion
  if (typeof reduceMotion === 'boolean') {
    normalized.reduceMotion = reduceMotion
    patch.reduceMotion = reduceMotion
    patch.reduce_motion = reduceMotion
  }
  const voiceInput = input.voice_input ?? input.voiceInput
  if (typeof voiceInput === 'boolean') {
    normalized.voiceInput = voiceInput
    patch.voiceInput = voiceInput
    patch.voice_input = voiceInput
  }
  const voiceLang = input.voice_lang ?? input.voiceLang
  if (typeof voiceLang === 'string' && voiceLang.trim()) {
    normalized.voiceLang = voiceLang.trim()
    patch.voiceLang = voiceLang.trim()
    patch.voice_lang = voiceLang.trim()
  }
  const autoSend = input.auto_send ?? input.autoSend
  if (typeof autoSend === 'boolean') {
    normalized.autoSend = autoSend
    patch.autoSend = autoSend
    patch.auto_send = autoSend
  }
  const readAloud = input.read_aloud ?? input.readAloud
  if (typeof readAloud === 'boolean') {
    normalized.readAloud = readAloud
    patch.readAloud = readAloud
    patch.read_aloud = readAloud
  }
  const voiceRate = input.voice_rate ?? input.voiceRate
  if (typeof voiceRate === 'string' && (CLIENT_VOICE_RATES as readonly string[]).includes(voiceRate)) {
    normalized.voiceRate = voiceRate as ClientPrefs['voiceRate']
    patch.voiceRate = voiceRate
    patch.voice_rate = voiceRate
  }
  const showRaw = input.show_raw ?? input.showRaw
  if (typeof showRaw === 'boolean') {
    normalized.showRaw = showRaw
    patch.showRaw = showRaw
    patch.show_raw = showRaw
  }
  const openAtLogin = input.open_at_login ?? input.openAtLogin
  if (typeof openAtLogin === 'boolean') {
    normalized.openAtLogin = openAtLogin
    patch.openAtLogin = openAtLogin
    patch.open_at_login = openAtLogin
  }
  if (typeof input.tray === 'boolean') {
    normalized.tray = input.tray
    patch.tray = input.tray
  }
  const closeAction = input.close_action ?? input.close
  if (typeof closeAction === 'string' && (CLIENT_CLOSE_ACTIONS as readonly string[]).includes(closeAction)) {
    normalized.close = closeAction as ClientPrefs['close']
    patch.close = closeAction
    patch.close_action = closeAction
  }

  const next: ClientPrefs = { ...cur, ...normalized }
  kvSet(store, CLIENT_PREFS_KEY, next)
  return { next, patch }
}

/** Maps a named 2D tone preset + strength (default 0.78) to `{ x, y }` coordinates in `[-1, 1]`. */
export function presetToToneXY(preset: ToneId, strength = TONE_PRESET_DEFAULT_STRENGTH): { x: number; y: number } {
  const s = Math.round(Math.min(1, Math.max(0.1, Number(strength) || TONE_PRESET_DEFAULT_STRENGTH)) * 100) / 100
  switch (preset) {
    case 'natural':
      return { x: 0, y: 0 }
    case 'warm':
      return { x: -s, y: s }
    case 'witty':
      return { x: s, y: s }
    case 'calm':
      return { x: -s, y: -s }
    case 'sharp':
      return { x: s, y: -s }
  }
}

function inferProviderKindFromModel(modelId: string): ProviderKind | undefined {
  const m = modelId.toLowerCase()
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('gpt-') || /^o[134](?:\b|-)/.test(m) || m.startsWith('text-embedding-')) return 'openai'
  if (m.startsWith('gemini')) return 'google'
  if (m.startsWith('deepseek')) return 'deepseek'
  return undefined
}

function resolveProviderIdForModel(hub: ModelHub, role: RoleId, modelId: string, explicitProviderId?: string): string | undefined {
  const providers = hub.listProviders().filter(p => !DECISION_KINDS.includes(p.kind))
  if (!providers.length) return undefined

  if (explicitProviderId?.trim()) {
    const q = explicitProviderId.trim()
    const exact = providers.find(p => p.id === q)
    if (exact) return exact.id
    const byNameOrKind = providers.find(p => p.name.toLowerCase() === q.toLowerCase() || p.kind.toLowerCase() === q.toLowerCase())
    if (byNameOrKind) return byNameOrKind.id
    return q
  }

  const target = modelId.trim().toLowerCase()
  for (const p of providers) {
    const cached = hub.cachedModels(p.id)?.models.map(m => m.id) ?? []
    const suggested = presetOf(p.kind, p.baseUrl)?.suggestedModels ?? []
    if ([...cached, ...suggested].some(id => id.toLowerCase() === target)) {
      return p.id
    }
  }

  const hintedKind = inferProviderKindFromModel(modelId)
  if (hintedKind) {
    const matched = providers.find(p => p.kind === hintedKind && p.hasKey) ?? providers.find(p => p.kind === hintedKind)
    if (matched) return matched.id
  }

  const ownProvider = hub.roleConfigs()[role]?.chain[0]?.providerId
  if (ownProvider && providers.some(p => p.id === ownProvider)) return ownProvider

  const routerProvider = hub.resolve('router')?.config.chain[0]?.providerId
  if (routerProvider && providers.some(p => p.id === routerProvider)) return routerProvider

  return (providers.find(p => p.hasKey) ?? providers[0])?.id
}

export interface SettingsToolsDeps {
  store: Store
  hub: ModelHub | (() => ModelHub)
  bus: Bus
  engine: Engine
  access: LocalAccess
  reviewer: Reviewer
  skills: Skills
  instructions: Instructions
  ideas: Ideas
  plugins: PluginManager
  sources: SourceRegistry
  mcp: McpManager
  isOwnerDirectTurn?: () => boolean
}

const SettingsDomainEnum = z.enum([
  'all',
  'persona',
  'mood',
  'models',
  'preferences',
  'notifications',
  'connections',
  'security',
])

const ReasoningEnum = z.enum(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'provider-default'])
const TimeStringSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const ModelUpdateItemSchema = z.object({
  role: z.enum(CONFIGURABLE_ROLES).default('router')
    .describe('Which model layer to configure: router (主模型/主Agent), voice (声带层, for 声带温度/声带开关/声带模型), worker (执行层), subagent, filter, watchdog, summarizer, embedding, vision, transcribe, speech (note: reviewer layer is locked for security)'),
  provider_id: z.string().optional()
    .describe('Provider id (if omitted when setting `model`, auto-resolved from configured providers)'),
  model: z.string().optional()
    .describe('Primary model id, or "" / "inherit" to clear and follow the main agent'),
  enabled: z.boolean().optional()
    .describe('For optional layers like `voice` (声带层): turn on or off'),
  reasoning: ReasoningEnum.optional()
    .describe('Thinking effort level (思考强度): auto(自动), none(不思考), low(轻度), medium(标准), high(深度), xhigh(超高), or provider-default'),
  temperature: z.number().min(0).max(2).nullable().optional()
    .describe('Sampling temperature (0..2) for this model layer; e.g. set role="voice" and temperature=0.9 when adjusting 声带温度 / voice temperature'),
  voice_temperature: z.number().min(0).max(2).nullable().optional()
    .describe('Optional shortcut to set the `voice` (声带) layer sampling temperature (0..2) in the same call'),
  voice_enabled: z.boolean().optional()
    .describe('Optional shortcut to enable/disable the `voice` (声带) layer in the same call'),
  daily_token_limit: z.number().int().min(1).nullable().optional(),
  daily_cost_limit_usd: z.number().min(0).nullable().optional(),
})

export const UpdateMySettingsSchema = z.object({
  persona: z.object({
    name: z.string().trim().min(1).max(24).optional().describe('New assistant name, e.g. "千绪"'),
    avatar: z.string().max(16).optional().describe('"mascot" (default mochi) or an emoji like "🦊", "🐱", "🐼", "🦉", "🐙", "🌱"'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    role: z.enum(PERSONA_ROLES).optional(),
    language: z.enum(PERSONA_LANGUAGES).optional().describe('Language spoken to the owner: auto, zh, or en'),
    personality: z.string().max(1_000).optional().describe('Personality base description'),
    limits: z.array(z.string().max(80)).max(8).optional(),
    limits_add: z.array(z.string().max(80)).max(8).optional(),
    limits_remove: z.array(z.string()).optional(),
    limits_replace: z.array(z.string().max(80)).max(8).optional(),
  }).optional(),

  mood: z.object({
    enabled: z.boolean().optional().describe('Enable or disable dynamic mood shifts'),
    diary: z.boolean().optional().describe('Enable or disable private mood diary'),
    tone_preset: z.enum(['natural', 'warm', 'witty', 'calm', 'sharp']).optional()
      .describe('2D tone pad preset: natural(自然), warm(温和), witty(风趣), calm(沉静), sharp(犀利)'),
    tone_strength: z.number().min(0.1).max(1).optional()
      .describe('Strength when using tone_preset (default 0.78; light ~0.4, vivid ~0.85). Note: this is NOT 声带温度 (voice temperature); for 声带温度 use models: { role: "voice", temperature: 0.9 }'),
    tone_xy: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }).optional()
      .describe('Direct 2D tone pad coordinates [-1..1]: warm(-x,+y), witty(+x,+y), calm(-x,-y), sharp(+x,-y)'),
    sensitivity_up: z.number().min(0.2).max(2.5).optional().describe('How fast praise cheers you up (0.2..2.5)'),
    sensitivity_down: z.number().min(0.2).max(2.5).optional().describe('How much dismissal/hostility affects mood (0.2..2.5)'),
    values: z.object({
      mood: z.number().min(-1).max(1).optional(),
      energy: z.number().min(0).max(1).optional(),
      patience: z.number().min(0).max(100).optional(),
      trust: z.number().min(0).max(100).optional(),
    }).optional(),
    reset: z.boolean().optional().describe('Reset mood, undertone, grudge, energy and patience back to baseline (回到平时)'),
  }).optional(),

  models: z.union([ModelUpdateItemSchema, z.array(ModelUpdateItemSchema).min(1).max(12)]).optional()
    .describe('Configure one or more model layers (pass a single object or an array of objects to update multiple layers at once, e.g. [{ role: "router", reasoning: "low" }, { role: "voice", temperature: 0.9 }])'),

  preferences: z.object({
    theme: z.enum(CLIENT_THEMES).optional().describe('Window appearance: light(浅色), dark(深色), system(跟随系统)'),
    accent: z.enum(CLIENT_ACCENTS).optional()
      .describe('Theme colour: berry(莓红), ink(墨), mint(薄荷), sea(海蓝), grape(葡萄), slate(石板)'),
    ui_language: z.enum(CLIENT_UI_LANGUAGES).optional().describe('Interface display language: zh, en, or system'),
    text_size: z.enum(CLIENT_TEXT_SIZES).optional().describe('Font size: small, normal, or large'),
    reduce_motion: z.boolean().optional().describe('Reduce UI animations'),
    voice_input: z.boolean().optional().describe('Show mic button in chat composer'),
    voice_lang: z.enum(CLIENT_VOICE_LANGS).optional(),
    auto_send: z.boolean().optional().describe('Auto-send voice input after 1.5s pause'),
    read_aloud: z.boolean().optional().describe('Read assistant replies aloud (把回复读出来)'),
    voice_rate: z.enum(CLIENT_VOICE_RATES).optional().describe('Read-aloud speed: slow, normal, or fast'),
    show_raw: z.boolean().optional().describe('Show raw tool calls in task details'),
    open_at_login: z.boolean().optional().describe('Desktop app: start at login'),
    tray: z.boolean().optional().describe('Desktop app: show icon in menu bar / system tray'),
    close_action: z.enum(CLIENT_CLOSE_ACTIONS).optional().describe('Desktop app: hide or quit when closing window'),
  }).optional(),

  notifications: z.object({
    message: z.boolean().optional(),
    price: z.boolean().optional(),
    feed: z.boolean().optional(),
    ideas: z.boolean().optional(),
    banner: z.boolean().optional(),
    sound: z.boolean().optional(),
    tone: z.enum(['nuonuo', 'system']).optional(),
    badge: z.boolean().optional(),
    quiet_on: z.boolean().optional().describe('Enable or disable quiet hours (安静时间/免打扰)'),
    quiet_from: TimeStringSchema.optional().describe('Quiet hours start HH:mm, e.g. "23:00"'),
    quiet_to: TimeStringSchema.optional().describe('Quiet hours end HH:mm, e.g. "08:00"'),
    quiet: z.object({
      on: z.boolean().optional(),
      from: TimeStringSchema.optional(),
      to: TimeStringSchema.optional(),
    }).optional(),
  }).optional(),

  ideas: z.object({
    cadence: z.enum(['daily', 'weekly', 'off']).optional(),
    hour: z.number().int().min(0).max(23).optional(),
  }).optional(),

  proactive_budget: z.object({
    concurrent: z.number().int().min(1).max(10).optional(),
    daily: z.number().int().min(1).max(200).optional(),
  }).optional(),

  skill_toggle: z.object({
    id_or_name: z.string().min(1).describe('Skill id (skl_...) or exact skill name'),
    enabled: z.boolean(),
  }).optional(),

  source_proactive: z.object({
    source_id: z.string().min(1).describe('Source id (e.g. github, telegram)'),
    proactive: z.boolean().describe('Whether to watch this source for proactive events (主动留意)'),
  }).optional(),
})

export function settingsTools(deps: SettingsToolsDeps): ToolSet {
  const { store, bus, engine, access, reviewer, skills, instructions, ideas, plugins, sources, mcp } = deps
  const getHub = (): ModelHub => (typeof deps.hub === 'function' ? deps.hub() : deps.hub)
  const moodState = () => plugins.stateOf(MOOD_PLUGIN_ID)

  const readDomain = (domain: z.infer<typeof SettingsDomainEnum>) => {
    const hub = getHub()
    const out: Record<string, unknown> = {}

    if (domain === 'all' || domain === 'persona') {
      const inst = instructions.current()
      const proactive = proactiveSettings(store)
      out.persona = {
        ...persona(store),
        instructions: {
          version: inst.version,
          summary: clip(inst.body, 500),
          length: inst.body.length,
        },
        proactive: {
          mode: proactive.mode,
          strategy: clip(proactive.strategy, 500),
          sources: proactive.sources,
          ignoreActors: proactive.ignoreActors,
          budget: proactive.budget,
          version: proactive.version,
        },
        ideas: ideas.settings(),
      }
    }

    if (domain === 'all' || domain === 'mood') {
      const view = moodView(moodState())
      out.mood = {
        enabled: view.enabled,
        mood: view.mood,
        undertone: view.undertone,
        energy: view.energy,
        patience: view.patience,
        trust: view.trust,
        summary: view.summary,
        stance: view.stance,
        tone: view.tone,
        config: view.config,
        baseline: view.baseline,
        diaryCount: view.diary.length,
      }
    }

    if (domain === 'all' || domain === 'models') {
      // Strictly redacted provider views: NEVER expose apiKey, secretRef, keyHint, or headers
      const providers = hub.listProviders().map(p => {
        const cached = hub.cachedModels(p.id)?.models.map(m => m.id) ?? []
        const suggested = presetOf(p.kind, p.baseUrl)?.suggestedModels ?? []
        const availableModels = [...new Set([...cached, ...suggested])].slice(0, 30)
        return {
          id: p.id,
          name: p.name,
          kind: p.kind,
          baseUrl: p.baseUrl,
          enabled: p.hasKey,
          hasKey: p.hasKey,
          availableModels,
        }
      })
      const configs = hub.roleConfigs()
      const resolved = Object.fromEntries(
        ROLE_IDS.map(role => {
          const r = hub.resolve(role)
          const own = configs[role]
          return [
            role,
            {
              enabled: own?.enabled ?? true,
              source: r?.source ?? null,
              model: r?.config.chain[0] ?? null,
              chain: own?.chain ?? [],
              effectiveReasoning: r ? (r.config.reasoning ?? defaultReasoningOf(role)) : defaultReasoningOf(role),
              defaultReasoning: defaultReasoningOf(role),
              temperature: r?.config.temperature ?? own?.temperature ?? null,
              dailyTokenLimit: own?.dailyTokenLimit ?? null,
              dailyCostLimitUsd: own?.dailyCostLimitUsd ?? null,
              today: hub.usageToday(role),
            },
          ]
        }),
      )
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const rows = hub.usageSince(start.getTime())
      const totalTokens = rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0)
      const totalCostUsd = Math.round(rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) * 1e6) / 1e6
      out.models = {
        providers,
        configs,
        resolved,
        usageToday: { totalTokens, totalCostUsd, byRole: rows },
      }
    }

    if (domain === 'all' || domain === 'preferences') {
      out.preferences = clientPrefs(store)
    }

    if (domain === 'all' || domain === 'notifications') {
      out.notifications = notifySettings(store)
    }

    if (domain === 'all' || domain === 'connections') {
      const proactive = proactiveSettings(store)
      out.connections = {
        sources: sources.list().map(s => ({
          id: s.id,
          title: s.title,
          enabled: s.enabled,
          authorized: s.authorized,
          health: s.health,
          proactiveWatched: proactive.sources.length === 0 || proactive.sources.includes(s.id),
        })),
        plugins: plugins.list().map(p => ({
          id: p.id,
          name: p.name,
          version: p.version,
          enabled: p.enabled,
          loaded: p.loaded,
          builtIn: p.builtIn,
          error: p.error,
        })),
        mcp: mcp.status().map(m => ({
          name: m.name,
          state: m.state,
          tools: m.tools.map(t => t.name),
          error: m.error,
        })),
        skills: skills.list().map(sk => ({
          id: sk.id,
          name: sk.name,
          when: sk.when,
          enabled: sk.enabled,
          by: sk.by,
          plugin: sk.plugin,
        })),
      }
    }

    if (domain === 'all' || domain === 'security') {
      const acc = access.settings()
      const rev = reviewer.settings()
      const exec = engine.execution()
      out.security = {
        readOnly: true,
        access: {
          folders: acc.folders,
          never: acc.never,
          locked: acc.locked,
          apps: acc.apps,
          sources: acc.sources,
        },
        review: {
          external: rev.external,
          destructive: rev.destructive,
          mode: rev.mode,
          rules: rev.rules,
          allowCount: rev.allow.length,
          denyCount: rev.deny.length,
        },
        execution: {
          maxWorkers: exec.maxWorkers,
          foregroundSeconds: exec.foregroundSeconds,
          timeoutMinutes: exec.timeoutMinutes,
          blockedCommands: exec.blockedCommands,
          workspaceRoots: exec.workspaceRoots,
          sandbox: exec.sandbox,
          environment: exec.environment,
        },
        note: 'Security boundaries (folder access, review levels, reviewer model layer, Docker sandbox, data deletion, API keys) are read-only for the assistant. Guide the owner with `reply` + `open` (e.g. route="pane/permissions", "settings/execution", "settings/providers", "settings/data").',
      }
    }

    return out
  }

  return {
    get_my_settings: tool({
      description:
        'Inspect your own current settings and live state across domains: persona (name, avatar, role, language, personality, limits, standing instructions, proactive strategy, ideas cadence), mood (enabled, 4D mood state, 2D voice tone pad x/y/preset, sensitivity, diary), models (configured providers without keys, available models, per-layer model & thinking effort, today\'s token/cost usage), preferences (theme light/dark/system, accent colour, UI language, font size, reduce motion, voice input, reply read-aloud & speed), notifications (switches, sound, quiet hours), connections (sources, plugins, MCP, skills), or security (read-only folder access, review policy, Docker sandbox).',
      inputSchema: z.object({
        domain: SettingsDomainEnum.default('all').optional()
          .describe('Domain to inspect: all, persona, mood, models, preferences, notifications, connections, or security'),
      }),
      execute: async ({ domain }) => {
        const target = domain ?? 'all'
        return { ok: true, ...readDomain(target) }
      },
    }),

    update_my_settings: tool({
      description:
        'Directly modify your own settings on the owner\'s request. Takes effect immediately in this very turn (including your name and 2D voice tone for the reply you send next) and pushes real-time SSE updates to the UI. Never use start_task to change settings — call this tool directly.',
      inputSchema: UpdateMySettingsSchema,
      execute: async input => {
        const checkOwner = deps.isOwnerDirectTurn ?? (() => isOwnerDirectTurn(engine))
        if (!checkOwner()) {
          return { ok: false, error: 'Only the owner in direct conversation can modify settings.' }
        }

        const rawInput = (input ?? {}) as Record<string, unknown>
        if (rawInput.security || rawInput.access || rawInput.review || rawInput.execution || rawInput.sandbox) {
          return {
            ok: false,
            error: 'Security settings (folders, permissions, review levels, sandbox, API keys, data deletion) cannot be modified by the assistant.',
            open: { route: 'pane/permissions', label: '打开权限' },
          }
        }

        const updated: Record<string, unknown> = {}
        const updatedKeys = new Set<string>()

        // 1. Persona
        if (input.persona) {
          const p = input.persona
          const cur = persona(store)
          const patch: Partial<Persona> = {}
          if (p.name !== undefined) patch.name = p.name
          if (p.avatar !== undefined) patch.avatar = p.avatar
          if (p.color !== undefined) patch.color = p.color
          if (p.role !== undefined) patch.role = p.role
          if (p.language !== undefined) patch.language = p.language
          if (p.personality !== undefined) patch.personality = p.personality
          if (
            p.limits !== undefined ||
            p.limits_replace !== undefined ||
            p.limits_add !== undefined ||
            p.limits_remove !== undefined
          ) {
            let list = [...(p.limits_replace ?? p.limits ?? cur.limits)]
            if (p.limits_add?.length) {
              for (const item of p.limits_add) {
                const trimmed = item.trim()
                if (trimmed && !list.includes(trimmed)) list.push(trimmed)
              }
            }
            if (p.limits_remove?.length) {
              const removeSet = new Set(p.limits_remove.map(x => x.trim()))
              list = list.filter(x => !removeSet.has(x.trim()))
            }
            patch.limits = list
          }
          const saved = savePersona(store, patch)
          bus.emit({ type: 'persona.updated' })
          updatedKeys.add('persona')
          updated.persona = saved
        }

          // 2. Mood & 2D Tone Pad
        if (input.mood) {
          const m = input.mood as z.infer<typeof UpdateMySettingsSchema>['mood'] & { tone?: { x: number; y: number } }
          const state = moodState()
          if (m?.reset) {
            resetMood(state)
          }
          if (m?.enabled !== undefined) {
            setMoodEnabled(state, m.enabled)
          }
          if (m?.diary !== undefined || m?.sensitivity_up !== undefined || m?.sensitivity_down !== undefined) {
            setMindConfig(state, {
              ...(m.diary !== undefined ? { diary: m.diary } : {}),
              ...(m.sensitivity_up !== undefined ? { up: m.sensitivity_up } : {}),
              ...(m.sensitivity_down !== undefined ? { down: m.sensitivity_down } : {}),
            })
          }
          if (m?.values) {
            setMoodValues(state, m.values)
          }
          const currentToneId = moodView(state).tone.id
          const effectivePreset =
            m?.tone_preset ?? (m?.tone_strength !== undefined && currentToneId !== 'natural' ? currentToneId : undefined)
          const targetXY =
            m?.tone_xy ??
            m?.tone ??
            (effectivePreset ? presetToToneXY(effectivePreset, m?.tone_strength ?? TONE_PRESET_DEFAULT_STRENGTH) : undefined)
          if (targetXY) {
            setMoodTone(state, targetXY)
          }
          updatedKeys.add('mood')
          const view = moodView(state)
          updated.mood = {
            enabled: view.enabled,
            mood: view.mood,
            energy: view.energy,
            patience: view.patience,
            trust: view.trust,
            tone: view.tone,
            config: view.config,
          }
        }

        // 3. Layered Models & Thinking Effort (supports single object or array of layer patches)
        if (input.models) {
          const hub = getHub()
          const rawList = Array.isArray(input.models) ? input.models : [input.models]
          const items: z.infer<typeof ModelUpdateItemSchema>[] = []
          for (const item of rawList) {
            items.push(item)
            if (item.voice_temperature !== undefined || item.voice_enabled !== undefined) {
              items.push({
                role: 'voice',
                ...(item.voice_temperature !== undefined ? { temperature: item.voice_temperature } : {}),
                ...(item.voice_enabled !== undefined ? { enabled: item.voice_enabled } : {}),
              })
            }
          }

          const modelUpdates: Record<string, unknown>[] = []
          for (const m of items) {
            const role = (m.role ?? 'router') as string
            if (role === 'reviewer') {
              return {
                ok: false,
                error: 'The reviewer security layer cannot be modified by the assistant. Ask the owner to configure it in Settings → Models.',
                open: { route: 'settings/roles/reviewer', label: '打开审核层设置' },
              }
            }
            if (!(CONFIGURABLE_ROLES as readonly string[]).includes(role)) {
              return { ok: false, error: `Unknown or non-configurable model layer "${role}".` }
            }
            const roleId = role as ConfigurableRoleId
            const cur: RoleConfig = hub.roleConfigs()[roleId] ?? { chain: [], enabled: true }
            const next: RoleConfig = { ...cur, chain: [...cur.chain] }

            if (m.model !== undefined) {
              const trimmed = m.model.trim()
              if (trimmed === '' || trimmed.toLowerCase() === 'inherit') {
                next.chain = []
              } else {
                const providerId = resolveProviderIdForModel(hub, roleId, trimmed, m.provider_id)
                if (!providerId) {
                  return {
                    ok: false,
                    error: 'No model provider is configured yet. Ask the owner to add one in Settings → Providers.',
                    open: { route: 'settings/providers', label: '打开模型供应商' },
                  }
                }
                const rest = cur.chain.slice(1).filter(r => !(r.providerId === providerId && r.model === trimmed))
                next.chain = [{ providerId, model: trimmed }, ...rest].slice(0, 5)
              }
            }
            if (m.enabled !== undefined) next.enabled = m.enabled
            if (m.reasoning !== undefined) next.reasoning = m.reasoning as ReasoningLevel
            if (m.temperature !== undefined) {
              if (m.temperature === null) delete next.temperature
              else next.temperature = m.temperature
            }
            if (m.daily_token_limit !== undefined) {
              if (m.daily_token_limit === null) delete next.dailyTokenLimit
              else next.dailyTokenLimit = m.daily_token_limit
            }
            if (m.daily_cost_limit_usd !== undefined) {
              if (m.daily_cost_limit_usd === null) delete next.dailyCostLimitUsd
              else next.dailyCostLimitUsd = m.daily_cost_limit_usd
            }

            try {
              const saved = hub.saveRole(roleId, next)
              updatedKeys.add('roles')
              const resolved = hub.resolve(roleId)
              modelUpdates.push({
                role: roleId,
                config: saved,
                resolved: resolved
                  ? {
                      source: resolved.source,
                      model: resolved.config.chain[0] ?? null,
                      effectiveReasoning: resolved.config.reasoning ?? defaultReasoningOf(roleId),
                    }
                  : null,
              })
            } catch (error) {
              return { ok: false, error: (error as Error).message }
            }
          }
          updated.models = modelUpdates.length === 1 ? modelUpdates[0] : modelUpdates
        }

        // 4. Client Preferences (Theme, Accent, UI Language, Font Size, Voice / Read Aloud, Desktop)
        if (input.preferences) {
          const { next, patch } = saveClientPrefs(store, input.preferences as Record<string, unknown>)
          if (Object.keys(patch).length > 0) {
            bus.emit({ type: 'prefs.updated', patch })
          }
          updatedKeys.add('client-prefs')
          updated.preferences = next
        }

        // 5. Notifications & Quiet Hours
        if (input.notifications) {
          const n = input.notifications
          const cur = notifySettings(store)
          const patch: Partial<NotifySettings> = {}
          if (n.message !== undefined) patch.message = n.message
          if (n.price !== undefined) patch.price = n.price
          if (n.feed !== undefined) patch.feed = n.feed
          if (n.ideas !== undefined) patch.ideas = n.ideas
          if (n.banner !== undefined) patch.banner = n.banner
          if (n.sound !== undefined) patch.sound = n.sound
          if (n.tone !== undefined) patch.tone = n.tone
          if (n.badge !== undefined) patch.badge = n.badge
          if (n.quiet || n.quiet_on !== undefined || n.quiet_from !== undefined || n.quiet_to !== undefined) {
            patch.quiet = {
              on: n.quiet?.on ?? n.quiet_on ?? cur.quiet.on,
              from: n.quiet?.from ?? n.quiet_from ?? cur.quiet.from,
              to: n.quiet?.to ?? n.quiet_to ?? cur.quiet.to,
            }
          }
          const saved = saveNotifySettings(store, patch)
          updatedKeys.add('notify')
          updated.notifications = saved
        }

        // 6. Ideas Cadence
        if (input.ideas) {
          const saved = ideas.saveSettings(input.ideas)
          updatedKeys.add('ideas')
          updated.ideas = saved
        }

        // 7. Proactive Budget
        if (input.proactive_budget) {
          const cur = proactiveSettings(store)
          const nextBudget = {
            concurrent: input.proactive_budget.concurrent ?? cur.budget.concurrent,
            daily: input.proactive_budget.daily ?? cur.budget.daily,
          }
          const saved = saveProactiveSettings(store, { budget: nextBudget }, 'router')
          updatedKeys.add('proactive')
          updated.proactive_budget = saved.budget
        }

        // 8. Skill Toggle
        if (input.skill_toggle) {
          const q = input.skill_toggle.id_or_name.trim()
          const found = skills.list().find(s => s.id === q || s.name === q || s.name.toLowerCase() === q.toLowerCase())
          if (!found) {
            return { ok: false, error: `No skill found matching "${q}".` }
          }
          const saved = skills.update(found.id, { enabled: input.skill_toggle.enabled })
          updatedKeys.add('skills')
          updated.skill = { id: saved.id, name: saved.name, enabled: saved.enabled }
        }

        // 9. Source Proactive Watch Toggle
        if (input.source_proactive) {
          const srcId = input.source_proactive.source_id.trim()
          const allSources = sources.list().filter(s => s.id !== 'cron').map(s => s.id)
          if (!allSources.includes(srcId)) {
            return { ok: false, error: `Unknown source "${srcId}".` }
          }
          const cur = proactiveSettings(store)
          const currentWatched = cur.sources.length ? cur.sources : allSources
          const nextWatched = input.source_proactive.proactive
            ? [...new Set([...currentWatched, srcId])]
            : currentWatched.filter(x => x !== srcId)
          const saved = saveProactiveSettings(
            store,
            { sources: nextWatched.length === allSources.length ? [] : nextWatched },
            'router',
          )
          updatedKeys.add('proactive')
          updatedKeys.add('sources')
          updated.source_proactive = { source_id: srcId, proactive: input.source_proactive.proactive, watchedSources: saved.sources }
        }

        if (updatedKeys.size > 0) {
          bus.emit({ type: 'settings.updated', keys: [...updatedKeys] })
        }

        return { ok: true, updated }
      },
    }),
  }
}

export function settingsExtension(deps: SettingsToolsDeps): AgentExtensions {
  return {
    routerTools: () => settingsTools(deps),
  }
}
