/** Provider kinds the model layer can talk to, with presets for common OpenAI-compatible endpoints (including local runtimes). */
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openai-compatible'

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
  { id: 'openrouter', kind: 'openai-compatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, suggestedModels: [] },
  { id: 'dashscope', kind: 'openai-compatible', label: '通义千问 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyRequired: true, suggestedModels: [] },
  { id: 'moonshot', kind: 'openai-compatible', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', keyRequired: true, suggestedModels: [] },
  { id: 'zhipu', kind: 'openai-compatible', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyRequired: true, suggestedModels: [] },
  { id: 'siliconflow', kind: 'openai-compatible', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', keyRequired: true, suggestedModels: [] },
  { id: 'ollama', kind: 'openai-compatible', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', keyRequired: false, suggestedModels: [] },
  { id: 'lmstudio', kind: 'openai-compatible', label: 'LM Studio（本地）', baseUrl: 'http://127.0.0.1:1234/v1', keyRequired: false, suggestedModels: [] },
  { id: 'custom', kind: 'openai-compatible', label: '自定义 OpenAI 兼容', keyRequired: false, suggestedModels: [] },
]
