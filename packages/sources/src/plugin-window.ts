/**
 * A plugin's own settings and window, declared in its package.json so they can be shown before its code ever runs:
 *
 *   "nuonuo": { "plugin": "index.mjs",
 *     "settings": [{ "key": "city", "label": "城市", "type": "text" }, { "key": "token", "label": "令牌", "type": "secret" }],
 *     "window": { "page": "ui/index.html", "width": 480, "height": 560 } }
 *
 * `settings` uses the same fields as a source's form (kind.ts `FieldSpec`); secrets go to the secret store. `window` is a
 * page of the plugin's own, shown in a sandboxed frame; it talks to the plugin only through `nuonuo.call(name, input)`
 * (answered by the plugin's `windowCalls`), and gets no access to the service's API.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import type { FieldSpec } from './kind'

export interface PluginWindow {
  /** The page, relative to the plugin's folder; files next to it (and below) are served with it. */
  page: string
  title?: string
  width: number
  height: number
}

const KEY = /^[A-Za-z][\w-]{0,40}$/
const TYPES = new Set(['switch', 'number', 'text', 'list', 'select', 'secret'])
const short = (v: unknown, n: number) => typeof v === 'string' ? v.slice(0, n) : undefined

/** The settings a manifest declares, keeping only well-formed fields. */
export function readSettings(raw: unknown): FieldSpec[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('nuonuo.settings 必须是数组')
  const out: FieldSpec[] = []
  const seen = new Set<string>()
  for (const f of raw.slice(0, 40)) {
    if (!f || typeof f !== 'object') continue
    const key = String(f.key ?? ''), type = String(f.type ?? '')
    if (!KEY.test(key) || !TYPES.has(type) || seen.has(key)) throw new Error(`设置项「${key}」不合法（key 只能是字母开头的字母数字，type 是 ${[...TYPES].join('/')}）`)
    seen.add(key)
    const base = { key, label: short(f.label, 60) ?? key, ...(short(f.hint, 200) ? { hint: short(f.hint, 200)! } : {}), ...(f.advanced ? { advanced: true as const } : {}) }
    const placeholder = short(f.placeholder, 120)
    if (type === 'number') out.push({ ...base, type, min: Number.isFinite(f.min) ? Number(f.min) : 0, max: Number.isFinite(f.max) ? Number(f.max) : 1_000_000 })
    else if (type === 'select') {
      const options = Array.isArray(f.options) ? f.options.slice(0, 50).map((o: any) => typeof o === 'string' ? { value: o, label: o } : { value: String(o?.value ?? ''), label: String(o?.label ?? o?.value ?? '') }).filter((o: { value: string }) => o.value) : []
      if (!options.length) throw new Error(`设置项「${key}」没有选项`)
      out.push({ ...base, type, options })
    } else if (type === 'switch') out.push({ ...base, type })
    else out.push({ ...base, type: type as 'text' | 'list' | 'secret', ...(placeholder ? { placeholder } : {}) })
    const field = out[out.length - 1]!
    if (f.default !== undefined && type !== 'secret') { try { field.default = coerce(field, f.default) } catch { throw new Error(`设置项「${key}」的默认值不合法`) } }
  }
  return out
}

/** Default value of a field when the owner has set nothing. */
export function defaultValue(f: FieldSpec): unknown {
  if (f.default !== undefined) return f.default
  switch (f.type) {
    case 'switch': return false
    case 'number': return f.min
    case 'list': return []
    case 'select': return f.options[0]!.value
    default: return ''
  }
}

/** One field's value as the owner gave it, made to fit the field (or an error to show). */
export function coerce(f: FieldSpec, v: unknown): unknown {
  switch (f.type) {
    case 'switch': return Boolean(v)
    case 'number': {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`「${f.label}」要填数字`)
      return Math.min(f.max, Math.max(f.min, n))
    }
    case 'list': return (Array.isArray(v) ? v : String(v ?? '').split('\n')).map(x => String(x).trim()).filter(Boolean).slice(0, 200).map(x => x.slice(0, 500))
    case 'select': {
      const s = String(v ?? '')
      if (!f.options.some(o => o.value === s)) throw new Error(`「${f.label}」没有选项「${s}」`)
      return s
    }
    default: return String(v ?? '').slice(0, 4_000)
  }
}

/** The window a manifest declares, or undefined. */
export function readWindow(raw: unknown, dir: string): PluginWindow | undefined {
  if (raw === undefined) return undefined
  const w = (typeof raw === 'string' ? { page: raw } : raw) as Record<string, unknown> | null
  if (!w || typeof w.page !== 'string') throw new Error('nuonuo.window 需要 page（插件文件夹里的 html 文件）')
  const page = resolve(dir, w.page)
  if (!page.startsWith(dir + sep)) throw new Error('窗口页面必须在插件目录内')
  if (!/\.html?$/i.test(page)) throw new Error('窗口页面必须是 .html 文件')
  const size = (v: unknown, lo: number, hi: number, d: number) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d
  return { page: page.slice(dir.length + 1).split(sep).join('/'), ...(short(w.title, 60) ? { title: short(w.title, 60)! } : {}),
    width: size(w.width, 320, 1200, 520), height: size(w.height, 240, 900, 600) }
}

const TYPES_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
}

/** A file of the window (the page's folder and below), or undefined when `path` points elsewhere or at nothing. */
export function windowFile(dir: string, win: PluginWindow, path: string): { body: Buffer; type: string } | undefined {
  const root = dirname(resolve(dir, win.page))
  const file = resolve(root, path || win.page.split('/').pop()!)
  if (file !== root && !file.startsWith(root + sep)) return undefined
  if (!existsSync(file) || !statSync(file).isFile()) return undefined
  const type = TYPES_BY_EXT[extname(file).toLowerCase()]
  if (!type) return undefined
  return { body: readFileSync(file), type }
}

/**
 * Headers every window file is served with. The frame is sandboxed without same-origin rights, and the policy forbids any
 * network access, so a page can reach nothing but its own files and the host's `nuonuo.call` bridge.
 */
export const WINDOW_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/**
 * The bridge script served at `__nuonuo.js` next to the page: `nuonuo.call(name, input)` asks the plugin, `nuonuo.close()`
 * closes the window, `nuonuo.theme` is 'light' or 'dark' (and `<html data-theme>` follows it).
 */
export const BRIDGE_JS = `(() => {
  const waiting = new Map(); let seq = 0
  const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  addEventListener('message', e => {
    const m = e.data
    if (e.source !== parent || !m || m.nuonuo !== 'answer') return
    if (m.type === 'theme') { document.documentElement.dataset.theme = window.nuonuo.theme = m.theme; dispatchEvent(new CustomEvent('nuonuo:theme', { detail: m.theme })); return }
    const w = waiting.get(m.id); if (!w) return
    waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.value)
  })
  const post = msg => parent.postMessage({ nuonuo: 'ask', ...msg }, '*')
  window.nuonuo = {
    theme,
    call: (name, input) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); post({ type: 'call', id, name: String(name), input: input === undefined ? null : input }) }),
    close: () => post({ type: 'close' }),
  }
})()
`
