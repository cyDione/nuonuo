import { openStore, type Store } from '@nuonuo/db'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Blobs } from './blobs'
import { BrowserManager, findBrowser } from './browser'

const PAGE = `<!doctype html><html><head><title>登录测试</title></head><body>
<h1>欢迎</h1><form onsubmit="event.preventDefault(); document.getElementById('out').textContent = '你好，' + document.getElementById('name').value">
<input id="name" placeholder="名字"><button type="submit">提交</button></form><p id="out"></p>
<a href="/other">另一页</a></body></html>`

let server: Server
let base = ''
let store: Store
const available = await findBrowser()

beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.url === '/other' ? '<title>另一页</title><p>第二页</p>' : PAGE))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  store = openStore(':memory:')
})
afterAll(() => { server?.close(); store?.close() })

describe.skipIf(!available)('BrowserManager', () => {
  it('opens, reads, types, clicks and screenshots; the owner can drive the same page during a handoff', async () => {
    const browser = new BrowserManager(mkdtempSync(join(tmpdir(), 'sa-profile-')))
    const workspace = mkdtempSync(join(tmpdir(), 'sa-ws-'))
    let handoff = ''
    const tools = browser.tools('tkt_a', workspace, new Blobs(store), reason => { handoff = reason })
    const run = (t: any, input: any) => t.execute(input, { toolCallId: 'x', messages: [] })
    try {
      const opened: string = await run(tools.browser_open, { url: base })
      expect(opened).toContain('页面：登录测试')
      const input = /\[(e\d+)\] input "名字"/.exec(opened)![1]
      const typed: string = await run(tools.browser_type, { ref: input, text: '小明', submit: true })
      expect(typed).toContain('你好，小明')
      const link = /\[(e\d+)\] a "另一页"/.exec(typed)![1]
      expect(await run(tools.browser_click, { ref: link })).toContain('第二页')
      expect(await run(tools.browser_screenshot, { name: 'check' })).toContain('check.png')
      expect(readdirSync(join(workspace, 'screenshots'))).toEqual(['check.png'])

      await run(tools.request_handoff, { reason: '请登录' })
      expect(handoff).toBe('请登录')
      browser.handoffs.add('tkt_a')
      await expect(run(tools.browser_open, { url: base })).rejects.toThrow(/主人正在操作/)
      // The owner drives the page: navigate, click the input, type, press Enter.
      await browser.input('tkt_a', { type: 'goto', url: base })
      await browser.input('tkt_a', { type: 'click', x: 60, y: 90 })
      const png = await browser.screenshot('tkt_a')
      expect(png.subarray(1, 4).toString()).toBe('PNG')
      browser.handoffs.delete('tkt_a')
      expect(await browser.snapshot('tkt_a')).toContain('登录测试')
    } finally {
      await browser.close()
    }
  }, 60_000)
})
