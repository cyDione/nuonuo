/** Provider kinds the model layer can talk to, with presets for common OpenAI-compatible endpoints (including local runtimes). */
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openai-compatible' | 'typesafe'

/** Decision-model providers: no chat endpoint, so they serve only the layers in DECISION_ROLES. */
export const DECISION_KINDS: readonly ProviderKind[] = ['typesafe']

/**
 * Whether a model is a decision model (TypeSafe Jev): any model of a decision provider, or a Jev model offered by a
 * multi-provider gateway under its own name (`jev-latest`, `typesafe/jev-1.13`, `group/jev`…). `jev-router` is not one:
 * it routes chat requests to chat models.
 */
export function isDecisionModel(kind: ProviderKind, model: string): boolean {
  return DECISION_KINDS.includes(kind) || /(^|[/:])jev(?![-_]?router)([-_.:@]|$)/i.test(model.trim())
}

/** Decision models a gateway may serve without listing them on `/models` (it lists chat models only). */
export const DECISION_MODEL_SUGGESTIONS: readonly string[] = ['jev-latest']

export interface ProviderPreset {
  id: string
  kind: ProviderKind
  label: string
  baseUrl?: string
  /** Local runtimes accept any key. */
  keyRequired: boolean
  /** Starting points only; the settings page can list a provider's live models or take any id. */
  suggestedModels: string[]
  docsUrl?: string
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', keyRequired: true, docsUrl: 'https://console.anthropic.com/settings/keys',
    suggestedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  { id: 'openai', kind: 'openai', label: 'OpenAI', keyRequired: true, docsUrl: 'https://platform.openai.com/api-keys', suggestedModels: [] },
  { id: 'google', kind: 'google', label: 'Google Gemini', keyRequired: true, docsUrl: 'https://aistudio.google.com/apikey', suggestedModels: [] },
  { id: 'deepseek', kind: 'deepseek', label: 'DeepSeek', keyRequired: true, docsUrl: 'https://platform.deepseek.com/api_keys',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'typesafe', kind: 'typesafe', label: 'TypeSafe Jev（仅审核层）', baseUrl: 'https://api.typesafe.ai/v1', keyRequired: true,
    docsUrl: 'https://docs.typesafe.ai', suggestedModels: ['jev-latest'] },
  { id: 'openrouter', kind: 'openai-compatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, suggestedModels: [] },
  { id: 'dashscope', kind: 'openai-compatible', label: '通义千问 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyRequired: true, suggestedModels: [] },
  { id: 'moonshot', kind: 'openai-compatible', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', keyRequired: true, suggestedModels: [] },
  { id: 'zhipu', kind: 'openai-compatible', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyRequired: true, suggestedModels: [] },
  { id: 'siliconflow', kind: 'openai-compatible', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', keyRequired: true, suggestedModels: [] },
  { id: 'ollama', kind: 'openai-compatible', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', keyRequired: false, suggestedModels: [] },
  { id: 'lmstudio', kind: 'openai-compatible', label: 'LM Studio（本地）', baseUrl: 'http://127.0.0.1:1234/v1', keyRequired: false, suggestedModels: [] },
  { id: 'custom', kind: 'openai-compatible', label: '自定义 OpenAI 兼容', keyRequired: false, suggestedModels: [] },
]

/** The preset a stored provider came from: same kind and base URL, else the kind's only preset. */
export function presetOf(kind: ProviderKind, baseUrl: string | null): ProviderPreset | undefined {
  const base = (baseUrl ?? '').replace(/\/+$/, '')
  return PROVIDER_PRESETS.find(p => p.kind === kind && (p.baseUrl ?? '').replace(/\/+$/, '') === base)
    ?? (kind === 'openai-compatible' ? undefined : PROVIDER_PRESETS.find(p => p.kind === kind))
}
