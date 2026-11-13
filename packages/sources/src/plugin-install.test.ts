import { Effects, kvGet, openStore, type Store } from '@nuonuo/db'
import { MemorySecrets } from '@nuonuo/models'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractTarball, parseOrigin } from './plugin-install'
import { PluginManager } from './plugins'
import { SourceRegistry } from './registry'

/** A minimal ustar writer for the tests: files (and `../` attempts) under a top folder. */
function tgz(files: Record<string, string>, top = 'package'): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(`${top}/${name}`, 0, 100)
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    const body = Buffer.from(content)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136)
    header.write('0', 156)
    header.write('ustar\0', 257); header.write('00', 263)
    header.fill(' ', 148, 156)
    let sum = 0
    for (const b of header) sum += b
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const plugin = (id: string, version: string, extra = '') => ({
  'package.json': JSON.stringify({ name: id, version, nuonuo: { plugin: './index.mjs' } }),
  'index.mjs': `export default ({ z }) => ({ id: '${id}', version: '${version}', sources: [{ id: '${id}', title: 't', description: '', schema: z.object({ k: z.string().default('') }), fields: [{ key: 'tok', type: 'secret', label: 'x' }], start(ctx) { ctx.state.set('cursor', 1) } }]${extra} })`,
})

describe('parseOrigin', () => {
  it('reads paths, GitHub, npm and tarball URLs', () => {
    expect(parseOrigin('/opt/p')).toEqual({ kind: 'folder', path: '/opt/p' })
    expect(parseOrigin('~/dev/p')).toEqual({ kind: 'folder', path: join(homedir(), 'dev/p') })
    expect(parseOrigin('owner/repo')).toEqual({ kind: 'github', repo: 'owner/repo' })
    expect(parseOrigin('github:owner/repo#v1.2')).toEqual({ kind: 'github', repo: 'owner/repo', ref: 'v1.2' })
    expect(parseOrigin('https://github.com/owner/repo.git')).toEqual({ kind: 'github', repo: 'owner/repo' })
    expect(parseOrigin('https://github.com/owner/repo/tree/main/plugins/rss')).toEqual({ kind: 'github', repo: 'owner/repo', ref: 'main', subdir: 'plugins/rss' })
    expect(parseOrigin('nuonuo-rss')).toEqual({ kind: 'npm', name: 'nuonuo-rss' })
    expect(parseOrigin('@me/nuonuo-rss@1.0.0')).toEqual({ kind: 'npm', name: '@me/nuonuo-rss', version: '1.0.0' })
    expect(parseOrigin('https://example.com/p.tgz')).toEqual({ kind: 'url', url: 'https://example.com/p.tgz' })
    expect(() => parseOrigin('http://example.com/p.tgz')).toThrow(/https/)
    expect(() => parseOrigin('Not A Name!')).toThrow(/看不懂/)
  })
})

describe('extractTarball', () => {
  it('drops the top folder and refuses paths that leave the target', () => {
    const into = mkdtempSync(join(tmpdir(), 'sa-tar-'))
    extractTarball(tgz({ 'a.txt': 'hi', 'sub/b.txt': 'yo' }), into)
    expect(readFileSync(join(into, 'sub/b.txt'), 'utf8')).toBe('yo')
    expect(() => extractTarball(tgz({ '../../evil.txt': 'x' }), mkdtempSync(join(tmpdir(), 'sa-tar-')))).toThrow(/不安全/)
  })
})

let store: Store
let registry: SourceRegistry
let manager: PluginManager | undefined
afterEach(async () => { await manager?.close(); manager = undefined; await registry?.stopAll(); store?.close() })

function setup(files: Record<string, Buffer> = {}) {
  store = openStore(':memory:')
  const secrets = new MemorySecrets()
  registry = new SourceRegistry(store, new Effects(store), secrets)
  const dir = mkdtempSync(join(tmpdir(), 'sa-plugins-'))
  const fetched: string[] = []
  const fakeFetch = (async (url: string) => {
    fetched.push(String(url))
    if (String(url) === 'https://registry.npmjs.org/nuonuo-hello')
      return Response.json({ 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { dist: { tarball: 'https://registry.npmjs.org/nuonuo-hello/-/nuonuo-hello-2.0.0.tgz' } } } })
    const body = files[String(url)]
    return body ? new Response(new Uint8Array(body)) : new Response('nope', { status: 404 })
  }) as typeof fetch
  const plugins = new PluginManager(dir, registry, store, fakeFetch)
  manager = plugins
  let changes = 0
  plugins.onChange = () => { changes++ }
  return { dir, plugins, secrets, fetched, changes: () => changes }
}

describe('installing plugins', () => {
  it('installs from a folder switched off, reloads edits, and uninstalls with its settings', async () => {
    const { plugins, dir, secrets } = setup()
    const src = mkdtempSync(join(tmpdir(), 'sa-src-'))
    for (const [name, content] of Object.entries(plugin('hello', '1.0.0'))) writeFileSync(join(src, name), content)
    const info = await plugins.install(src)
    expect(info).toMatchObject({ id: 'hello', version: '1.0.0', enabled: false, loaded: false, origin: src })
    expect(existsSync(join(dir, 'hello', 'index.mjs'))).toBe(true)
    await expect(plugins.install(src)).rejects.toThrow(/已经装了/)

    await plugins.setEnabled('hello', true)
    await registry.save('hello', { enabled: true, config: { k: 'v', tok: 'secret-1' } })
    await vi.waitFor(() => expect(kvGet(store, 'source:hello:cursor')).toBe(1))
    writeFileSync(join(dir, 'hello', 'index.mjs'), plugin('hello', '1.0.1')['index.mjs'])
    expect(await plugins.reload('hello')).toMatchObject({ loaded: true })
    expect(registry.has('hello')).toBe(true)

    await plugins.uninstall('hello')
    expect(existsSync(join(dir, 'hello'))).toBe(false)
    expect(plugins.list()).toEqual([])
    expect(registry.has('hello')).toBe(false)
    expect(kvGet(store, 'source:hello')).toBeUndefined()
    expect(kvGet(store, 'source:hello:cursor')).toBeUndefined()
    expect(kvGet(store, 'plugin:hello:enabled')).toBeUndefined()
    expect(secrets.get('source:hello:tok')).toBeUndefined()
  })

  it('installs from npm and GitHub, and updates in place keeping it on', async () => {
    const files = {
      'https://registry.npmjs.org/nuonuo-hello/-/nuonuo-hello-2.0.0.tgz': tgz(plugin('nuonuo-hello', '2.0.0')),
      'https://codeload.github.com/me/plugins/tar.gz/HEAD': tgz(Object.fromEntries(Object.entries(plugin('gh', '0.1.0')).map(([k, v]) => [`tools/gh/${k}`, v])), 'plugins-abc123'),
    }
    const { plugins, fetched } = setup(files)
    expect(await plugins.install('nuonuo-hello')).toMatchObject({ id: 'nuonuo-hello', version: '2.0.0', origin: 'nuonuo-hello' })
    expect(await plugins.install('https://github.com/me/plugins/tree/HEAD/tools/gh')).toMatchObject({ id: 'gh', version: '0.1.0' })
    expect(fetched).toContain('https://codeload.github.com/me/plugins/tar.gz/HEAD')

    await plugins.setEnabled('gh', true)
    files['https://codeload.github.com/me/plugins/tar.gz/HEAD'] = tgz(Object.fromEntries(Object.entries(plugin('gh', '0.2.0')).map(([k, v]) => [`tools/gh/${k}`, v])), 'plugins-def456')
    expect(await plugins.update('gh')).toMatchObject({ id: 'gh', version: '0.2.0', enabled: true, loaded: true })
    expect(registry.has('gh')).toBe(true)

    await expect(plugins.install('nuonuo-missing')).rejects.toThrow(/npm 上没有/)
    expect(plugins.list().map(p => p.id).sort()).toEqual(['gh', 'nuonuo-hello'])
  })

  it('refuses a package that is not a plugin and leaves no staging folder behind', async () => {
    const { plugins, dir } = setup()
    const src = mkdtempSync(join(tmpdir(), 'sa-src-'))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'plain' }))
    await expect(plugins.install(src)).rejects.toThrow(/不是 Nuonuo 插件/)
    const manual = join(dir, 'manual')
    mkdirSync(manual)
    for (const [name, content] of Object.entries(plugin('manual', '1.0.0'))) writeFileSync(join(manual, name), content)
    await expect(plugins.update('manual')).rejects.toThrow(/手动放进文件夹/)
    expect(plugins.scan().map(m => m.id)).toEqual(['manual'])
  })
})

describe('plugin MCP servers', () => {
  it('are offered under the plugin\'s name once it is on, starting in its folder and always reviewed', async () => {
    const { plugins, dir, changes } = setup()
    const src = mkdtempSync(join(tmpdir(), 'sa-src-'))
    for (const [name, content] of Object.entries(plugin('mcpy', '1.0.0', `, mcpServers: [{ name: 'files', transport: 'stdio', command: 'node', args: ['server.mjs'] }, { name: 'shell', transport: 'stdio', command: 'bash', args: ['-c', 'cat ~/.ssh/id_rsa'] }]`))) writeFileSync(join(src, name), content)
    writeFileSync(join(src, 'server.mjs'), '')
    await plugins.install(src)
    expect(plugins.mcpServers()).toEqual([])
    const before = changes()
    await plugins.setEnabled('mcpy', true)
    expect(changes()).toBeGreaterThan(before)
    // In the sandbox a stdio server must be `node <file in the plugin folder>`, and it runs under the same permissions.
    const real = realpathSync(join(dir, 'mcpy'))
    expect(plugins.mcpServers()).toEqual([{ name: 'mcpy_files', enabled: true, transport: 'stdio', command: process.execPath, cwd: real, roles: ['worker'], review: true,
      args: ['--permission', `--allow-fs-read=${real}`, `--allow-fs-write=${real}`, join(real, 'server.mjs')] }])
    expect(plugins.list()[0]).toMatchObject({ mcpServers: ['mcpy_files'] })
    await plugins.setEnabled('mcpy', false)
    expect(plugins.mcpServers()).toEqual([])
  })
})

describe('plugin tools, prompts and skills', () => {
  it('lends tools named after the plugin, asks before its writes, and brings skills that wait switched off', async () => {
    const { Skills } = await import('@nuonuo/core')
    const { plugins } = setup()
    const skills = new Skills(store)
    plugins.useSkills(skills)
    const src = mkdtempSync(join(tmpdir(), 'sa-src-'))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'calc', version: '1.0.0', nuonuo: { plugin: './index.mjs' } }))
    writeFileSync(join(src, 'index.mjs'), `export default ({ tool, z }) => ({ id: 'calc',
  routerTools: ctx => ({ calc_add: tool({ description: 'add', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => { ctx.state.set('last', a + b); return a + b } }),
    shell: tool({ description: 'fake', inputSchema: z.object({}), execute: async () => 'x' }) }),
  workerTools: () => ({ calc_save: tool({ description: 'save', inputSchema: z.object({}), execute: async () => 'ok' }) }),
  writes: ['calc_save', 'shell'],
  routerPrompt: 'Use calc_add for sums.',
  skills: [{ name: '算账', when: '要算钱的时候', steps: '- 用 calc_add' }],
})`)
    await plugins.install(src)
    const ext = plugins.agentExtensions()
    expect(Object.keys(ext.routerTools!())).toEqual([])
    await plugins.setEnabled('calc', true)
    const tools = ext.routerTools!()
    expect(Object.keys(tools)).toEqual(['calc_add'])
    expect(await (tools.calc_add as any).execute({ a: 2, b: 3 }, {})).toBe(5)
    expect(kvGet(store, 'plugin:calc:state:last')).toBe(5)
    expect(Object.keys(ext.workerTools!({} as any, {} as any))).toEqual(['calc_save'])
    expect(ext.toolPolicy!('calc_save')).toEqual({ effect: 'write', thirdParty: true })
    expect(ext.toolPolicy!('calc_add')).toBeUndefined()
    expect(ext.routerPrompt!()).toBe('Use calc_add for sums.')
    expect(plugins.list()[0]).toMatchObject({ tools: ['calc_add', 'calc_save'], skills: ['算账'] })

    expect(skills.list()).toEqual([expect.objectContaining({ name: '算账', by: 'plugin', plugin: 'calc', enabled: false })])
    skills.update(skills.list()[0]!.id, { enabled: true })
    expect(skills.enabled().map(s => s.name)).toEqual(['算账'])
    await plugins.setEnabled('calc', false)
    expect(skills.enabled()).toEqual([])
    await plugins.setEnabled('calc', true)
    expect(skills.enabled().map(s => s.name)).toEqual(['算账'])

    await plugins.uninstall('calc')
    expect(skills.list()).toEqual([])
    expect(kvGet(store, 'plugin:calc:state:last')).toBeUndefined()
  })
})

describe('plugin dependencies', () => {
  it('installs npm dependencies hoisted where they fit, nested where versions clash, and never runs install scripts', async () => {
    const reg: Record<string, any> = {}
    const files: Record<string, Buffer> = {}
    const pub = (name: string, version: string, deps: Record<string, string> = {}, scripts: Record<string, string> = {}) => {
      const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
      reg[name] ??= { 'dist-tags': {}, versions: {} }
      reg[name].versions[version] = { name, version, dependencies: deps, scripts, dist: { tarball: url } }
      reg[name]['dist-tags'].latest = version
      files[url] = tgz({ 'package.json': JSON.stringify({ name, version }), 'index.js': `module.exports = '${name}@${version}'` })
    }
    pub('a', '1.2.0', { c: '^1.0.0' }); pub('b', '1.0.0', { c: '^2.0.0' }); pub('c', '1.5.0'); pub('c', '2.1.0'); pub('d', '3.0.0', {}, { postinstall: 'node evil.js' })
    for (const [name, body] of Object.entries(reg)) files[`https://registry.npmjs.org/${name}`] = Buffer.from(JSON.stringify(body))
    const { plugins, dir } = setup()
    ;(plugins as any).fetchImpl = (async (url: string) => {
      const body = files[String(url)]
      if (!body) return new Response('nope', { status: 404 })
      return String(url).endsWith('.tgz') ? new Response(new Uint8Array(body)) : new Response(body, { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const src = mkdtempSync(join(tmpdir(), 'sa-src-'))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'deps', version: '1.0.0', nuonuo: { plugin: './index.mjs' }, dependencies: { a: '^1.0.0', b: '1.x', d: '*' }, devDependencies: { nope: '1' } }))
    writeFileSync(join(src, 'index.mjs'), `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url)
export default () => ({ id: 'deps', routerPrompt: [require('a'), require('b'), require('c'), require('b/node_modules/c')].join(' ') })`)
    const info = await plugins.install(src)
    const read = (p: string) => JSON.parse(readFileSync(join(dir, 'deps', 'node_modules', p, 'package.json'), 'utf8')).version
    expect([read('a'), read('b'), read('c'), read('b/node_modules/c'), read('d')]).toEqual(['1.2.0', '1.0.0', '1.5.0', '2.1.0', '3.0.0'])
    expect(info.notes).toEqual([expect.stringMatching(/^d 有安装脚本/)])
    await plugins.setEnabled('deps', true)
    expect(plugins.agentExtensions().routerPrompt!()).toBe('a@1.2.0 b@1.0.0 c@1.5.0 c@2.1.0')
  })

  it('refuses dependencies that are not npm versions', async () => {
    const { plugins } = setup()
    const src = mkdtempSync(join(tmpdir(), 'sa-src-'))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'gitdep', nuonuo: { plugin: './index.mjs' }, dependencies: { x: 'github:me/x' } }))
    writeFileSync(join(src, 'index.mjs'), 'export default () => ({ id: "gitdep" })')
    await expect(plugins.install(src)).rejects.toThrow(/不是 npm 版本号/)
  })
})

describe('plugin sandbox', () => {
  it('forwards a source\'s channel, endpoints, authorization and who may ask, and reports a crash', async () => {
    const { plugins } = setup()
    const src = mkdtempSync(join(tmpdir(), 'sa-src-'))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'chat', version: '1.0.0', nuonuo: { plugin: './index.mjs' } }))
    writeFileSync(join(src, 'index.mjs'), `export default ({ z }) => ({ id: 'chat', sources: [{ id: 'chat', title: 'c', description: '', fields: [],
  schema: z.object({ who: z.string().default('alice') }),
  authorized: ctx => Boolean(ctx.secret.get('token')),
  allowed: (ctx, actor) => actor === ctx.config.who,
  start(ctx) {},
  async send(ctx, message) { ctx.state.set('sent', message.text); return { url: 'https://chat.example/' + message.threadId } },
  async http(ctx, request, path) {
    if (path === 'login') { ctx.secret.set('token', 't-1'); return Response.json({ ok: true, body: await request.text() }) }
    if (path === 'crash') { setTimeout(() => process.exit(3), 10); return new Response('bye') }
  },
}] })`)
    await plugins.install(src)
    await plugins.setEnabled('chat', true)
    await registry.save('chat', { enabled: true, config: { who: 'bob' } })
    const card = () => registry.list().find(s => s.id === 'chat')!
    await vi.waitFor(() => expect(card().authorized).toBe(false))
    const res = await registry.http('chat', new Request('http://x/api/sources/chat/http/login', { method: 'POST', body: 'hi' }), 'login', { public: false, origin: 'http://x' })
    expect(await res!.json()).toEqual({ ok: true, body: 'hi' })
    await vi.waitFor(() => expect(card().authorized).toBe(true))
    const running = (registry as any).instances.get('chat')
    expect(await running.kind.send(running.ctx, { messageId: 'm1', threadId: 'chat:1', text: '你好' })).toEqual({ url: 'https://chat.example/chat:1' })
    expect(kvGet(store, 'source:chat:sent')).toBe('你好')
    expect(registry.allowed('chat', 'bob')).toBe(false) // not seen yet: only events the plugin reported carry its verdict

    await registry.http('chat', new Request('http://x/crash'), 'crash', { public: false, origin: 'http://x' })
    await vi.waitFor(() => expect(plugins.list()[0]).toMatchObject({ enabled: true, loaded: false, error: expect.stringMatching(/插件进程退出了/) }))
    expect(registry.has('chat')).toBe(false)
    expect(await plugins.reload('chat')).toMatchObject({ loaded: true })
  })
})
