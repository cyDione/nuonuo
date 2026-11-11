import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERSION } from './config'
import { assetPattern, compareVersions, detectInstall, installerPattern, runsAsService, Updater } from './update'

describe('compareVersions', () => {
  it('orders dotted versions numerically, with or without v, and pre-releases first', () => {
    expect(compareVersions('v0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.1.0', 'v0.1.0')).toBe(0)
    expect(compareVersions('0.1', '0.1.1')).toBe(-1)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
  })
})

function fakePackage() {
  const prefix = mkdtempSync(join(tmpdir(), 'sa-pkg-'))
  for (const f of ['bin/nuonuo', 'runtime/node', 'lib/cli.mjs']) {
    mkdirSync(join(prefix, f, '..'), { recursive: true })
    writeFileSync(join(prefix, f), '')
  }
  return prefix
}

describe('detectInstall', () => {
  it('recognises the release package, a source checkout, and anything else', () => {
    const prefix = fakePackage()
    expect(detectInstall(join(prefix, 'lib/cli.mjs'))).toEqual({ kind: 'package', prefix })
    expect(detectInstall(join(__dirname, 'cli.ts')).kind).toBe('source')
    expect(detectInstall(join(mkdtempSync(join(tmpdir(), 'sa-x-')), 'cli.mjs')).kind).toBe('other')
  })
})

describe('Updater', () => {
  const release = (tag: string, assets = [`nuonuo-${tag.slice(1)}-linux-${process.arch}.tar.gz`]) =>
    ({ tag_name: tag, html_url: `https://github.com/x/releases/${tag}`, body: 'notes', published_at: '2026-11-05T00:00:00Z', assets: assets.map(name => ({ name })) })
  const make = (body: unknown, status = 200, env: NodeJS.ProcessEnv = { GITHUB_TOKEN: 't' }) => {
    const calls: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${(init.headers as Record<string, string>).authorization}`)
      return url.includes('/contents/install.sh') ? new Response('echo hi') : new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    const home = mkdtempSync(join(tmpdir(), 'sa-home-'))
    return { calls, home, updater: new Updater({ home, entry: join(fakePackage(), 'lib/cli.mjs'), env, fetch: fetchImpl }) }
  }

  it('reports a newer release with a Linux package as available, and caches the result on disk', async () => {
    const { updater, calls, home } = make(release('v99.0.0'))
    const s = await updater.check()
    expect(s).toMatchObject({ current: VERSION, install: 'package', available: true, checkError: null, latest: { tag: 'v99.0.0', hasPackage: true } })
    expect(calls[0]).toBe('https://api.github.com/repos/cyDione/nuonuo/releases/latest Bearer t')
    const again = new Updater({ home, entry: join(fakePackage(), 'lib/cli.mjs'), env: {} })
    expect(again.status().latest?.tag).toBe('v99.0.0')
  })

  it('is not available for the same version or a release without the package', async () => {
    expect((await make(release(`v${VERSION}`)).updater.check()).available).toBe(false)
    expect((await make(release('v99.0.0', [])).updater.check()).available).toBe(false)
  })

  it('needs no token (the repository is public) and explains GitHub errors instead of throwing', async () => {
    const none = make(release('v99.0.0'), 200, {})
    expect(await none.updater.check()).toMatchObject({ available: true, checkError: null })
    expect(none.calls[0]).toBe('https://api.github.com/repos/cyDione/nuonuo/releases/latest undefined')
    expect((await make({}, 404).updater.check()).checkError).toMatch(/还没有发布/)
    expect((await make({}, 403).updater.check()).checkError).toMatch(/频率/)
  })

  it('only counts the package for this machine, and the desktop app only reports', async () => {
    const other = process.arch === 'arm64' ? 'x64' : 'arm64'
    expect((await make(release('v99.0.0', [`nuonuo-99.0.0-linux-${other}.tar.gz`])).updater.check()).available).toBe(false)
    expect(assetPattern(true, 'darwin', 'arm64').test('nuonuo-1.0.0-mac-arm64.dmg')).toBe(true)
    expect(assetPattern(true, 'win32', 'x64').test('nuonuo-1.0.0-win-x64-setup.exe')).toBe(true)
    expect(assetPattern(true, 'win32', 'x64').test('nuonuo-1.0.0-win-arm64-setup.exe')).toBe(false)
    const desktop = new Updater({ home: mkdtempSync(join(tmpdir(), 'sa-home-')), entry: join(fakePackage(), 'lib/cli.mjs'), env: {}, desktop: true })
    expect(desktop.status()).toMatchObject({ install: 'desktop', canUpdate: false })
  })

  it('prepares install.sh from the release tag with the prefix, version and token', async () => {
    const { updater } = make(release('v99.0.0'))
    if (process.platform !== 'linux') return
    const p = await updater.prepare()
    expect(p.script).toBe('echo hi')
    expect(p.env).toMatchObject({ GITHUB_TOKEN: 't', NUONUO_VERSION: 'v99.0.0', NUONUO_PREFIX: updater.install.kind === 'package' ? updater.install.prefix : '' })
    await expect(make(release(`v${VERSION}`)).updater.prepare()).rejects.toThrow(/已是最新/)
  })
})

describe('desktop download', () => {
  const payload = Buffer.from('MZ fake installer '.repeat(1000))
  const sha = `sha256:${createHash('sha256').update(payload).digest('hex')}`
  const setup = 'nuonuo-99.0.0-win-x64-setup.exe'
  const make = (digest: string | null = sha, home = mkdtempSync(join(tmpdir(), 'sa-home-'))) => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      if (url.endsWith('.exe')) return new Response(payload)
      return new Response(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'u', assets: [
        { name: 'nuonuo-99.0.0-win-x64.zip', browser_download_url: 'https://dl/x.zip', size: 1 },
        { name: setup, browser_download_url: `https://dl/${setup}`, size: payload.length, digest },
      ] }))
    }) as unknown as typeof fetch
    const updater = new Updater({ home, entry: join(fakePackage(), 'lib/cli.mjs'), env: {}, fetch: fetchImpl, desktop: true, platform: 'win32', arch: 'x64' })
    return { calls, home, updater }
  }

  it('picks the installer this app updates from', () => {
    expect(installerPattern('darwin', 'arm64')?.test('nuonuo-1.0.0-mac-arm64.zip')).toBe(true)
    expect(installerPattern('darwin', 'arm64')?.test('nuonuo-1.0.0-mac-arm64.dmg')).toBe(false)
    expect(installerPattern('win32', 'x64')?.test('nuonuo-1.0.0-win-x64-setup.exe')).toBe(true)
    expect(installerPattern('win32', 'x64')?.test('nuonuo-1.0.0-win-x64.zip')).toBe(false)
    expect(installerPattern('linux', 'x64')).toBeNull()
  })

  it('downloads the installer, checks its digest, stages it, and still has it after a restart', async () => {
    const { updater, home, calls } = make()
    const checked = await updater.check()
    expect(checked).toMatchObject({ install: 'desktop', canUpdate: true, available: true, latest: { installer: { name: setup, digest: sha } } })
    const s = await updater.fetchDesktop()
    expect(calls).toContain(`https://dl/${setup}`)
    expect(s.download).toMatchObject({ state: 'ready', tag: 'v99.0.0', received: payload.length, size: payload.length })
    expect(readFileSync(s.download!.path!)).toEqual(payload)
    const again = new Updater({ home, entry: join(fakePackage(), 'lib/cli.mjs'), env: {}, desktop: true, platform: 'win32', arch: 'x64' })
    expect(again.status().download).toMatchObject({ state: 'ready', path: s.download!.path })
  })

  it('throws away a download whose digest does not match', async () => {
    const { updater } = make('sha256:0000')
    await updater.check()
    const s = await updater.fetchDesktop()
    expect(s.download).toMatchObject({ state: 'failed', error: expect.stringMatching(/校验失败/) })
    expect(existsSync(join(updater.status().download!.path ?? '/nonexistent'))).toBe(false)
  })

  it('starts the download when asked to update', async () => {
    const { updater } = make()
    const s = await updater.update()
    expect(s.download?.state).toBe('downloading')
    await updater.fetchDesktop()
    expect(updater.status().download?.state).toBe('ready')
  })

  it('cleans up a staged download once that version is running', () => {
    const home = mkdtempSync(join(tmpdir(), 'sa-home-'))
    mkdirSync(join(home, 'updates/v0.0.1'), { recursive: true })
    writeFileSync(join(home, 'updates/v0.0.1/x.exe'), '')
    writeFileSync(join(home, 'updates/ready.json'), JSON.stringify({ state: 'ready', tag: 'v0.0.1', version: '0.0.1', received: 0, size: 0, path: join(home, 'updates/v0.0.1/x.exe') }))
    const updater = new Updater({ home, entry: join(fakePackage(), 'lib/cli.mjs'), env: {}, desktop: true, platform: 'win32', arch: 'x64' })
    expect(updater.status().download).toBeNull()
    expect(existsSync(join(home, 'updates'))).toBe(false)
  })
})

describe('update settings', () => {
  it('keeps the choices on disk, and the beta channel reads the newest release including pre-releases', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify([
        { tag_name: 'v99.1.0-beta.1', html_url: 'u', draft: true, assets: [] },
        { tag_name: 'v99.0.0-beta.2', html_url: 'u', assets: [{ name: `nuonuo-99.0.0-beta.2-linux-${process.arch}.tar.gz` }] },
      ]))
    }) as unknown as typeof fetch
    const home = mkdtempSync(join(tmpdir(), 'sa-home-'))
    const updater = new Updater({ home, entry: join(fakePackage(), 'lib/cli.mjs'), env: {}, fetch: fetchImpl })
    expect(updater.status().prefs).toEqual({ auto: true, channel: 'stable', install: true })
    updater.setPrefs({ channel: 'beta', install: false })
    const s = await updater.check()
    expect(calls[0]).toBe('https://api.github.com/repos/cyDione/nuonuo/releases?per_page=15')
    expect(s.latest?.tag).toBe('v99.0.0-beta.2')
    expect(new Updater({ home, entry: join(fakePackage(), 'lib/cli.mjs'), env: {} }).status().prefs).toEqual({ auto: true, channel: 'beta', install: false })
  })
})

describe('runsAsService', () => {
  const cgroup = (text: string) => { const f = join(mkdtempSync(join(tmpdir(), 'sa-cg-')), 'cgroup'); writeFileSync(f, text); return f }
  it('is true for the unit (by its variable, or by its cgroup for units from older versions)', () => {
    expect(runsAsService({ NUONUO_SERVICE: '1' }, '/nonexistent')).toBe(true)
    expect(runsAsService({}, cgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/nuonuo.service\n'))).toBe(true)
  })
  it('is false in a terminal, even one GNOME Terminal runs as a systemd service (INVOCATION_ID set)', () => {
    const terminal = cgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope\n')
    expect(runsAsService({ INVOCATION_ID: 'abc' }, terminal)).toBe(false)
    expect(runsAsService({}, '/nonexistent')).toBe(false)
  })
})
