/**
 * Providers whose key lives in an environment variable. The key is read from `process.env` at call time and is never copied
 * into the keychain, the database or a worker's shell (workers get a sanitized environment).
 */
import { PROVIDER_PRESETS, type ProviderKind } from './catalog'
import type { SecretStore } from './secrets'

export interface EnvProviderSpec { env: string[]; kind: ProviderKind; name: string; baseUrl?: string; baseUrlEnv?: string }

/** The presets that carry `env`, in the shape registration needs. */
export const ENV_PROVIDERS: readonly EnvProviderSpec[] = PROVIDER_PRESETS.filter(p => p.env?.length).map(p => ({
  env: p.env!, kind: p.kind, name: p.name ?? p.label, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(p.baseUrlEnv ? { baseUrlEnv: p.baseUrlEnv } : {}),
}))

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
