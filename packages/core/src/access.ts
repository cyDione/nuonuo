/**
 * What the assistant may touch on this computer, set in the right pane's 权限 (one home for every permission):
 * folders it can see or change, folders it never touches, and per local app (日历, 提醒事项…) how far it may go.
 * File tools check every path outside the task's own directory here; the shell gate blocks commands that name a
 * never-touch folder. Credential stores are locked in the never-touch list and cannot be removed.
 */
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { kvGet, kvSet, type Store } from '@super-assistant/db'

export type AppLevel = 'auto' | 'ask' | 'read' | 'off'
export const LOCAL_APPS = ['calendar', 'reminders', 'notes', 'contacts', 'photos'] as const
export type LocalApp = typeof LOCAL_APPS[number]

export interface AllowedFolder { path: string; write: boolean }
export interface AccessSettings {
  folders: AllowedFolder[]
  never: string[]
  apps: Record<LocalApp, AppLevel>
  /** Per connected source: only read it, or also act there (reply, create, move). */
  sources: Record<string, 'read' | 'act'>
}

/** Locked: always in the never-touch list, shown with a lock in 权限. */
export const LOCKED_NEVER = ['~/.ssh', '~/.gnupg', '~/Library/Keychains', '~/.aws', '~/.config/gcloud', '~/.kube', '~/.docker']

export const DEFAULT_ACCESS: AccessSettings = {
  folders: [],
  never: [],
  apps: { calendar: 'ask', reminders: 'ask', notes: 'read', contacts: 'read', photos: 'off' },
  sources: {},
}

const KEY = 'settings:access'

export function expandHome(path: string, home = process.env.HOME ?? homedir()): string {
  return resolve(path.replace(/^~(?=$|[/\\])/, home))
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

export class LocalAccess {
  constructor(private store: Store, private home = () => process.env.HOME ?? homedir()) {}

  settings(): AccessSettings & { locked: string[] } {
    const saved = kvGet<Partial<AccessSettings>>(this.store, KEY) ?? {}
    return {
      folders: saved.folders ?? DEFAULT_ACCESS.folders,
      never: (saved.never ?? DEFAULT_ACCESS.never).filter(p => !LOCKED_NEVER.includes(p)),
      apps: { ...DEFAULT_ACCESS.apps, ...(saved.apps ?? {}) },
      sources: { ...DEFAULT_ACCESS.sources, ...(saved.sources ?? {}) },
      locked: LOCKED_NEVER,
    }
  }

  save(patch: Partial<AccessSettings>): ReturnType<LocalAccess['settings']> {
    const { locked: _locked, ...current } = this.settings()
    const next: AccessSettings = { ...current, ...patch,
      apps: { ...current.apps, ...(patch.apps ?? {}) }, sources: { ...current.sources, ...(patch.sources ?? {}) } }
    next.never = [...new Set(next.never.map(p => p.trim()).filter(Boolean))].filter(p => !LOCKED_NEVER.includes(p))
    next.folders = next.folders.filter(f => f.path.trim()).map(f => ({ path: f.path.trim(), write: Boolean(f.write) }))
    kvSet(this.store, KEY, next)
    return this.settings()
  }

  /** The never-touch entry a path falls under, if any. */
  forbidden(path: string): string | undefined {
    const abs = expandHome(path, this.home())
    const s = this.settings()
    return [...LOCKED_NEVER, ...s.never].find(p => inside(abs, expandHome(p, this.home())))
  }

  /**
   * Why a path outside the task's directory may not be read or written, or undefined when it may. Extra roots (the
   * uploads folder with the owner's attachments) are readable without being listed.
   */
  check(path: string, mode: 'read' | 'write', extraRead: string[] = []): string | undefined {
    const abs = expandHome(path, this.home())
    const never = this.forbidden(abs)
    if (never) return `${path} 在「永远不碰」里（${never}），不能${mode === 'read' ? '读' : '改'}`
    if (mode === 'read' && extraRead.some(r => inside(abs, resolve(r)))) return undefined
    const folder = this.settings().folders
      .map(f => ({ ...f, abs: expandHome(f.path, this.home()) }))
      .filter(f => inside(abs, f.abs))
      .sort((a, b) => b.abs.length - a.abs.length)[0]
    if (!folder) return `${path} 不在你允许的文件夹里。需要的话请主人在 权限 → 文件夹 里加上`
    if (mode === 'write' && !folder.write) return `${folder.path} 只允许看，不能改`
    return undefined
  }

  /** A shell command that names a never-touch folder (by ~, $HOME or its absolute path). */
  shellTouchesNever(command: string): string | undefined {
    const home = this.home()
    const s = this.settings()
    for (const entry of [...LOCKED_NEVER, ...s.never]) {
      const abs = expandHome(entry, home)
      const rel = abs.startsWith(home + sep) ? abs.slice(home.length + 1) : null
      const forms = [abs, ...(rel ? [`~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`] : [])]
      if (forms.some(f => command.includes(f))) return entry
    }
    return undefined
  }

  app(name: LocalApp): AppLevel { return this.settings().apps[name] }

  /** Folders the assistant may use, for the worker prompt. */
  describe(): string {
    const s = this.settings()
    const lines = s.folders.map(f => `- ${f.path}（${f.write ? '能看能改' : '只能看'}）`)
    const never = [...LOCKED_NEVER, ...s.never]
    return [
      lines.length ? `Folders on this computer you may use with the file tools (absolute or ~ paths):\n${lines.join('\n')}` : 'The owner has not allowed any folders outside the working directory yet; if you need one, say which in your result.',
      `Never touch, with any tool or command: ${never.join(', ')}`,
    ].join('\n')
  }
}

