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
import { BROWSERD_SOURCE } from './computer-browserd'
import { computerExtension, Computers, defineComputer, mapXdoKey, type BoundComputer, type ComputerExecRequest, type ComputerExecResult, type ComputerStatus } from './computer'
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
  }, 30_000)

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
  }, 30_000)

  it('says why a machine cannot be used', async () => {
    const c = localComputer('/tmp', { status: async () => ({ state: 'unconfigured', detail: '填上 API key' }) })
    await expect(new Computers(() => [c]).ready(c)).rejects.toThrow('填上 API key')
    const cooling = localComputer('/tmp', { wake: async () => ({ state: 'asleep', detail: '冷却中', retryAfterSeconds: 600 }) })
    await expect(new Computers(() => [cooling]).ready(cooling)).rejects.toThrow(/冷却中.*10 分钟后再试/)
  })

  it('rejects incomplete providers', () => {
    expect(() => defineComputer({ id: 'Bad Id' } as any)).toThrow(/不合法/)
    expect(() => sdk.defineComputer({ id: 'x', title: 'X', capabilities: { dataDir: '/data', maxExecSeconds: 60 } } as any)).toThrow(/缺少 status/)
    expect(BROWSERD_SOURCE).not.toContain('`')
    expect(BROWSERD_SOURCE).not.toContain('${')
  })

  it('starts the graphical desktop, cleans up legacy browserd, and drives native Chromium Web Browser + desktop GUI tools when desktop capability is enabled', async () => {
    let desktopStarts = 0
    let browserWindowOpen = false
    let browserWindowTitle = 'Sign in - Google Accounts - Chromium'
    const execs: { command: string; stdin?: string }[] = []
    let version = ''
    const c: BoundComputer = {
      id: 'desk',
      title: '桌面测试机',
      pluginId: 'test',
      capabilities: {
        sudo: true,
        docker: false,
        sleeps: false,
        dataDir: '/data',
        maxExecSeconds: 120,
        desktop: { display: ':1', width: 1280, height: 800 },
        env: { DISPLAY: ':1', NUONUO_BROWSER_HEADED: '1' },
      },
      status: async () => ({ state: 'ready' }),
      wake: async () => ({ state: 'ready' }),
      startDesktop: async () => { desktopStarts++ },
      exec: async req => {
        execs.push({ command: req.command, ...(req.stdin !== undefined ? { stdin: req.stdin } : {}) })
        if (req.command.includes('__nuonuo_ok__')) {
          return { exitCode: 0, stdout: `__nuonuo_ok__\n${version}\n`, stderr: '' }
        }
        const m = /echo ([0-9a-f]{12}) > "\$D\/version"/.exec(req.stdin ?? '')
        if (m) version = m[1]!
        if (req.command.includes('scrot -o')) {
          return { exitCode: 0, stdout: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'), stderr: '' }
        }
        if (req.command.includes('__NO_BROWSER__')) {
          browserWindowOpen = true
          return { exitCode: 0, stdout: `${browserWindowTitle}\n`, stderr: '' }
        }
        if (req.command.includes('__OPEN__')) {
          return {
            exitCode: 0,
            stdout: browserWindowOpen ? `__OPEN__\n${browserWindowTitle}\n` : '__CLOSED__\n',
            stderr: '',
          }
        }
        if (req.command.includes('windowclose')) {
          browserWindowOpen = false
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const computers = new Computers(() => [c])
    await computers.ready(c)
    expect(desktopStarts).toBe(1)
    expect(execs.some(e =>
      e.command.includes("DISPLAY=':1' xhost +SI:localuser:nuonuo") &&
      e.command.includes("'/data/nuonuo/.Xauthority'") &&
      e.command.includes('browserd.mjs|remote-debugging-pipe'),
    )).toBe(true)

    // Subsequent ensureDesktop within READY_FOR_MS does not re-run startDesktop; stale() resets it.
    await computers.ensureDesktop(c)
    expect(desktopStarts).toBe(1)
    computers.stale(c)
    await computers.ready(c)
    expect(desktopStarts).toBe(2)

    // Test Worker toolset when hasDesktop is true: no Playwright browser_snapshot/click/type/eval exposed!
    const ext = computerExtension(computers, { blobs, mode: () => 'auto', limits: () => ({ foregroundSeconds: 5, timeoutMinutes: 5 }), push: () => {} })
    const dir = mkdtempSync(join(tmpdir(), 'nn-work-'))
    const tools = ext.workerTools!(ticket(dir), ctx)
    expect(Object.keys(tools)).toEqual(expect.arrayContaining([
      'computer_browser_open',
      'computer_browser_tabs',
      'computer_browser_close',
      'computer_desktop_screenshot',
      'computer_desktop_click',
      'computer_desktop_move',
      'computer_desktop_drag',
      'computer_desktop_scroll',
      'computer_desktop_type',
      'computer_desktop_press',
    ]))
    expect(tools.computer_browser_snapshot).toBeUndefined()
    expect(tools.computer_browser_click).toBeUndefined()
    expect(tools.computer_browser_type).toBeUndefined()
    expect(tools.computer_browser_eval).toBeUndefined()
    expect(ext.workerPrompt!(ticket(dir))).toContain('Chromium Web Browser')
    expect(ext.workerPrompt!(ticket(dir))).toContain('computer_desktop_screenshot')
    expect(ext.routerPrompt!()).toContain('graphical desktop')

    // Native openDesktopBrowser, desktopBrowserStatus, handoff lock, and closeDesktopBrowser
    expect(await computers.desktopBrowserStatus(c)).toEqual({ running: false, title: '', url: '', handoff: false })
    const opened = await computers.openDesktopBrowser(c, 'https://accounts.google.com')
    expect(opened).toEqual({ running: true, title: 'Sign in - Google Accounts', url: 'https://accounts.google.com' })
    expect(execs.at(-1)!.command).not.toContain('sudo -n -u nuonuo')
    expect(execs.at(-1)!.command).toContain("setsid nohup \"$B\" -- 'https://accounts.google.com'")
    expect(await computers.desktopBrowserStatus(c)).toEqual({
      running: true,
      title: 'Sign in - Google Accounts',
      url: 'https://accounts.google.com',
      handoff: false,
    })
    expect(await run(tools.computer_browser_tabs, {})).toContain('Sign in - Google Accounts https://accounts.google.com')

    // Handoff mutex blocks AI openDesktopBrowser and desktopInput, while allowing owner actions
    computers.setDesktopHandoff(c, true)
    expect(computers.hasDesktopHandoff(c)).toBe(true)
    await expect(computers.openDesktopBrowser(c, 'https://example.com')).rejects.toThrow(/主人正在接管/)
    await expect(run(tools.computer_desktop_click, { x: 10, y: 10 })).rejects.toThrow(/主人正在接管/)
    await computers.openDesktopBrowser(c, 'https://example.com/owner', { owner: true })
    computers.setDesktopHandoff(c, false)

    expect(await run(tools.computer_browser_close, {})).toBe('已关闭')
    expect(await computers.desktopBrowserStatus(c)).toEqual({ running: false, title: '', url: '', handoff: false })

    const shot = await run(tools.computer_desktop_screenshot, { save: 'desk1' })
    expect(shot.mediaType).toBe('image/png')
    expect(readFileSync(join(dir, 'screenshots', 'desk1.png')).subarray(0, 4).toString('latin1')).toBe('\x89PNG')

    await run(tools.computer_desktop_click, { x: 320, y: 240, button: 'right', double: true })
    expect(execs.at(-1)!.command).toContain('xdotool mousemove 320 240 click --repeat 2 --delay 80 3')

    await run(tools.computer_desktop_move, { x: 100, y: 150 })
    expect(execs.at(-1)!.command).toContain('xdotool mousemove 100 150')

    await run(tools.computer_desktop_drag, { from_x: 10, from_y: 20, to_x: 300, to_y: 400 })
    expect(execs.at(-1)!.command).toContain('xdotool mousemove 10 20 mousedown 1 sleep 0.1 mousemove 300 400 sleep 0.1 mouseup 1')

    await run(tools.computer_desktop_scroll, { direction: 'down', amount: 4 })
    expect(execs.at(-1)!.command).toContain('xdotool click --repeat 4 --delay 30 5')
    await computers.desktopInput(c, { type: 'scroll', dy: -220 })
    expect(execs.at(-1)!.command).toContain('xdotool click --repeat 2 --delay 30 4')

    await run(tools.computer_desktop_type, { text: '你好 world' })
    expect(execs.at(-1)).toMatchObject({ stdin: '你好 world' })
    expect(execs.at(-1)!.command).toContain('xclip -selection clipboard')
    expect(execs.at(-1)!.command).toContain('xdotool type --delay 12 --file -')

    await run(tools.computer_desktop_press, { key: 'Control+l' })
    expect(execs.at(-1)!.command).toContain("xdotool key -- 'ctrl+l'")
    expect(mapXdoKey('Enter')).toBe('Return')
    expect(mapXdoKey('Backspace')).toBe('BackSpace')
    expect(mapXdoKey('ArrowDown')).toBe('Down')
  })

  it('probes .computer/version via sudo -n -u nuonuo so chmod 750 never re-runs setup after 60s, deduplicates concurrent ready(), and updates when capabilities.env changes', async () => {
    let clock = 1_000_000
    let version = ''
    let setupRuns = 0
    let probeRuns = 0
    const c: BoundComputer = {
      id: 'instabox',
      title: 'Instabox 云电脑',
      pluginId: 'instabox',
      capabilities: {
        sudo: true,
        docker: true,
        sleeps: true,
        dataDir: '/data',
        maxExecSeconds: 600,
        env: { INSTABOX_HEADLESS: '1' },
      },
      status: async () => ({ state: 'ready' }),
      wake: async () => ({ state: 'ready' }),
      exec: async req => {
        if (req.command.includes('__nuonuo_ok__')) {
          probeRuns++
          await new Promise(r => setTimeout(r, 15))
          // Simulate /data/nuonuo being 0750 nuonuo:nuonuo: only sudo -n -u nuonuo can read .computer/version!
          const canRead = req.command.includes('sudo -n -u nuonuo cat')
          return { exitCode: 0, stdout: `__nuonuo_ok__\n${canRead ? version : ''}\n`, stderr: '' }
        }
        const m = /echo ([0-9a-f]{12}) > "\$D\/version"/.exec(req.stdin ?? '')
        if (m) {
          setupRuns++
          version = m[1]!
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const computers = new Computers(() => [c], () => clock)

    // 1. Concurrent ready() calls share one probe + one setup
    await Promise.all([computers.ready(c), computers.ready(c), computers.ready(c)])
    expect(probeRuns).toBe(1)
    expect(setupRuns).toBe(1)
    expect(version).toMatch(/^[0-9a-f]{12}$/)

    // 2. After 60s (READY_FOR_MS), concurrent ready() re-probes with sudo -n -u nuonuo and does NOT re-run setup or pkill browserd!
    clock += 65_000
    await Promise.all([computers.ready(c), computers.ready(c)])
    expect(probeRuns).toBe(2)
    expect(setupRuns).toBe(1)

    // 3. When plugin upgrades capabilities.env / capabilities.desktop (0.1.0 -> 0.2.0), setupVersionOf(c) changes and triggers setup once
    c.capabilities = {
      ...c.capabilities,
      desktop: { display: ':1', width: 1280, height: 800 },
      env: { DISPLAY: ':1', NUONUO_BROWSER_HEADED: '1' },
    }
    clock += 65_000
    const prevVersion = version
    await computers.ready(c)
    expect(probeRuns).toBe(3)
    expect(setupRuns).toBe(2)
    expect(version).not.toBe(prevVersion)

    // 4. Subsequent 60s expiry with same 0.2.0 capabilities does not re-run setup
    clock += 65_000
    await computers.ready(c)
    expect(probeRuns).toBe(4)
    expect(setupRuns).toBe(2)
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
  }, 30_000)

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

      // Owner handoff: locks out AI actions while allowing owner input, then releases.
      const ho = await computers.browser<{ url: string; title: string; handoff: boolean }>(c, { op: 'handoff', browser: 'main', tab: 'tkt_test1' })
      expect(ho).toMatchObject({ title: '点过了', handoff: true })
      const listed = await computers.browser<{ browsers: any[] }>(c, { op: 'list' })
      expect(listed.browsers.find(x => x.name === 'main').tabs[0].handoff).toBe(true)
      await expect(run(tools.computer_browser_click, { ref: button })).rejects.toThrow(/主人正在接管/)
      const afterGoto = await computers.browser<{ url: string; title: string }>(c, {
        op: 'input', browser: 'main', tab: 'tkt_test1', owner: true, action: { type: 'goto', url: `${base}/b` },
      })
      expect(afterGoto.title).toBe('第二页')
      await computers.browser(c, { op: 'release', browser: 'main', tab: 'tkt_test1' })
      expect((await computers.browser<{ browsers: any[] }>(c, { op: 'list' })).browsers.find(x => x.name === 'main').tabs[0].handoff).toBe(false)
      expect(await run(tools.computer_browser_back, {})).toContain('按钮')

      expect(await run(tools.computer_browser_close, { browser: 'work' })).toBe('已关闭')

      // Snapshot on a non-existent browser does not spawn an empty browser instance
      await expect(computers.browser(c, { op: 'snapshot', browser: 'ghost', tab: 't1' })).rejects.toThrow(/没有标签页/)
      const afterGhost = await computers.browser<{ browsers: any[] }>(c, { op: 'list' })
      expect(afterGhost.browsers.map(x => x.name)).toEqual(['main'])

      // Blank open & input(goto) on a fresh tab create/activate smoothly
      const blankOpen = await computers.browser<{ page: { url: string } }>(c, { op: 'open', browser: 'main', tab: 'main', url: 'about:blank', owner: true })
      expect(blankOpen.page.url).toBe('about:blank')
      const gotoFresh = await computers.browser<{ url: string; title: string }>(c, {
        op: 'input', browser: 'main', tab: 'fresh_tab', owner: true, action: { type: 'goto', url: `${base}/b` },
      })
      expect(gotoFresh.title).toBe('第二页')
    } finally {
      await computers.run(c, 'pkill -f "node browserd.mjs" || true', { timeoutSeconds: 10 })
    }
  }, 60_000)
})
