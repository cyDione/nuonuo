import { openStore, type Store } from '@nuonuo/db'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fsTools } from '@nuonuo/agent-runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalAccess, LOCKED_NEVER } from './access'

let store: Store
let home: string
let access: LocalAccess
beforeEach(() => {
  store = openStore(':memory:')
  home = mkdtempSync(join(tmpdir(), 'sa-access-'))
  access = new LocalAccess(store, () => home)
})
afterEach(() => store.close())

describe('LocalAccess', () => {
  it('allows only listed folders, read-only unless marked writable', () => {
    access.save({ folders: [{ path: '~/Documents', write: false }, { path: '~/Downloads', write: true }] })
    expect(access.check(join(home, 'Documents/a.txt'), 'read')).toBeUndefined()
    expect(access.check(join(home, 'Documents/a.txt'), 'write')).toMatch('只允许看')
    expect(access.check(join(home, 'Downloads/x/y.pdf'), 'write')).toBeUndefined()
    expect(access.check(join(home, 'Desktop/z'), 'read')).toMatch('不在你允许的文件夹里')
    expect(access.check(join(home, 'DocumentsX/a'), 'read')).toMatch('不在你允许的文件夹里')
  })
  it('never touches the never list, even inside an allowed folder, and keeps the locked ones', () => {
    access.save({ folders: [{ path: '~', write: true }], never: ['~/Private', '~/.ssh'] })
    expect(access.check(join(home, 'Private/diary.md'), 'read')).toMatch('永远不碰')
    expect(access.check(join(home, '.ssh/id_ed25519'), 'read')).toMatch('永远不碰')
    expect(access.check(join(home, 'notes.md'), 'write')).toBeUndefined()
    const s = access.settings()
    expect(s.never).toEqual(['~/Private'])
    expect(s.locked).toEqual(LOCKED_NEVER)
  })
  it('reads extra roots (attachments) without listing them', () => {
    expect(access.check('/data/uploads/upl_1/a.png', 'read', ['/data/uploads'])).toBeUndefined()
    expect(access.check('/data/uploads/upl_1/a.png', 'write', ['/data/uploads'])).toMatch('不在你允许')
  })
  it('finds never-touch folders named in shell commands', () => {
    access.save({ never: ['~/Private'] })
    expect(access.shellTouchesNever('cat ~/Private/a.txt')).toBe('~/Private')
    expect(access.shellTouchesNever(`ls ${home}/.gnupg`)).toBe('~/.gnupg')
    expect(access.shellTouchesNever('tar czf x.tgz $HOME/.aws')).toBe('~/.aws')
    expect(access.shellTouchesNever('ls ~/Documents')).toBeUndefined()
  })
  it('keeps app levels with defaults', () => {
    expect(access.app('photos')).toBe('off')
    access.save({ apps: { photos: 'read' } as never })
    expect(access.app('photos')).toBe('read')
    expect(access.app('calendar')).toBe('ask')
  })
})

describe('file tools with folder access', () => {
  it('reach allowed folders by absolute path and refuse the rest, also through links', async () => {
    const work = mkdtempSync(join(tmpdir(), 'sa-work-'))
    mkdirSync(join(home, 'Documents'), { recursive: true })
    mkdirSync(join(home, 'Private'), { recursive: true })
    writeFileSync(join(home, 'Documents/plan.md'), 'hello')
    writeFileSync(join(home, 'Private/secret.md'), 'no')
    symlinkSync(join(home, 'Private'), join(home, 'Documents/link'))
    access.save({ folders: [{ path: join(home, 'Documents'), write: false }], never: [join(home, 'Private')] })
    const blobs = { spill: (_: string, text: string) => text } as never
    const tools = fsTools(work, blobs, (p, m) => access.check(p, m))
    const run = (name: keyof typeof tools, input: unknown) => (tools[name] as any).execute(input, {})
    expect(await run('read_file', { path: join(home, 'Documents/plan.md') })).toContain('hello')
    await expect(run('read_file', { path: join(home, 'Documents/link/secret.md') })).rejects.toThrow('永远不碰')
    await expect(run('write_file', { path: join(home, 'Documents/new.md'), content: 'x' })).rejects.toThrow('只允许看')
    await expect(run('read_file', { path: '/etc/hostname' })).rejects.toThrow('不在你允许')
    expect(await run('find_files', { path: join(home, 'Documents'), pattern: '*.md' })).toContain('plan.md')
    expect(await run('write_file', { path: 'out.md', content: 'ok' })).toContain('out.md')
    expect(await run('move_path', { from: 'out.md', to: 'done/out.md' })).toContain('done/out.md')
  })
})
