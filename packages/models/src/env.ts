/**
 * Providers whose key lives in an environment variable. The key is read from `process.env` at call time and is never copied
 * into the keychain, the database or a worker's shell (workers get a sanitized environment).
 */
import type { ProviderKind } from './catalog'
import type { SecretStore } from './secrets'

export interface EnvProviderSpec { env: string[]; kind: ProviderKind; name: string; baseUrl?: string; baseUrlEnv?: string }

export const ENV_PROVIDERS: readonly EnvProviderSpec[] = [
  { env: ['ANTHROPIC_API_KEY'], kind: 'anthropic', name: 'Anthropic', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
  { env: ['OPENAI_API_KEY'], kind: 'openai', name: 'OpenAI', baseUrlEnv: 'OPENAI_BASE_URL' },
  { env: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], kind: 'google', name: 'Google Gemini' },
  { env: ['DEEPSEEK_API_KEY'], kind: 'deepseek', name: 'DeepSeek', baseUrlEnv: 'DEEPSEEK_BASE_URL' },
  { env: ['OPENROUTER_API_KEY'], kind: 'openai-compatible', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { env: ['DASHSCOPE_API_KEY'], kind: 'openai-compatible', name: '通义千问 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { env: ['MOONSHOT_API_KEY'], kind: 'openai-compatible', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { env: ['ZHIPU_API_KEY'], kind: 'openai-compatible', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { env: ['SILICONFLOW_API_KEY'], kind: 'openai-compatible', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1' },
]

export const ENV_REF = 'env:'

/** The first set variable of a spec, if any. */
export const envVarOf = (spec: EnvProviderSpec, env: NodeJS.ProcessEnv = process.env) => spec.env.find(name => env[name]?.trim())

/** Resolves `env:NAME` refs from the environment and delegates everything else to the underlying store. */
export class EnvAwareSecrets implements SecretStore {
  constructor(private inner: SecretStore, private env: NodeJS.ProcessEnv = process.env) {}
  get backend() { return this.inner.backend }
  get(ref: string) {
    if (ref.startsWith(ENV_REF)) return this.env[ref.slice(ENV_REF.length)]?.trim() || undefined
    return this.inner.get(ref)
  }
  set(ref: string, value: string) {
    if (ref.startsWith(ENV_REF)) throw new Error('环境变量提供的密钥是只读的')
    this.inner.set(ref, value)
  }
  delete(ref: string) { if (!ref.startsWith(ENV_REF)) this.inner.delete(ref) }
}

/** Names of environment variables that hold credentials; stripped from worker shells. */
export function isSecretEnvName(name: string): boolean {
  return /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|SESSION_KEY)/i.test(name)
    || ENV_PROVIDERS.some(spec => spec.env.includes(name))
}
