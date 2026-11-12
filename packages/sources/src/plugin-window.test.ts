import { Effects, openStore, type Store } from '@nuonuo/db'
import { MemorySecrets } from '@nuonuo/models'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSettings, readWindow } from './plugin-window'
import { PluginManager } from './plugins'
import { SECRET_SET, SourceRegistry } from './registry'

let store: Store | undefined
let manager: PluginManager | undefined
afterEach(async () => { await manager?.close(); manager = undefined; store?.close(); store = undefined })

function setup(sandbox: boolean) {
  store = openStore(':memory:')
  const secrets = new MemorySecrets()
  const registry = new SourceRegistry(store, new Effects(store), secrets)
  const dir = mkdtempSync(join(tmpdir(), 'nn-window-'))
  manager = new PluginManager(dir, registry, store, { sandbox })
  cpSync(join(__dirname, '../../../examples/plugins/notes'), join(dir, 'notes'), { recursive: true })
  return { dir, secrets, plugins: manager }
}

describe('plugin settings and window', () => {
  it('reads the form and window from the manifest, before the code runs', () => {
    const { plugins } = setup(false)
    const info = plugins.list().find(p => p.id === 'notes')!
    expect(info).toMatchObject({ loaded: false, window: { page: 'ui/index.html', title: '便签', width: 420, height: 520 } })
    expect(info.settings!.map(f => f.key)).toEqual(['shareWithAgent', 'limit'])
    expect(plugins.settingsOf('notes').values).toEqual({ shareWithAgent: false, limit: 20 })
  })

  for (const sandbox of [false, true]) {
    it(`saves settings, answers window calls and serves only the window's files${sandbox ? ' (sandboxed)' : ''}`, async () => {
      const { plugins } = setup(sandbox)
      await expect(plugins.windowCall('notes', 'list', null)).rejects.toThrow('插件没开')
      await plugins.setEnabled('notes', true)
      await plugins.saveSettings('notes', { limit: 2, shareWithAgent: true, unknown: 'x' })
      expect(plugins.settingsOf('notes').values).toEqual({ shareWithAgent: true, limit: 2 })
      await plugins.windowCall('notes', 'add', { text: '买牛奶' })
      await plugins.windowCall('notes', 'add', { text: '回邮件' })
      const third = await plugins.windowCall('notes', 'add', { text: '订机票' }) as { notes: { text: string }[] }
      expect(third.notes.map(n => n.text)).toEqual(['订机票', '回邮件'])
      await expect(plugins.windowCall('notes', 'add', { text: ' ' })).rejects.toThrow('便签是空的')
      await expect(plugins.windowCall('notes', 'nope', null)).rejects.toThrow('没有「nope」')
      expect(plugins.agentExtensions().routerPrompt!()).toContain('- 订机票')

      expect(plugins.windowFile('notes', '')!.type).toContain('text/html')
      expect(plugins.windowFile('notes', 'app.js')!.body.toString()).toContain('nuonuo.call')
      expect(plugins.windowFile('notes', '../index.mjs')).toBeUndefined()
      expect(plugins.windowFile('notes', '../package.json')).toBeUndefined()
    })
  }

  it('keeps secrets in the secret store and shows them only as set', async () => {
    const { dir, secrets, plugins } = setup(false)
    mkdirSync(join(dir, 'keyed'))
    writeFileSync(join(dir, 'keyed', 'package.json'), JSON.stringify({ name: 'keyed', nuonuo: { plugin: './index.mjs', settings: [{ key: 'token', label: '令牌', type: 'secret' }, { key: 'mode', label: '模式', type: 'select', options: ['a', 'b'] }] } }))
    writeFileSync(join(dir, 'keyed', 'index.mjs'), `export default { id: 'keyed', windowCalls: { peek: ctx => ({ token: ctx.settings.get('token'), mode: ctx.settings.get('mode') }) } }`)
    await plugins.setEnabled('keyed', true)
    await plugins.saveSettings('keyed', { token: 's3cret', mode: 'b' })
    expect(plugins.settingsOf('keyed').values).toEqual({ token: SECRET_SET, mode: 'b' })
    expect(JSON.stringify(store!.db.select().from((await import('@nuonuo/db')).schema.kv).all())).not.toContain('s3cret')
    expect(await plugins.windowCall('keyed', 'peek', null)).toEqual({ token: 's3cret', mode: 'b' })
    await plugins.saveSettings('keyed', { token: SECRET_SET, mode: 'a' })
    expect(secrets.get('plugin:keyed:setting:token')).toBe('s3cret')
    await expect(plugins.saveSettings('keyed', { mode: 'c' })).rejects.toThrow('没有选项「c」')
    await plugins.uninstall('keyed')
    expect(secrets.get('plugin:keyed:setting:token')).toBeUndefined()
  })

  it('refuses malformed declarations', () => {
    expect(() => readSettings([{ key: '1bad', type: 'text' }])).toThrow('不合法')
    expect(() => readSettings([{ key: 'a', type: 'select', options: [] }])).toThrow('没有选项')
    expect(() => readWindow({ page: '../outside.html' }, '/p/x')).toThrow('插件目录内')
    expect(() => readWindow({ page: 'ui/app.js' }, '/p/x')).toThrow('.html')
    expect(readWindow('ui/index.html', '/p/x')).toEqual({ page: 'ui/index.html', width: 520, height: 600 })
  })
})
