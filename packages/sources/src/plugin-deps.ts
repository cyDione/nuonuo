/**
 * Installs a plugin's npm dependencies without npm (the desktop app ships Node but not npm): versions are resolved from
 * the registry, tarballs unpacked into node_modules (hoisted to the top where they fit, nested where versions clash).
 * Install scripts never run, so a package that needs a native build is reported, not built.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { extractTarball, npmRegistry } from './plugin-install'

const MAX_PACKAGES = 400

interface Packument { 'dist-tags'?: Record<string, string>; versions?: Record<string, PackageMeta> }
interface PackageMeta {
  name: string
  version: string
  dist?: { tarball?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  scripts?: Record<string, string>
  gypfile?: boolean
  os?: string[]
  cpu?: string[]
}

export interface DepsResult { installed: number; notes: string[] }

/** Packages named in package.json `dependencies` (not dev ones), installed into `<dir>/node_modules`. */
export async function installDependencies(dir: string, fetchImpl: typeof fetch = fetch): Promise<DepsResult> {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  const deps = { ...(pkg.dependencies ?? {}) }
  const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}))
  for (const name of optional) deps[name] ??= pkg.optionalDependencies![name]!
  const notes: string[] = []
  if (!Object.keys(deps).length) return { installed: 0, notes }
  if (existsSync(join(dir, 'node_modules'))) return { installed: 0, notes: ['插件自带 node_modules，没有重新安装依赖'] }

  const packuments = new Map<string, Promise<Packument>>()
  const packument = (name: string) => {
    let p = packuments.get(name)
    if (!p) {
      p = (async () => {
        const res = await fetchImpl(`${npmRegistry()}/${name.replace('/', '%2F')}`, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' } })
        if (!res.ok) throw new Error(res.status === 404 ? `npm 上没有 ${name}` : `npm 返回 ${res.status}（${name}）`)
        return await res.json() as Packument
      })()
      packuments.set(name, p)
    }
    return p
  }
  const resolve = async (name: string, range: string): Promise<PackageMeta> => {
    if (/^(file:|git|https?:|link:|workspace:|github:)/.test(range) || range.includes('/') && !range.startsWith('npm:'))
      throw new Error(`${name} 的版本「${range}」不是 npm 版本号，没法自动安装；请把依赖打包进插件`)
    let real = name, want = range
    const alias = range.match(/^npm:(@?[^@]+)(?:@(.+))?$/)
    if (alias) { real = alias[1]!; want = alias[2] ?? 'latest' }
    const p = await packument(real)
    const versions = Object.keys(p.versions ?? {})
    const version = p['dist-tags']?.[want] ?? semver.maxSatisfying(versions, want || '*', { loose: true })
    const meta = version ? p.versions?.[version] : undefined
    if (!meta) throw new Error(`npm 上没有 ${real}@${want}`)
    return meta
  }

  // Where each installed copy lives: node_modules folder → name → version.
  const placed = new Map<string, Map<string, string>>()
  const at = (modules: string) => { let m = placed.get(modules); if (!m) { m = new Map(); placed.set(modules, m) } return m }
  let count = 0
  const top = join(dir, 'node_modules')

  /** Installs `name@range` for a package whose own node_modules is `ownModules`; `chain` is the folders it can see, nearest first. */
  const add = async (name: string, range: string, chain: string[], isOptional: boolean): Promise<void> => {
    // Already visible from here with a fitting version?
    for (const modules of chain) {
      const v = at(modules).get(name)
      if (v !== undefined) {
        if (semver.satisfies(v, range.startsWith('npm:') ? '*' : range, { loose: true }) || !semver.validRange(range, { loose: true })) return
        break
      }
    }
    let meta: PackageMeta
    try { meta = await resolve(name, range) } catch (error) { if (isOptional) { notes.push(`跳过可选依赖 ${name}：${(error as Error).message}`); return } throw error }
    if ((meta.os && !fits(meta.os, process.platform)) || (meta.cpu && !fits(meta.cpu, process.arch))) {
      if (isOptional) return
      notes.push(`${name} 不支持这台电脑（${process.platform}/${process.arch}）`)
    }
    // Hoist to the highest folder where the name is free; otherwise nest next to the one who needs it.
    // (never above a folder that already holds another version, which would hide it).
    const firstTaken = chain.findIndex(m => at(m).has(name))
    const free = firstTaken < 0 ? chain : chain.slice(0, firstTaken)
    if (!free.length) throw new Error(`${name} 的版本冲突，没法安装`)
    const target = free[free.length - 1]!
    if (++count > MAX_PACKAGES) throw new Error(`依赖太多（超过 ${MAX_PACKAGES} 个包），请把依赖打包进插件`)
    at(target).set(name, meta.version)
    if (!meta.dist?.tarball) throw new Error(`${name}@${meta.version} 没有下载地址`)
    const res = await fetchImpl(meta.dist.tarball, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`下载 ${name}@${meta.version} 失败（${res.status}）`)
    const folder = join(target, ...name.split('/'))
    mkdirSync(folder, { recursive: true })
    extractTarball(Buffer.from(await res.arrayBuffer()), folder)
    const scripts = meta.scripts ?? {}
    if (meta.gypfile || scripts.preinstall || scripts.install || scripts.postinstall)
      notes.push(`${name} 有安装脚本，为了安全没有运行；如果插件用不了，请让作者把它打包进插件`)
    const own = join(folder, 'node_modules')
    const children = { ...(meta.dependencies ?? {}) }
    const opt = new Set(Object.keys(meta.optionalDependencies ?? {}))
    for (const n of opt) children[n] ??= meta.optionalDependencies![n]!
    // Children see their own folder first, then everything their parent sees.
    const next = [own, ...chain.slice(chain.indexOf(target))]
    for (const [child, r] of Object.entries(children)) await add(child, r, next, opt.has(child))
  }

  for (const [name, range] of Object.entries(deps)) await add(name, range, [top], optional.has(name))
  return { installed: count, notes }
}

const fits = (list: string[], value: string) => {
  const deny = list.filter(x => x.startsWith('!')).map(x => x.slice(1))
  const allow = list.filter(x => !x.startsWith('!'))
  return !deny.includes(value) && (!allow.length || allow.includes(value))
}
