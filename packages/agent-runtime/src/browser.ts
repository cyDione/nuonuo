/**
 * The agent's browser (Grok Bot's "agent with a computer", on the owner's own machine): one persistent Chromium profile,
 * so a site the owner logged into once stays logged in for every task; one page per task.
 *
 * Handoff: when a page needs the owner (login, 2FA, captcha, payment), the worker asks, and the owner operates the same page
 * from the web UI — a live screenshot they click and type into — then hands it back. That works on a headless machine and
 * from a phone alike.
 */
import { tool } from 'ai'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Blobs } from './blobs'

type Context = import('playwright-core').BrowserContext
type Page = import('playwright-core').Page

const CANDIDATES = [
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

export async function findBrowser(): Promise<string | undefined> {
  if (process.env.SUPER_ASSISTANT_BROWSER) return process.env.SUPER_ASSISTANT_BROWSER
  try {
    const { chromium } = await import('playwright-core')
    const bundled = chromium.executablePath()
    if (bundled && existsSync(bundled)) return bundled
  } catch { /* not installed for this version */ }
  return CANDIDATES.find(p => existsSync(p))
}

/** Marks visible interactive elements with refs and returns a compact text view of the page. */
const SNAPSHOT_SCRIPT = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const nodes = [...document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [contenteditable=true]')].filter(visible)
  let n = 0
  const items = nodes.slice(0, 200).map(el => {
    const ref = 'e' + (++n)
    el.setAttribute('data-sa-ref', ref)
    const tag = el.tagName.toLowerCase()
    const type = el.getAttribute('type')
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
    const extra = tag === 'a' ? ' -> ' + (el.getAttribute('href') || '').slice(0, 100) : ''
    return '[' + ref + '] ' + tag + (type ? '[' + type + ']' : '') + ' "' + label + '"' + extra
  })
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
  return { title: document.title, url: location.href, items, text }
})()`

export class BrowserManager {
  private context?: Promise<Context>
  private pages = new Map<string, Page>()
  /** Tasks whose page the owner is operating right now. */
  readonly handoffs = new Set<string>()

  constructor(private profileDir: string, private executablePath?: () => Promise<string | undefined>) {}

  private async ctx(): Promise<Context> {
    if (!this.context) {
      this.context = (async () => {
        const { chromium } = await import('playwright-core')
        const executablePath = await (this.executablePath ?? findBrowser)()
        if (!executablePath) throw new Error('找不到可用的 Chromium/Chrome。安装 Google Chrome，或设置 SUPER_ASSISTANT_BROWSER 指向浏览器可执行文件')
        mkdirSync(this.profileDir, { recursive: true })
        const context = await chromium.launchPersistentContext(this.profileDir, {
          executablePath, headless: true, viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
          args: ['--no-first-run', '--no-default-browser-check'],
        })
        context.on('close', () => { this.context = undefined; this.pages.clear() })
        return context
      })()
      this.context.catch(() => { this.context = undefined })
    }
    return this.context
  }

  async page(ticketId: string): Promise<Page> {
    const existing = this.pages.get(ticketId)
    if (existing && !existing.isClosed()) return existing
    const page = await (await this.ctx()).newPage()
    this.pages.set(ticketId, page)
    page.on('close', () => { if (this.pages.get(ticketId) === page) this.pages.delete(ticketId) })
    return page
  }

  hasPage(ticketId: string): boolean {
    const page = this.pages.get(ticketId)
    return Boolean(page && !page.isClosed())
  }

  async snapshot(ticketId: string, blobs?: Blobs): Promise<string> {
    const page = await this.page(ticketId)
    const s = await page.evaluate(SNAPSHOT_SCRIPT) as { title: string; url: string; items: string[]; text: string }
    const text = blobs ? blobs.spill('page-text', s.text, 6_000) : s.text.slice(0, 6_000)
    return `页面：${s.title}\n地址：${s.url}\n\n可操作元素（用 ref 点击或输入）：\n${s.items.join('\n') || '（无）'}\n\n正文：\n${text}`
  }

  async screenshot(ticketId: string, opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return (await this.page(ticketId)).screenshot({ type: 'png', fullPage: Boolean(opts.fullPage) })
  }

  /** The owner's input during a handoff: a click at a point of the screenshot, typed text, a key, or a new address. */
  async input(ticketId: string, action: { type: 'click'; x: number; y: number } | { type: 'type'; text: string } | { type: 'key'; key: string } | { type: 'goto'; url: string } | { type: 'scroll'; dy: number }) {
    const page = await this.page(ticketId)
    if (action.type === 'click') await page.mouse.click(action.x, action.y)
    else if (action.type === 'type') await page.keyboard.type(action.text, { delay: 20 })
    else if (action.type === 'key') await page.keyboard.press(action.key)
    else if (action.type === 'scroll') await page.mouse.wheel(0, action.dy)
    else await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {})
    return { url: page.url(), title: await page.title().catch(() => '') }
  }

  async closePage(ticketId: string): Promise<void> {
    await this.pages.get(ticketId)?.close().catch(() => {})
    this.pages.delete(ticketId)
    this.handoffs.delete(ticketId)
  }

  async close(): Promise<void> {
    const context = this.context
    this.context = undefined
    this.pages.clear()
    if (context) await (await context).close().catch(() => {})
  }

  /** The worker's browser tools for one task. */
  tools(ticketId: string, workspace: string, blobs: Blobs, requestHandoff: (reason: string) => void) {
    const guard = () => { if (this.handoffs.has(ticketId)) throw new Error('主人正在操作这个页面，等交还后再继续') }
    return {
      browser_open: tool({
        description: 'Open a URL in your browser tab (a persistent profile: sites the owner logged into stay logged in). Returns the page text and its interactive elements with refs.',
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => {
          guard()
          const page = await this.page(ticketId)
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
          return this.snapshot(ticketId, blobs)
        },
      }),
      browser_snapshot: tool({
        description: 'Read the current page again: text and interactive elements with refs.',
        inputSchema: z.object({}),
        execute: async () => this.snapshot(ticketId, blobs),
      }),
      browser_click: tool({
        description: 'Click an element by its ref from the latest snapshot.',
        inputSchema: z.object({ ref: z.string().regex(/^e\d+$/) }),
        execute: async ({ ref }) => {
          guard()
          const page = await this.page(ticketId)
          await page.click(`[data-sa-ref="${ref}"]`, { timeout: 10_000 })
          await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
          return this.snapshot(ticketId, blobs)
        },
      }),
      browser_type: tool({
        description: 'Type into an input by its ref (replacing its value); submit presses Enter afterwards. Never type passwords or payment details: ask for a handoff instead.',
        inputSchema: z.object({ ref: z.string().regex(/^e\d+$/), text: z.string(), submit: z.boolean().optional() }),
        execute: async ({ ref, text, submit }) => {
          guard()
          const page = await this.page(ticketId)
          await page.fill(`[data-sa-ref="${ref}"]`, text, { timeout: 10_000 })
          if (submit) { await page.press(`[data-sa-ref="${ref}"]`, 'Enter'); await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {}) }
          return this.snapshot(ticketId, blobs)
        },
      }),
      browser_screenshot: tool({
        description: 'Save a screenshot of the current page into the working directory and return its path (for reports and verification).',
        inputSchema: z.object({ name: z.string().regex(/^[\w-]{1,40}$/).optional(), full_page: z.boolean().optional() }),
        execute: async ({ name, full_page }) => {
          const dir = join(workspace, 'screenshots')
          mkdirSync(dir, { recursive: true })
          const file = join(dir, `${name ?? `shot-${Date.now()}`}.png`)
          const { writeFileSync } = await import('node:fs')
          writeFileSync(file, await this.screenshot(ticketId, { fullPage: Boolean(full_page) }))
          return `已保存 ${file}`
        },
      }),
      request_handoff: tool({
        description: 'Ask the owner to take over your browser tab (to log in, pass 2FA or a captcha, or confirm a payment). They operate the same page from the web UI and hand it back; you are woken then. End your turn after calling this.',
        inputSchema: z.object({ reason: z.string().min(4).describe('What the owner should do, in Chinese') }),
        execute: async ({ reason }) => {
          if (!this.hasPage(ticketId)) throw new Error('先用 browser_open 打开需要主人操作的页面')
          requestHandoff(reason)
          return { ok: true, note: '已请求主人接管，这就是本轮的汇报：不要再调用 report，直接结束本轮；交还后你会收到消息。' }
        },
      }),
    }
  }
}
