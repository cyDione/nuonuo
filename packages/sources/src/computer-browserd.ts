/**
 * The browser service that runs inside a cloud computer (see computer.ts). It is copied there when the computer is set
 * up and started on demand by `browser.sh`. It keeps several Chromium profiles open at once, each its own set of logins
 * (a "browser"), with named tabs in each, so different tasks (or one task comparing sites) work side by side. It listens
 * on 127.0.0.1 only and asks for the token written next to it, so other accounts on the machine cannot drive it.
 *
 * Plain JavaScript in a string: it runs with the computer's own Node and the playwright-core installed next to it.
 * No backticks or `${` inside, so the string stays literal.
 */
export const BROWSERD_SOURCE = String.raw`// nuonuo browser service: written by nuonuo, replaced when nuonuo updates it.
import { createServer } from 'node:http'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const dir = new URL('.', import.meta.url).pathname
const token = readFileSync(join(dir, 'token'), 'utf8').trim()
const SNAPSHOT = readFileSync(join(dir, 'snapshot.js'), 'utf8')
const PORT = Number(process.env.NUONUO_BROWSER_PORT || 47831)
const IDLE_MS = 20 * 60_000
const CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium']
const executable = () => process.env.NUONUO_CHROMIUM || CANDIDATES.find(p => existsSync(p)) || (() => { try { const p = chromium.executablePath(); return existsSync(p) ? p : undefined } catch { return undefined } })()

/** name -> { context: Promise<BrowserContext>, tabs: Map<name, Page>, used } */
const browsers = new Map()
const NAME = /^[\w.-]{1,40}$/

function browser(name) {
  if (!NAME.test(name)) throw new Error('浏览器名只能用字母、数字、-、_、.，最多 40 个字符')
  let b = browsers.get(name)
  if (!b) {
    const path = executable()
    if (!path) throw new Error('云电脑上没有 Chromium：用 shell 装一个（例如 sudo apt-get install -y chromium），或设置 NUONUO_CHROMIUM')
    const profile = join(dir, 'browsers', name)
    mkdirSync(profile, { recursive: true })
    b = { tabs: new Map(), used: Date.now(), context: chromium.launchPersistentContext(profile, {
      executablePath: path, headless: process.env.NUONUO_BROWSER_HEADED !== '1', viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
      args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage'],
    }) }
    b.context.then(ctx => ctx.on('close', () => { if (browsers.get(name) === b) browsers.delete(name) }), () => { if (browsers.get(name) === b) browsers.delete(name) })
    browsers.set(name, b)
  }
  b.used = Date.now()
  return b
}

async function tab(bname, tname, create) {
  if (!NAME.test(tname)) throw new Error('标签页名只能用字母、数字、-、_、.，最多 40 个字符')
  const b = browser(bname)
  const ctx = await b.context
  let page = b.tabs.get(tname)
  if (page && !page.isClosed()) return page
  if (!create) throw new Error('浏览器 ' + bname + ' 里没有标签页 ' + tname + '，先用 browser_open 打开')
  // A fresh profile opens with one blank page: use it for the first tab instead of leaving it around.
  const blank = b.tabs.size === 0 ? ctx.pages().find(p => p.url() === 'about:blank' && ![...b.tabs.values()].includes(p)) : undefined
  page = blank || await ctx.newPage()
  b.tabs.set(tname, page)
  page.on('close', () => { if (b.tabs.get(tname) === page) b.tabs.delete(tname) })
  return page
}

async function snapshot(page) {
  const s = await page.evaluate(SNAPSHOT)
  return { title: s.title, url: s.url, items: s.items, text: s.text }
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
}

const ops = {
  async open(r) {
    const page = await tab(r.browser, r.tab, true)
    await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await settle(page)
    return { page: await snapshot(page) }
  },
  async snapshot(r) { return { page: await snapshot(await tab(r.browser, r.tab, false)) } },
  async click(r) {
    const page = await tab(r.browser, r.tab, false)
    await page.click('[data-sa-ref="' + r.ref + '"]', { timeout: 10_000 })
    await settle(page)
    return { page: await snapshot(page) }
  },
  async type(r) {
    const page = await tab(r.browser, r.tab, false)
    const sel = '[data-sa-ref="' + r.ref + '"]'
    await page.fill(sel, String(r.text), { timeout: 10_000 })
    if (r.submit) { await page.press(sel, 'Enter'); await settle(page) }
    return { page: await snapshot(page) }
  },
  async press(r) {
    const page = await tab(r.browser, r.tab, false)
    await page.keyboard.press(String(r.key))
    await settle(page)
    return { page: await snapshot(page) }
  },
  async scroll(r) {
    const page = await tab(r.browser, r.tab, false)
    await page.mouse.wheel(0, Number(r.dy) || 600)
    await page.waitForTimeout(300)
    return { page: await snapshot(page) }
  },
  async back(r) {
    const page = await tab(r.browser, r.tab, false)
    await page.goBack({ timeout: 15_000 }).catch(() => {})
    await settle(page)
    return { page: await snapshot(page) }
  },
  async evaluate(r) {
    const page = await tab(r.browser, r.tab, false)
    const value = await page.evaluate(String(r.expression))
    let text
    try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch { text = String(value) }
    return { value: text === undefined ? 'undefined' : text }
  },
  async screenshot(r) {
    const page = await tab(r.browser, r.tab, false)
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: Boolean(r.fullPage) })
    return { image: buf.toString('base64'), mediaType: 'image/jpeg', url: page.url(), title: await page.title().catch(() => '') }
  },
  async list() {
    const out = []
    for (const [name, b] of browsers) {
      const tabs = []
      for (const [t, page] of b.tabs) if (!page.isClosed()) tabs.push({ name: t, url: page.url(), title: await page.title().catch(() => '') })
      out.push({ name, tabs, idleSeconds: Math.round((Date.now() - b.used) / 1000) })
    }
    return { browsers: out }
  },
  async close(r) {
    const b = browsers.get(r.browser)
    if (!b) return { closed: false }
    if (r.tab) { const page = b.tabs.get(r.tab); b.tabs.delete(r.tab); await page?.close().catch(() => {}); return { closed: Boolean(page) } }
    browsers.delete(r.browser)
    await (await b.context).close().catch(() => {})
    return { closed: true }
  },
}

// Profiles nobody used for a while are closed to give the memory back; their logins stay on disk.
setInterval(async () => {
  for (const [name, b] of browsers) if (Date.now() - b.used > IDLE_MS) { browsers.delete(name); (await b.context.catch(() => undefined))?.close().catch(() => {}) }
}, 60_000).unref()

const server = createServer((req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.headers['x-token'] !== token) return reply(403, { error: 'bad token' })
  if (req.url === '/health') return reply(200, { ok: true, browsers: browsers.size })
  let raw = ''
  req.on('data', d => { raw += d })
  req.on('end', async () => {
    try {
      const r = JSON.parse(raw || '{}')
      const op = ops[r.op]
      if (!op) throw new Error('不认识的操作 ' + r.op)
      r.browser = r.browser || 'main'
      if (r.op !== 'close') r.tab = r.tab || 'main'
      reply(200, { ok: true, ...(await op(r)) })
    } catch (error) {
      reply(200, { ok: false, error: String(error && error.message || error).split('\n')[0].slice(0, 500) })
    }
  })
})
server.listen(PORT, '127.0.0.1')
process.on('SIGTERM', async () => { for (const b of browsers.values()) (await b.context.catch(() => undefined))?.close().catch(() => {}); process.exit(0) })
`

/** Starts the service when it is not answering, then hands it the request on stdin. */
export const BROWSER_SH = String.raw`#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
T="$(cat "$D/token")"
P="$NUONUO_BROWSER_PORT"; [ -z "$P" ] && P=47831
up() { curl -sf -m 2 -H "x-token: $T" "http://127.0.0.1:$P/health" >/dev/null 2>&1; }
if ! up; then
  # Everything the service inherits points at its log, so the caller's output closes when this script ends.
  (cd "$D" && exec setsid nohup node browserd.mjs) >>"$D/browserd.log" 2>&1 < /dev/null &
  for i in $(seq 1 75); do up && break; sleep 0.2; done
fi
curl -s -m 170 -H "x-token: $T" -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$P/act"
`
