/**
 * The Docker sandbox tier: a worker's shell commands run in a throwaway container that sees only the task's working
 * directory and the folders the owner allowed in 权限 (each mounted at the same path, read-only unless it may be changed;
 * never-touch folders inside them are covered by an empty mount), as the owner's uid, with the network on or off. Off by default; it can apply to
 * every task or only to tasks from external sources (a GitHub thread rather than the owner's own chat).
 */
import { userInfo } from 'node:os'
import type { Ticket } from './model'
import { sourceOfThread } from './model'

export interface SandboxSettings {
  mode: 'off' | 'external' | 'all'
  image: string
  network: 'bridge' | 'none'
}

export const DEFAULT_SANDBOX: SandboxSettings = { mode: 'off', image: 'node:22-bookworm-slim', network: 'bridge' }

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function sandboxApplies(settings: SandboxSettings, ticket: Ticket): boolean {
  if (settings.mode === 'off') return false
  if (settings.mode === 'all') return true
  return !['webchat', 'cron'].includes(sourceOfThread(ticket.threadId))
}

/** The command that runs `command` inside the sandbox for this task. */
/** A host folder the container sees at the same path. */
export interface SandboxMount { path: string; write: boolean }

export function sandboxCommand(settings: SandboxSettings, ticket: Ticket, command: string, uid = userInfo().uid, gid = userInfo().gid,
  mounts: SandboxMount[] = [], hidden: string[] = []): string {
  const dir = ticket.directory
  return ['docker run --rm -i --init',
    `--network ${settings.network}`,
    `--user ${uid}:${gid}`,
    '-e HOME=/tmp -e CI=1',
    `-e NUONUO_TICKET=${ticket.id}`,
    `-v ${quote(`${dir}:${dir}`)}`,
    ...mounts.filter(m => m.path !== dir).map(m => `-v ${quote(`${m.path}:${m.path}${m.write ? '' : ':ro'}`)}`),
    ...hidden.map(h => `--mount ${quote(`type=tmpfs,destination=${h}`)}`),
    `-w ${quote(dir)}`,
    '--memory 4g --pids-limit 512',
    `--label nuonuo.ticket=${ticket.id}`,
    quote(settings.image),
    'bash -lc', quote(command)].join(' ')
}
