/** Provider kinds the model layer can talk to, with presets for common OpenAI-compatible endpoints (including local runtimes). */
export const PROVIDER_KINDS = ['anthropic', 'openai', 'google', 'deepseek', 'openai-compatible', 'typesafe'] as const
export type ProviderKind = typeof PROVIDER_KINDS[number]

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

/**
 * How each provider kind is spoken to: the default API root, how the key is sent, and what its model list needs. The model
 * factory and discovery read only this, so a new kind is one entry here plus its SDK in `factory.ts`.
 */
export interface KindSpec {
  label: string
  /** API root used when a provider of this kind has no base URL of its own. */
  baseUrl?: string
  /** How the key travels on list requests (the SDKs handle it on model calls). */
  auth: 'bearer' | 'x-api-key' | 'x-goog-api-key'
  /** Extra headers every list request needs. */
  headers?: Record<string, string>
  /** Query string on `/models` (page size: some kinds page small by default). */
  listQuery?: string
  /** OpenAI-style APIs may keep embeddings on `/embeddings/models`. */
  embeddingsList?: boolean
  /** Gateways may serve Jev on a decision endpoint they do not list. */
  probeDecisions?: boolean
}

export const SYSTEM_ONE_BASE = 'https://api.typesafe.ai/v1'

export const KINDS: Readonly<Record<ProviderKind, KindSpec>> = {
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', auth: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' }, listQuery: 'limit=1000' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', auth: 'bearer', embeddingsList: true },
  google: { label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', auth: 'x-goog-api-key', listQuery: 'pageSize=1000' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', auth: 'bearer', embeddingsList: true },
  'openai-compatible': { label: 'OpenAI 兼容', auth: 'bearer', embeddingsList: true, probeDecisions: true },
  typesafe: { label: '决策接口', baseUrl: SYSTEM_ONE_BASE, auth: 'bearer' },
}

/**
 * A provider people can pick, and the environment variables that register it on their own. This table is the only place
 * a provider is named: the settings page, first-run setup, `*_API_KEY` detection and the worker's secret filter all read it.
 */
export interface ProviderPreset {
  id: string
  kind: ProviderKind
  /** What the picker shows. */
  label: string
  /** The provider's name once added, when shorter than the label. */
  name?: string
  baseUrl?: string
  /** Local runtimes accept any key. */
  keyRequired: boolean
  /**
   * Ids a provider serves without listing them. Model ids are never kept here as defaults: they go out of date. The settings
   * page shows the provider's live list (newest first), and a new install starts on a model picked from that list.
   */
  suggestedModels: string[]
  docsUrl?: string
  /** What a key looks like, for the key field's placeholder. */
  keyHint?: string
  /** Variables that hold its key: when one is set, the provider is registered from it (first set one wins). */
  env?: string[]
  /** Variable that overrides the base URL of a provider registered from `env`. */
  baseUrlEnv?: string
  /** Offered on the first-run screen. */
  firstRun?: true
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', keyRequired: true, docsUrl: 'https://console.anthropic.com/settings/keys', suggestedModels: [],
    keyHint: 'sk-ant-…', env: ['ANTHROPIC_API_KEY'], baseUrlEnv: 'ANTHROPIC_BASE_URL', firstRun: true },
  { id: 'openai', kind: 'openai', label: 'OpenAI', keyRequired: true, docsUrl: 'https://platform.openai.com/api-keys', suggestedModels: [],
    keyHint: 'sk-…', env: ['OPENAI_API_KEY'], baseUrlEnv: 'OPENAI_BASE_URL', firstRun: true },
  { id: 'google', kind: 'google', label: 'Google Gemini', keyRequired: true, docsUrl: 'https://aistudio.google.com/apikey', suggestedModels: [],
    env: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] },
  { id: 'deepseek', kind: 'deepseek', label: 'DeepSeek', keyRequired: true, docsUrl: 'https://platform.deepseek.com/api_keys', suggestedModels: [],
    env: ['DEEPSEEK_API_KEY'], baseUrlEnv: 'DEEPSEEK_BASE_URL' },
  { id: 'typesafe', kind: 'typesafe', label: 'TypeSafe Jev（仅审核层）', name: 'TypeSafe Jev', baseUrl: SYSTEM_ONE_BASE, keyRequired: true,
    docsUrl: 'https://docs.typesafe.ai', suggestedModels: ['jev-latest'], env: ['TYPESAFE_API_KEY'] },
  { id: 'openrouter', kind: 'openai-compatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, suggestedModels: [], env: ['OPENROUTER_API_KEY'] },
  { id: 'dashscope', kind: 'openai-compatible', label: '通义千问 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyRequired: true, suggestedModels: [], env: ['DASHSCOPE_API_KEY'] },
  { id: 'moonshot', kind: 'openai-compatible', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', keyRequired: true, suggestedModels: [], env: ['MOONSHOT_API_KEY'] },
  { id: 'zhipu', kind: 'openai-compatible', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyRequired: true, suggestedModels: [], env: ['ZHIPU_API_KEY'] },
  { id: 'siliconflow', kind: 'openai-compatible', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', keyRequired: true, suggestedModels: [], env: ['SILICONFLOW_API_KEY'] },
  { id: 'ollama', kind: 'openai-compatible', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', keyRequired: false, suggestedModels: [] },
  { id: 'lmstudio', kind: 'openai-compatible', label: 'LM Studio（本地）', baseUrl: 'http://127.0.0.1:1234/v1', keyRequired: false, suggestedModels: [] },
  { id: 'custom', kind: 'openai-compatible', label: '自定义 OpenAI 兼容', name: '自己的网关', keyRequired: false, suggestedModels: [], keyHint: '没有可以留空', firstRun: true },
]

/** The preset a stored provider came from: same kind and base URL, else the kind's only preset. */
export function presetOf(kind: ProviderKind, baseUrl: string | null): ProviderPreset | undefined {
  const base = (baseUrl ?? '').replace(/\/+$/, '')
  return PROVIDER_PRESETS.find(p => p.kind === kind && (p.baseUrl ?? '').replace(/\/+$/, '') === base)
    ?? (kind === 'openai-compatible' ? undefined : PROVIDER_PRESETS.find(p => p.kind === kind))
}
