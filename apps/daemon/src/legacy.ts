/**
 * The project was called super-assistant up to v0.2.4. Installs from then keep working on the new name:
 * - SUPER_ASSISTANT_* variables (the shell, `<home>/env`, service units written by old versions) still apply, as NUONUO_*;
 * - the data directory ~/.super-assistant is used until `start` moves it to ~/.nuonuo, once no old service holds it,
 *   and a link is left at the old path for anything that still points there.
 */
import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const LEGACY_PREFIX = 'SUPER_ASSISTANT_'
export const legacyHome = () => join(homedir(), '.super-assistant')
export const defaultHome = () => join(homedir(), '.nuonuo')

/** Whether `path` names the old default data directory (old units and update helpers pass it explicitly). */
const isLegacyDefault = (path: string) => resolve(path) === resolve(legacyHome())

/**
 * Copies SUPER_ASSISTANT_X to NUONUO_X where NUONUO_X is not set. SUPER_ASSISTANT_HOME is left out when it is just the
 * old default, so that the data directory can move to the new default.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_PREFIX) || value === undefined) continue
    const name = `NUONUO_${key.slice(LEGACY_PREFIX.length)}`
    if (env[name] !== undefined) continue
    if (name === 'NUONUO_HOME' && isLegacyDefault(value)) continue
    env[name] = value
    adopted.push(name)
  }
  return adopted
}

/**
 * The data directory: NUONUO_HOME, else ~/.nuonuo, except that an install not yet moved keeps using ~/.super-assistant.
 * NUONUO_HOME set to the old default counts as not set.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.NUONUO_HOME?.trim()
  if (set && !isLegacyDefault(set)) return resolve(set)
  const fresh = defaultHome()
  return existsSync(fresh) || !existsSync(legacyHome()) ? fresh : legacyHome()
}

function liveDaemon(home: string): number | undefined {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }
    if (pid === process.pid) return undefined
    process.kill(pid, 0)
    return pid
  } catch { return undefined }
}

export type HomeMove = { moved: true; from: string; to: string } | { moved: false; reason?: string }

/**
 * Moves ~/.super-assistant to ~/.nuonuo, when the data directory is still the old one and no service of an older version
 * is running on it (that one would keep writing to the old path; the next start moves it instead).
 */
export function migrateLegacyHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): HomeMove {
  const from = legacyHome()
  const to = defaultHome()
  if (resolveHome(env) !== from) return { moved: false }
  try { if (lstatSync(from).isSymbolicLink()) return { moved: false } } catch { return { moved: false } }
  const pid = liveDaemon(from)
  if (pid) return { moved: false, reason: `旧版服务仍在运行（pid ${pid}），数据目录暂时留在 ${from}` }
  try {
    renameSync(from, to)
  } catch (error) {
    return { moved: false, reason: `无法把 ${from} 移到 ${to}：${error instanceof Error ? error.message : error}` }
  }
  try { symlinkSync(to, from, platform === 'win32' ? 'junction' : 'dir') } catch { /* the link is only a convenience */ }
  return { moved: true, from, to }
}
