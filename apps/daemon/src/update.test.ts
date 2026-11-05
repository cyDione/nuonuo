import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERSION } from './config'
import { compareVersions, detectInstall, Updater } from './update'

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
  for (const f of ['bin/super-assistant', 'runtime/node', 'lib/cli.mjs']) {
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
  const release = (tag: string, assets = [`super-assistant-${tag.slice(1)}-linux-x64.tar.gz`]) =>
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
    expect(calls[0]).toBe('https://api.github.com/repos/cyDione/super-assistant/releases/latest Bearer t')
    const again = new Updater({ home, entry: join(fakePackage(), 'lib/cli.mjs'), env: {} })
    expect(again.status().latest?.tag).toBe('v99.0.0')
  })

  it('is not available for the same version or a release without the package', async () => {
    expect((await make(release(`v${VERSION}`)).updater.check()).available).toBe(false)
    expect((await make(release('v99.0.0', [])).updater.check()).available).toBe(false)
  })

  it('explains missing access and GitHub errors instead of throwing', async () => {
    const none = make(release('v99.0.0'), 200, { PATH: '/nonexistent' })
    expect((await none.updater.check()).checkError).toMatch(/GitHub 访问/)
    expect((await make({}, 404).updater.check()).checkError).toMatch(/还没有发布/)
  })

  it('prepares install.sh from the release tag with the prefix, version and token', async () => {
    const { updater } = make(release('v99.0.0'))
    if (process.platform !== 'linux') return
    const p = await updater.prepare()
    expect(p.script).toBe('echo hi')
    expect(p.env).toMatchObject({ GITHUB_TOKEN: 't', SUPER_ASSISTANT_VERSION: 'v99.0.0', SUPER_ASSISTANT_PREFIX: updater.install.kind === 'package' ? updater.install.prefix : '' })
    await expect(make(release(`v${VERSION}`)).updater.prepare()).rejects.toThrow(/已是最新/)
  })
})
