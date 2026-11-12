import { Effects, openStore, type Store } from '@nuonuo/db'
import { MemorySecrets } from '@nuonuo/models'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginManager } from './plugins'
import { SourceRegistry } from './registry'

let store: Store | undefined
let manager: PluginManager | undefined
afterEach(async () => { await manager?.close(); manager = undefined; store?.close(); store = undefined })

function setup(sandbox: boolean) {
  store = openStore(':memory:')
  const registry = new SourceRegistry(store, new Effects(store), new MemorySecrets())
  const dir = mkdtempSync(join(tmpdir(), 'nn-inline-'))
  manager = new PluginManager(dir, registry, store, { sandbox })
  return { dir, plugins: manager }
}

describe('plugin inlineContext', () => {
  it('skips a plugin that answers too slowly or throws, and keeps the others', async () => {
    const { dir, plugins } = setup(false)
    const write = (id: string, body: string) => {
      mkdirSync(join(dir, id))
      writeFileSync(join(dir, id, 'package.json'), JSON.stringify({ name: id, nuonuo: { plugin: './index.mjs' } }))
      writeFileSync(join(dir, id, 'index.mjs'), `export default { id: '${id}', ${body} }`)
    }
    write('slow', `inlineContext: () => new Promise(r => setTimeout(() => r('late'), 5000))`)
    write('broken', `inlineContext: () => { throw new Error('boom') }`)
    write('fine', `inlineContext: (_ctx, input) => 'saw ' + input.text + ' in ' + input.scope`)
    for (const id of ['slow', 'broken', 'fine']) await plugins.setEnabled(id, true)
    const started = Date.now()
    expect(await plugins.agentExtensions().inlineContext!('hi', 'proj')).toBe('saw hi in proj')
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
