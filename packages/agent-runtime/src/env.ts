import { isSecretEnvName } from '@nuonuo/models'

/** The environment a worker's shell gets: the daemon's own, minus every variable that looks like a credential. */
export function workerEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isSecretEnvName(key)) env[key] = value
  }
  return { ...env, ...extra, NUONUO_WORKER: '1' }
}
