/** The execution layers of the system and the per-layer model configuration a person sets in Settings → Models. */
import { z } from 'zod'

export const ROLE_IDS = ['router', 'worker', 'subagent', 'filter', 'reviewer', 'watchdog', 'summarizer', 'embedding', 'vision'] as const
export type RoleId = typeof ROLE_IDS[number]

export interface RoleSpec {
  id: RoleId
  label: string
  duty: string
  advice: string
  /** Used when this layer has no model of its own; `undefined` means the layer is off without one. */
  inherits?: RoleId
  /** Off-able layers are skipped (not inherited) when disabled. */
  optional?: boolean
  kind: 'language' | 'embedding'
}

export const ROLES: readonly RoleSpec[] = [
  { id: 'router', label: '主 Agent（Router）', duty: '路由、批量决策、对话回复', advice: '中等、快、缓存友好；不执行具体任务', kind: 'language' },
  { id: 'worker', label: '执行（Worker）', duty: '执行具体任务（编码、调研、操作）', advice: '最强的模型', inherits: 'router', kind: 'language' },
  { id: 'subagent', label: '子任务（Subagent）', duty: 'Worker 内部派生的子任务', advice: '默认继承 Worker', inherits: 'worker', kind: 'language' },
  { id: 'filter', label: '过滤（Filter）', duty: 'Slow Path：外部事件是否值得处理', advice: '最便宜，可用本地模型；关闭时由主 Agent 兼做', optional: true, kind: 'language' },
  { id: 'reviewer', label: '审核（Reviewer）', duty: '审核高风险动作：放行 / 拦截 / 上交', advice: '专门的审核模型，建议与 Worker 不同供应商；为空时用主 Agent', inherits: 'router', kind: 'language' },
  { id: 'watchdog', label: '看门狗（Watchdog）', duty: '判断任务有无实质进展、诊断故障', advice: '中等', inherits: 'router', kind: 'language' },
  { id: 'summarizer', label: '摘要（Summarizer）', duty: '上下文压缩、日报与摘要', advice: '便宜、长上下文', inherits: 'router', kind: 'language' },
  { id: 'embedding', label: '向量（Embedding）', duty: '记忆检索', advice: '本地或云端 embedding 模型', optional: true, kind: 'embedding' },
  { id: 'vision', label: '视觉（Vision）', duty: '截图与网页理解', advice: '多模态；为空时用 Worker', inherits: 'worker', kind: 'language' },
]

/** Layers that may use a decision model (TypeSafe Jev) instead of a language model. */
export const DECISION_ROLES: readonly RoleId[] = ['reviewer']

export const roleSpec = (id: RoleId): RoleSpec => ROLES.find(r => r.id === id)!

export const ModelRefSchema = z.object({ providerId: z.string().min(1), model: z.string().trim().min(1) }).strict()
export type ModelRef = z.infer<typeof ModelRefSchema>

export const REASONING_LEVELS = ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const RoleConfigSchema = z.object({
  /** The models to try in order: the first is primary, the rest are fallbacks on retryable failures. Empty = inherit. */
  chain: z.array(ModelRefSchema).max(5).default([]),
  enabled: z.boolean().default(true),
  reasoning: z.enum(REASONING_LEVELS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  /** Daily limits per layer; a call past either is refused before it is sent. */
  dailyTokenLimit: z.number().int().min(1).optional(),
  dailyCostLimitUsd: z.number().min(0).optional(),
}).strict()
export type RoleConfig = z.infer<typeof RoleConfigSchema>

export interface ResolvedRole {
  role: RoleId
  /** The layer whose chain is used, after inheritance. */
  source: RoleId
  config: RoleConfig
}

/** Follows `inherits` until a layer with a chain; settings such as limits stay those of the asked layer when it has its own. */
export function resolveRole(role: RoleId, configs: Partial<Record<RoleId, RoleConfig>>): ResolvedRole | undefined {
  const own = configs[role]
  const spec = roleSpec(role)
  if (spec.optional && own && !own.enabled) return undefined
  let current: RoleId | undefined = role
  const seen = new Set<RoleId>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const config = configs[current]
    if (config && config.enabled && config.chain.length > 0) {
      return { role, source: current, config: current === role ? config : { ...config, ...pickLimits(own) } }
    }
    const next: RoleSpec = roleSpec(current)
    if (next.optional && current !== role) return undefined
    current = next.inherits
  }
  return undefined
}

function pickLimits(config: RoleConfig | undefined): Partial<RoleConfig> {
  if (!config) return {}
  const out: Partial<RoleConfig> = {}
  for (const key of ['reasoning', 'temperature', 'maxOutputTokens', 'dailyTokenLimit', 'dailyCostLimitUsd'] as const) {
    if (config[key] !== undefined) (out as any)[key] = config[key]
  }
  return out
}
