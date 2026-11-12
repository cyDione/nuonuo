import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from './catalog'
import { LiveCatalog, parseCatalog } from './live-catalog'

const m = (id: string, release: string, extra: Record<string, unknown> = {}) =>
  ({ id, release_date: release, tool_call: true, modalities: { input: ['text'], output: ['text'] }, ...extra })

const TABLE = {
  anthropic: { models: {
    a: m('claude-old', '2025-01-01', { family: 'claude-sonnet' }),
    b: m('claude-new', '2026-11-09', { family: 'claude-sonnet', cost: { input: 2, output: 10, cache_read: 0.1 }, limit: { context: 1_000_000 } }),
    c: m('claude-mini', '2026-10-01', { family: 'claude-haiku' }),
    d: m('claude-gone', '2026-11-10', { status: 'deprecated' }),
    e: m('claude-notools', '2026-11-10', { tool_call: false }),
    f: m('claude-painter', '2026-11-10', { modalities: { output: ['image'] } }),
  } },
  deepseek: { models: { x: m('deepseek-flash', '2026-10-17') } },
  'some-other': { models: { y: m('other', '2026-01-01') } },
}

const anthropic = PROVIDER_PRESETS.find(p => p.id === 'anthropic')!
const ollama = PROVIDER_PRESETS.find(p => p.id === 'ollama')!

describe('live model table', () => {
  it('keeps the newest usable chat model of each family, newest first', () => {
    const snap = parseCatalog(TABLE, 'test', 5)
    expect(snap.providers.anthropic!.map(x => x.id)).toEqual(['claude-new', 'claude-mini'])
    expect(snap.providers.anthropic![0]).toMatchObject({ cost: { input: 2, output: 10, cacheRead: 0.1 }, context: 1_000_000 })
    expect(snap.providers.deepseek!.map(x => x.id)).toEqual(['deepseek-flash'])
    expect(Object.keys(snap.providers).sort()).toEqual(['anthropic', 'deepseek'])
  })

  it('rejects a table with nothing it knows', () => {
    expect(() => parseCatalog({ nope: {} })).toThrow()
  })

  it('fetches, caches to disk and replaces bundled suggestions', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cat-')), 'model-catalog.json')
    let calls = 0
    const fake = (async () => { calls++; return new Response(JSON.stringify(TABLE)) }) as unknown as typeof fetch
    const catalog = new LiveCatalog({ file, url: 'https://example.test/api.json', fetch: fake, now: () => 1_000 })
    expect(catalog.suggestions(anthropic)).toEqual(anthropic.suggestedModels)
    expect(catalog.stale()).toBe(true)
    await catalog.refreshIfStale()
    expect(calls).toBe(1)
    expect(catalog.suggestions(anthropic)).toEqual(['claude-new', 'claude-mini'])
    expect(catalog.suggestions(ollama)).toEqual([])
    expect(catalog.status()).toMatchObject({ live: true, fetchedAt: 1_000 })
    expect(JSON.parse(readFileSync(file, 'utf8')).providers.anthropic[0].id).toBe('claude-new')
    await catalog.refreshIfStale()
    expect(calls).toBe(1)
    // A new process reads the cache without fetching.
    const again = new LiveCatalog({ file, url: 'https://example.test/api.json', fetch: fake, now: () => 2_000 })
    expect(again.presets().find(p => p.id === 'anthropic')!.suggestedModels).toEqual(['claude-new', 'claude-mini'])
  })

  it('keeps the last snapshot when a fetch fails, and can be turned off', async () => {
    let ok = true
    const fake = (async () => (ok ? new Response(JSON.stringify(TABLE)) : new Response('down', { status: 503 }))) as unknown as typeof fetch
    const catalog = new LiveCatalog({ url: 'https://example.test/api.json', fetch: fake, maxAgeMs: 0 })
    await catalog.refresh()
    ok = false
    await catalog.refreshIfStale()
    expect(catalog.suggestions(anthropic)).toEqual(['claude-new', 'claude-mini'])
    expect(catalog.status().error).toContain('503')
    const off = new LiveCatalog({ url: 'off' })
    expect(off.stale()).toBe(false)
    await expect(off.refresh()).rejects.toThrow()
  })
})
