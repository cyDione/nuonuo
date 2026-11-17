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
import { execFile } from 'node:child_process'
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
/** 'browser/tab' keys currently taken over by the owner. */
const handoffs = new Set()
const NAME = /^[\w.-]{1,40}$/
const wantHeaded = () => process.env.NUONUO_BROWSER_HEADED === '1' && Boolean(process.env.DISPLAY)

function focusWindow() {
  if (!wantHeaded()) return
  try {
    execFile('sh', ['-c', 'xdotool search --onlyvisible --class "chromium|chrome" windowactivate >/dev/null 2>&1 || true'], { timeout: 3000 }, () => {})
  } catch {}
}

async function launchContext(path, profile) {
  const baseArgs = ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage']
  const headedArgs = baseArgs.concat(['--password-store=basic', '--window-position=0,0', '--window-size=1280,800'])
  const launch = headed => chromium.launchPersistentContext(profile, {
    executablePath: path, headless: !headed, viewport: { width: 1280, height: 800 }, locale: 'zh-CN',
    args: headed ? headedArgs : baseArgs,
  })
  const launchHeadless = async () => {
    const prev = process.env.INSTABOX_HEADLESS
    process.env.INSTABOX_HEADLESS = '1'
    try {
      return await launch(false)
    } finally {
      if (prev === undefined) delete process.env.INSTABOX_HEADLESS
      else process.env.INSTABOX_HEADLESS = prev
    }
  }
  if (!wantHeaded()) return launchHeadless()
  try { return await launch(true) } catch { return launchHeadless() }
}

function clearBrowserHandoffs(bname) {
  const prefix = bname + '/'
  for (const k of [...handoffs]) if (k.startsWith(prefix)) handoffs.delete(k)
}

function browser(name) {
  if (!NAME.test(name)) throw new Error('浏览器名只能用字母、数字、-、_、.，最多 40 个字符')
  let b = browsers.get(name)
  if (!b) {
    const path = executable()
    if (!path) throw new Error('云电脑上没有 Chromium：用 shell 装一个（例如 sudo apt-get install -y chromium），或设置 NUONUO_CHROMIUM')
    const profile = join(dir, 'browsers', name)
    mkdirSync(profile, { recursive: true })
    b = { tabs: new Map(), used: Date.now(), context: launchContext(path, profile) }
    b.context.then(
      ctx => ctx.on('close', () => { if (browsers.get(name) === b) { browsers.delete(name); clearBrowserHandoffs(name) } }),
      () => { if (browsers.get(name) === b) { browsers.delete(name); clearBrowserHandoffs(name) } },
    )
    browsers.set(name, b)
  }
  b.used = Date.now()
  return b
}

async function tab(bname, tname, create) {
  if (!NAME.test(bname)) throw new Error('浏览器名只能用字母、数字、-、_、.，最多 40 个字符')
  if (!NAME.test(tname)) throw new Error('标签页名只能用字母、数字、-、_、.，最多 40 个字符')
  if (!create) {
    const existing = browsers.get(bname)
    if (!existing || !existing.tabs.get(tname) || existing.tabs.get(tname).isClosed()) {
      throw new Error('浏览器 ' + bname + ' 里没有标签页 ' + tname + '，先用 browser_open 打开')
    }
    existing.used = Date.now()
    return existing.tabs.get(tname)
  }
  const b = browser(bname)
  const ctx = await b.context
  let page = b.tabs.get(tname)
  if (page && !page.isClosed()) return page
  // A fresh profile opens with one blank page: use it for the first tab instead of leaving it around.
  const blank = b.tabs.size === 0 ? ctx.pages().find(p => p.url() === 'about:blank' && ![...b.tabs.values()].includes(p)) : undefined
  page = blank || await ctx.newPage()
  b.tabs.set(tname, page)
  page.on('close', () => { if (b.tabs.get(tname) === page) { b.tabs.delete(tname); handoffs.delete(bname + '/' + tname) } })
  return page
}

function guardHandoff(r) {
  if (!r.owner && handoffs.has(r.browser + '/' + r.tab)) {
    throw new Error('主人正在接管这个页面，等交还后再继续')
  }
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
    guardHandoff(r)
    const page = await tab(r.browser, r.tab, true)
    await page.bringToFront().catch(() => {})
    focusWindow()
    if (!r.url || r.url === 'about:blank') {
      if (r.url === 'about:blank' && page.url() !== 'about:blank') {
        await page.goto('about:blank')
      }
      return { page: await snapshot(page) }
    }
    await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await settle(page)
    return { page: await snapshot(page) }
  },
  async snapshot(r) { return { page: await snapshot(await tab(r.browser, r.tab, false)) } },
  async click(r) {
    guardHandoff(r)
    const page = await tab(r.browser, r.tab, false)
    await page.click('[data-sa-ref="' + r.ref + '"]', { timeout: 10_000 })
    await settle(page)
    return { page: await snapshot(page) }
  },
  async type(r) {
    guardHandoff(r)
    const page = await tab(r.browser, r.tab, false)
    const sel = '[data-sa-ref="' + r.ref + '"]'
    await page.fill(sel, String(r.text), { timeout: 10_000 })
    if (r.submit) { await page.press(sel, 'Enter'); await settle(page) }
    return { page: await snapshot(page) }
  },
  async press(r) {
    guardHandoff(r)
    const page = await tab(r.browser, r.tab, false)
    await page.keyboard.press(String(r.key))
    await settle(page)
    return { page: await snapshot(page) }
  },
  async scroll(r) {
    guardHandoff(r)
    const page = await tab(r.browser, r.tab, false)
    await page.mouse.wheel(0, Number(r.dy) || 600)
    await page.waitForTimeout(300)
    return { page: await snapshot(page) }
  },
  async back(r) {
    guardHandoff(r)
    const page = await tab(r.browser, r.tab, false)
    await page.goBack({ timeout: 15_000 }).catch(() => {})
    await settle(page)
    return { page: await snapshot(page) }
  },
  async evaluate(r) {
    guardHandoff(r)
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
  async handoff(r) {
    const page = await tab(r.browser, r.tab, r.tab === 'main')
    handoffs.add(r.browser + '/' + r.tab)
    await page.bringToFront().catch(() => {})
    focusWindow()
    return { url: page.url(), title: await page.title().catch(() => ''), handoff: true }
  },
  async release(r) {
    handoffs.delete(r.browser + '/' + r.tab)
    return { ok: true }
  },
  async input(r) {
    const a = r.action || {}
    const page = await tab(r.browser, r.tab, a.type === 'goto')
    await page.bringToFront().catch(() => {})
    if (a.type === 'goto') focusWindow()
    if (a.type === 'click') await page.mouse.click(Number(a.x), Number(a.y), { button: a.button || 'left', clickCount: a.double ? 2 : 1 })
    else if (a.type === 'drag') {
      await page.mouse.move(Number(a.fromX), Number(a.fromY))
      await page.mouse.down()
      await page.mouse.move(Number(a.toX), Number(a.toY), { steps: 8 })
      await page.mouse.up()
    } else if (a.type === 'scroll') await page.mouse.wheel(Number(a.dx) || 0, Number(a.dy) || 0)
    else if (a.type === 'type') await page.keyboard.type(String(a.text), { delay: 15 })
    else if (a.type === 'paste') await page.keyboard.insertText(String(a.text))
    else if (a.type === 'key') await page.keyboard.press(String(a.key))
    else if (a.type === 'goto') await page.goto(String(a.url), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    else if (a.type === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    else throw new Error('不认识的输入操作 ' + a.type)
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})
    return { url: page.url(), title: await page.title().catch(() => '') }
  },
  async list() {
    const out = []
    for (const [name, b] of browsers) {
      const tabs = []
      for (const [t, page] of b.tabs) {
        if (!page.isClosed()) {
          tabs.push({ name: t, url: page.url(), title: await page.title().catch(() => ''), handoff: handoffs.has(name + '/' + t) })
        }
      }
      out.push({ name, tabs, idleSeconds: Math.round((Date.now() - b.used) / 1000) })
    }
    return { browsers: out }
  },
  async close(r) {
    const b = browsers.get(r.browser)
    if (!b) return { closed: false }
    if (r.tab) {
      handoffs.delete(r.browser + '/' + r.tab)
      const page = b.tabs.get(r.tab)
      b.tabs.delete(r.tab)
      await page?.close().catch(() => {})
      return { closed: Boolean(page) }
    }
    clearBrowserHandoffs(r.browser)
    browsers.delete(r.browser)
    await (await b.context).close().catch(() => {})
    return { closed: true }
  },
}

// Profiles nobody used for a while are closed to give the memory back; their logins stay on disk.
setInterval(async () => {
  for (const [name, b] of browsers) {
    const hasHandoff = [...handoffs].some(k => k.startsWith(name + '/'))
    if (!hasHandoff && Date.now() - b.used > IDLE_MS) {
      browsers.delete(name)
      ;(await b.context.catch(() => undefined))?.close().catch(() => {})
    }
  }
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
  (cd "$D" && if command -v setsid >/dev/null 2>&1; then exec setsid nohup node browserd.mjs; else exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- nohup node browserd.mjs; fi) >>"$D/browserd.log" 2>&1 < /dev/null &
  for i in $(seq 1 75); do up && break; sleep 0.2; done
fi
curl -s -m 170 -H "x-token: $T" -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$P/act"
`
