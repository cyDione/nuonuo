import { describe, expect, it } from 'vitest'
import { KINDS, PROVIDER_KINDS, PROVIDER_PRESETS } from './catalog'
import { ENV_PROVIDERS, isSecretEnvName } from './env'

describe('provider table', () => {
  it('derives env registration from the presets', () => {
    expect(ENV_PROVIDERS.map(s => s.env[0])).toEqual(PROVIDER_PRESETS.filter(p => p.env).map(p => p.env![0]))
    expect(ENV_PROVIDERS.find(s => s.env.includes('TYPESAFE_API_KEY'))).toMatchObject({ kind: 'typesafe', name: 'TypeSafe Jev', baseUrl: 'https://api.typesafe.ai/v1' })
    expect(ENV_PROVIDERS.find(s => s.env.includes('OPENAI_API_KEY'))).toMatchObject({ baseUrlEnv: 'OPENAI_BASE_URL' })
    for (const p of PROVIDER_PRESETS) for (const name of p.env ?? []) expect(isSecretEnvName(name)).toBe(true)
  })

  it('describes every kind, and every preset uses a known kind with unique ids', () => {
    expect(Object.keys(KINDS).sort()).toEqual([...PROVIDER_KINDS].sort())
    for (const p of PROVIDER_PRESETS) expect(PROVIDER_KINDS).toContain(p.kind)
    expect(new Set(PROVIDER_PRESETS.map(p => p.id)).size).toBe(PROVIDER_PRESETS.length)
    expect(PROVIDER_PRESETS.filter(p => p.firstRun).map(p => p.id)).toEqual(['anthropic', 'openai', 'custom'])
  })
})
