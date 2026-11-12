/**
 * The web UI cannot import the service's packages (they pull in Node), so it keeps its own copies of a few string unions.
 * This test fails when a copy drifts from the list it mirrors, instead of the UI silently showing the wrong thing.
 */
import { FEED_ICONS, LOCAL_APPS } from '@nuonuo/core'
import { MODEL_TYPES, PROVIDER_KINDS, ROLE_IDS } from '@nuonuo/models'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const web = (file: string) => readFileSync(join(import.meta.dirname, '../../web/src', file), 'utf8')
const union = (source: string, name: string) => {
  const m = source.match(new RegExp(`export type ${name} = ([^\\n]+)`))
  if (!m) throw new Error(`no type ${name}`)
  return [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]).sort()
}

describe('web UI copies of service lists', () => {
  const api = web('api.ts')
  it.each([
    ['ProviderKind', PROVIDER_KINDS],
    ['RoleId', ROLE_IDS],
    ['FeedIcon', FEED_ICONS],
    ['LocalApp', LOCAL_APPS],
  ] as const)('%s matches', (name, list) => {
    expect(union(api, name)).toEqual([...list].sort())
  })

  it('ModelType matches', () => {
    expect(union(web('settings/hooks.ts'), 'ModelType')).toEqual([...MODEL_TYPES].sort())
  })

  it('the mac_permission card uses LocalApp', () => {
    expect(web('chatparts.tsx')).toMatch(/type: 'mac_permission'; app: LocalApp/)
  })
})
