import { Blobs, findBrowser } from '@nuonuo/agent-runtime'
import type { Ticket } from '@nuonuo/core'
import { withShellOverride } from '@nuonuo/core'
import { openStore, type Store } from '@nuonuo/db'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computerExtension, Computers, defineComputer, type BoundComputer, type ComputerExecRequest, type ComputerExecResult, type ComputerStatus } from './computer'
import { sdk } from './plugins'

/** A "cloud computer" that is this machine: commands run in bash, nuonuo's space is a temporary folder. */
type Local = BoundComputer & { calls: string[]; state: ComputerStatus['state'] }
function localComputer(dataDir: string, extra: Partial<BoundComputer> = {}): Local {
  const self: Local = {
    id: 'local', title: '测试电脑', pluginId: 'test', calls: [] as string[], state: 'asleep' as ComputerStatus['state'],
    capabilities: { sudo: false, docker: false, sleeps: true, dataDir, maxExecSeconds: 120, env: { NUONUO_TEST_ENV: 'yes' } },
    status: async (): Promise<ComputerStatus> => ({ state: self.state }),
    wake: async (): Promise<ComputerStatus> => { self.calls.push('wake'); self.state = 'ready'; return { state: self.state } },
    exec: (req: ComputerExecRequest) => new Promise<ComputerExecResult>(done => {
      self.calls.push(req.command.slice(0, 40))
      // Like a cloud machine: no proxy of the test runner's (Chromium would send the local test page through it).
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)))
      const child = spawn('bash', ['-lc', req.command], { stdio: ['pipe', 'pipe', 'pipe'], env })
      let stdout = '', stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      child.on('close', code => done({ exitCode: code ?? -1, stdout, stderr }))
      child.stdin.end(req.stdin ?? '')
    }),
    ...extra,
  }
  return self
}

let store: Store
let blobs: Blobs
beforeAll(() => { store = openStore(':memory:'); blobs = new Blobs(store) })
afterAll(() => store?.close())

const ticket = (dir: string): Ticket => ({ id: 'tkt_test1', title: 't', threadId: 'webchat:x', stage: 'working', directory: dir } as unknown as Ticket)
const ctx = { session: { id: 'ses_1' } } as any
const run = (t: any, input: any) => t.execute(input, { toolCallId: 'x', messages: [] })

describe('Computers', () => {
  it('wakes the machine, sets up nuonuo\'s space once, and runs commands there', async () => {
    const data = mkdtempSync(join(tmpdir(), 'nn-computer-'))
    const c = localComputer(data)
    const computers = new Computers(() => [c])
    const r = await computers.start(c, 'echo hi; echo $NUONUO_TEST_ENV; pwd', { cwd: computers.taskDir(c, 'tkt_a'), waitSeconds: 10, timeoutSeconds: 60 })
    expect(c.calls[0]).toBe('wake')
    expect(r.status).toBe('exited')
    expect(r.exitCode).toBe(0)
    expect(r.output).toBe(`hi\nyes\n${join(data, 'nuonuo', 'tasks', 'tkt_a')}\n`)
    expect(readFileSync(join(data, 'nuonuo', '.computer', 'version'), 'utf8').trim()).toMatch(/^[0-9a-f]{12}$/)
    expect(existsSync(join(data, 'nuonuo', '.computer', 'browserd.mjs'))).toBe(true)
    // Ready for a minute: the next command neither wakes nor probes again.
    const before = c.calls.length
    await computers.start(c, 'true', { cwd: computers.taskDir(c, 'tkt_a'), waitSeconds: 5, timeoutSeconds: 60 })
    expect(c.calls.length - before).toBe(1)
  })

  it('moves long commands to the background and reports them when they finish', async () => {
    const data = mkdtempSync(join(tmpdir(), 'nn-computer-'))
    const c = localComputer(data)
    const computers = new Computers(() => [c])
    const r = await computers.start(c, 'echo start; sleep 2; echo end; exit 3', { cwd: computers.taskDir(c, 't'), waitSeconds: 0.5, timeoutSeconds: 60 })
    expect(r.status).toBe('running')
    expect(r.output).toContain('start')
    const done = await computers.job(c, r.id, 5)
    expect(done).toMatchObject({ status: 'exited', exitCode: 3 })
    expect(done.output).toContain('end')
    const long = await computers.start(c, 'sleep 30', { cwd: computers.taskDir(c, 't'), waitSeconds: 0, timeoutSeconds: 60 })
    expect(await computers.stopJob(c, long.id)).toBe(true)
    expect((await computers.job(c, long.id, 5)).status).not.toBe('running')
    await expect(computers.job(c, 'cjnope')).rejects.toThrow(/没有任务/)
  }, 30_000)

  it('copies files both ways in chunks', async () => {
    const data = mkdtempSync(join(tmpdir(), 'nn-computer-'))
    const work = mkdtempSync(join(tmpdir(), 'nn-work-'))
    const c = localComputer(data)
    const computers = new Computers(() => [c])
    const bytes = Buffer.alloc(600 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 256
    writeFileSync(join(work, 'in.bin'), bytes)
    const remote = join(computers.taskDir(c, 't'), 'sub', 'in.bin')
    expect(await computers.upload(c, join(work, 'in.bin'), remote)).toBe(bytes.length)
    expect(readFileSync(remote).equals(bytes)).toBe(true)
    expect(await computers.download(c, remote, join(work, 'out', 'back.bin'))).toBe(bytes.length)
    expect(readFileSync(join(work, 'out', 'back.bin')).equals(bytes)).toBe(true)
  })

  it('says why a machine cannot be used', async () => {
    const c = localComputer('/tmp', { status: async () => ({ state: 'unconfigured', detail: '填上 API key' }) })
    await expect(new Computers(() => [c]).ready(c)).rejects.toThrow('填上 API key')
    const cooling = localComputer('/tmp', { wake: async () => ({ state: 'asleep', detail: '冷却中', retryAfterSeconds: 600 }) })
    await expect(new Computers(() => [cooling]).ready(cooling)).rejects.toThrow(/冷却中.*10 分钟后再试/)
  })

  it('rejects incomplete providers', () => {
    expect(() => defineComputer({ id: 'Bad Id' } as any)).toThrow(/不合法/)
    expect(() => sdk.defineComputer({ id: 'x', title: 'X', capabilities: { dataDir: '/data', maxExecSeconds: 60 } } as any)).toThrow(/缺少 status/)
  })
})

describe('computerExtension', () => {
  const setup = (mode: 'auto' | 'local', gate?: any) => {
    const data = mkdtempSync(join(tmpdir(), 'nn-computer-'))
    const c = localComputer(data)
    const computers = new Computers(() => [c])
    const pushed: unknown[] = []
    const ext = computerExtension(computers, { blobs, mode: () => mode, limits: () => ({ foregroundSeconds: 5, timeoutMinutes: 5 }), push: (_s, p) => pushed.push(p), ...(gate ? { gate } : {}) })
    return { c, computers, ext, pushed }
  }

  it('takes over `shell` by default and keeps the local one as local_shell', async () => {
    const { ext } = setup('auto')
    const dir = mkdtempSync(join(tmpdir(), 'nn-work-'))
    const local = { shell: { description: 'Run a command' }, job_status: {}, job_stop: {} } as any
    const tools = { ...ext.workerTools!(ticket(dir), ctx), ...withShellOverride(local, ext.shellOverride(ticket(dir), ctx)) }
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['shell', 'job_status', 'job_stop', 'local_shell', 'local_job_status', 'local_job_stop', 'computer_upload', 'computer_browser_open']))
    expect(tools.local_shell!.description).toMatch(/owner's own machine/)
    expect(await run(tools.shell, { command: 'echo cloud' })).toMatch(/退出码 0\]\ncloud/)
    expect(ext.workerPrompt!(ticket(dir))).toContain('你的默认执行环境')
  })

  it('stays beside the local shell when 执行环境 is 本机', () => {
    const { ext } = setup('local')
    const dir = mkdtempSync(join(tmpdir(), 'nn-work-'))
    expect(ext.shellOverride(ticket(dir), ctx)).toBeUndefined()
    expect(Object.keys(ext.workerTools!(ticket(dir), ctx))).toEqual(expect.arrayContaining(['computer_shell', 'computer_job_status', 'computer_upload']))
    expect(ext.workerPrompt!(ticket(dir))).not.toContain('默认执行环境')
  })

  it('reviews commands first and does not run blocked or escalated ones', async () => {
    const seen: string[] = []
    const { ext, c } = setup('auto', async (_t: Ticket, _s: string, command: string, input: Record<string, unknown>) => {
      seen.push(`${command}@${input.computer}`)
      return command.includes('rm') ? { action: 'block', reason: '危险' } : { action: 'escalate', approvalId: 'apv_1', reason: '要问' }
    })
    const dir = mkdtempSync(join(tmpdir(), 'nn-work-'))
    const tools = ext.shellOverride(ticket(dir), ctx)!
    await expect(run(tools.shell, { command: 'rm -rf x' })).rejects.toThrow(/审核拦截/)
    expect(await run(tools.shell, { command: 'curl -X POST x' })).toContain('apv_1')
    expect(seen).toEqual(['rm -rf x@local', 'curl -X POST x@local'])
    expect(c.calls).toEqual([])
  })

  it('reports a background job when it ends', async () => {
    const { ext, pushed } = setup('auto')
    const dir = mkdtempSync(join(tmpdir(), 'nn-work-'))
    const tools = ext.shellOverride(ticket(dir), ctx)!
    expect(await run(tools.shell, { command: 'sleep 1; echo later', background: true })).toContain('已转入后台')
    await new Promise(r => setTimeout(r, 11_500))
    expect(pushed).toEqual([expect.objectContaining({ type: 'job', status: 'exited', exitCode: 0, output: 'later\n' })])
  }, 20_000)

  it('keeps file moves inside the local working directory', async () => {
    const { ext } = setup('auto')
    const dir = mkdtempSync(join(tmpdir(), 'nn-work-'))
    const tools = ext.workerTools!(ticket(dir), ctx)
    await expect(run(tools.computer_upload, { path: '../../etc/passwd' })).rejects.toThrow(/工作目录/)
  })

  it('has nothing to add without a computer', () => {
    const ext = computerExtension(new Computers(() => []), { blobs, mode: () => 'auto', limits: () => ({ foregroundSeconds: 5, timeoutMinutes: 5 }), push: () => {} })
    expect(ext.shellOverride(ticket('/tmp'), ctx)).toBeUndefined()
    expect(ext.workerTools!(ticket('/tmp'), ctx)).toEqual({})
    expect(ext.routerPrompt!()).toBe('')
  })
})

const chromium = await findBrowser()
describe.skipIf(!chromium)('the browser service', () => {
  let server: Server
  let base = ''
  beforeAll(async () => {
    server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.url === '/b'
      ? '<title>第二页</title><p>B 页</p>'
      : '<title>甲</title><input id="q" placeholder="搜索"><button onclick="document.title=\'点过了\'">按钮</button><a href="/b">去 B</a>'))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => server?.close())

  it('keeps several browsers and tabs open at once', async () => {
    const data = mkdtempSync(join(tmpdir(), 'nn-computer-'))
    const c = localComputer(data)
    c.capabilities.env = { NUONUO_CHROMIUM: chromium!, NUONUO_BROWSER_PORT: String(47900 + Math.floor(Math.random() * 90)) }
    const computers = new Computers(() => [c])
    await computers.ready(c)
    // The service needs playwright-core next to it; the machine would install it with npm, the test links ours.
    const pw = dirname(createRequire(pathToFileURL(join(process.cwd(), 'packages/agent-runtime/package.json'))).resolve('playwright-core/package.json'))
    mkdirSync(join(data, 'nuonuo', '.computer', 'node_modules'), { recursive: true })
    symlinkSync(pw, join(data, 'nuonuo', '.computer', 'node_modules', 'playwright-core'))
    const ext = computerExtension(computers, { blobs, mode: () => 'auto', limits: () => ({ foregroundSeconds: 5, timeoutMinutes: 5 }), push: () => {} })
    const dir = mkdtempSync(join(tmpdir(), 'nn-work-'))
    const tools = ext.workerTools!(ticket(dir), ctx)
    try {
      const a = await run(tools.computer_browser_open, { url: base })
      expect(a).toContain('页面：甲')
      expect(a).toContain('标签页 tkt_test1')
      const b = await run(tools.computer_browser_open, { url: `${base}/b`, browser: 'work', tab: 'second' })
      expect(b).toContain('B 页')
      const button = /\[(e\d+)\] button "按钮"/.exec(a)![1]
      expect(await run(tools.computer_browser_click, { ref: button })).toContain('页面：点过了')
      expect(await run(tools.computer_browser_eval, { expression: 'document.title', browser: 'work', tab: 'second' })).toBe('第二页')
      const tabs = await run(tools.computer_browser_tabs, {})
      expect(tabs).toMatch(/main：\n {2}- tkt_test1: 点过了/)
      expect(tabs).toMatch(/work：\n {2}- second: 第二页/)
      const shot = await run(tools.computer_browser_screenshot, { save: 'a' })
      expect(shot.mediaType).toBe('image/jpeg')
      expect(existsSync(join(dir, 'screenshots', 'a.jpg'))).toBe(true)
      expect(await run(tools.computer_browser_close, { browser: 'work' })).toBe('已关闭')
    } finally {
      await computers.run(c, 'pkill -f "node browserd.mjs" || true', { timeoutSeconds: 10 })
    }
  }, 60_000)
})
