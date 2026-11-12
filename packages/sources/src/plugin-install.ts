/**
 * Fetching a plugin's files: from a local folder, a GitHub repository (optionally a sub-folder of it), an npm package or a
 * .tgz URL. Nothing here runs plugin code; the files land in a staging folder that the PluginManager then moves into place.
 * Tarballs are read with a small built-in reader so the app needs no tar dependency: only plain files and folders are
 * written, and every path must stay inside the target.
 */
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

export type PluginOrigin =
  | { kind: 'folder'; path: string }
  | { kind: 'github'; repo: string; ref?: string; subdir?: string }
  | { kind: 'npm'; name: string; version?: string }
  | { kind: 'url'; url: string }

const MAX_DOWNLOAD = 50 * 1024 * 1024
const MAX_UNPACKED = 200 * 1024 * 1024
const MAX_FILES = 5_000

const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const GH_PART = /^[A-Za-z0-9_.-]+$/

/** Reads what the owner typed: a path, `github:owner/repo#ref`, a github.com URL, `owner/repo`, an npm name or a .tgz URL. */
export function parseOrigin(input: string): PluginOrigin {
  const s = input.trim()
  if (!s) throw new Error('请填写插件地址')
  if (s.startsWith('~/') || s === '~') return { kind: 'folder', path: join(homedir(), s.slice(1)) }
  if (isAbsolute(s) || s.startsWith('./') || s.startsWith('../') || /^[A-Za-z]:[\\/]/.test(s)) return { kind: 'folder', path: resolve(s) }
  if (s.startsWith('npm:')) return npm(s.slice(4))
  const gh = s.match(/^github:([^/#]+)\/([^/#]+?)(?:#(.+))?$/)
  if (gh) return github(gh[1]!, gh[2]!, gh[3])
  if (/^https?:\/\//i.test(s)) {
    const url = new URL(s)
    if (url.hostname === 'github.com' && !/\.(tgz|tar\.gz)$/i.test(url.pathname)) {
      const [owner, repo, tree, ref, ...rest] = url.pathname.split('/').filter(Boolean)
      if (!owner || !repo) throw new Error('GitHub 地址要包含仓库，例如 https://github.com/owner/repo')
      if (tree && tree !== 'tree') throw new Error('GitHub 地址只支持仓库首页或 /tree/<分支>/<目录>')
      return github(owner, repo.replace(/\.git$/, ''), ref, rest.join('/') || undefined)
    }
    if (url.protocol !== 'https:') throw new Error('只支持 https 下载')
    return { kind: 'url', url: url.href }
  }
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#(.+))?$/)
  if (short) return github(short[1]!, short[2]!, short[3])
  return npm(s)
}

function github(owner: string, repo: string, ref?: string, subdir?: string): PluginOrigin {
  if (!GH_PART.test(owner) || !GH_PART.test(repo)) throw new Error('GitHub 仓库名不合法')
  if (ref !== undefined && !/^[A-Za-z0-9_./-]+$/.test(ref)) throw new Error('分支或标签名不合法')
  if (subdir !== undefined && (subdir.split('/').some(p => p === '..' || p === '.'))) throw new Error('目录不合法')
  return { kind: 'github', repo: `${owner}/${repo}`, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) }
}

function npm(spec: string): PluginOrigin {
  const at = spec.lastIndexOf('@')
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined]
  if (!NPM_NAME.test(name)) throw new Error(`看不懂「${spec}」：请填文件夹路径、GitHub 仓库、npm 包名或 .tgz 网址`)
  if (version !== undefined && !/^[A-Za-z0-9._+~^<>=| -]+$/.test(version)) throw new Error('版本号不合法')
  return { kind: 'npm', name, ...(version ? { version } : {}) }
}

/** Puts the plugin's files into `into` (an empty folder) and returns the folder that holds its package.json. */
export async function fetchPlugin(origin: PluginOrigin, into: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  mkdirSync(into, { recursive: true })
  if (origin.kind === 'folder') {
    if (!existsSync(origin.path) || !statSync(origin.path).isDirectory()) throw new Error(`找不到文件夹 ${origin.path}`)
    cpSync(origin.path, into, { recursive: true, filter: src => !src.split(sep).includes('.git') })
    return into
  }
  let url: string
  if (origin.kind === 'github') url = `https://codeload.github.com/${origin.repo}/tar.gz/${origin.ref ? encodeURI(origin.ref) : 'HEAD'}`
  else if (origin.kind === 'npm') url = await npmTarball(origin, fetchImpl)
  else url = origin.url
  extractTarball(await download(url, fetchImpl), into)
  const root = origin.kind === 'github' && origin.subdir ? join(into, origin.subdir) : into
  if (!existsSync(join(root, 'package.json'))) throw new Error(origin.kind === 'github' && origin.subdir ? `仓库里的 ${origin.subdir} 没有 package.json` : '下载的内容里没有 package.json')
  return root
}

async function npmTarball(origin: { name: string; version?: string }, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`https://registry.npmjs.org/${origin.name.replace('/', '%2F')}`, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
  if (res.status === 404) throw new Error(`npm 上没有 ${origin.name}`)
  if (!res.ok) throw new Error(`npm 返回 ${res.status}`)
  const meta = await res.json() as { 'dist-tags'?: Record<string, string>; versions?: Record<string, { dist?: { tarball?: string } }> }
  const version = origin.version ? meta['dist-tags']?.[origin.version] ?? origin.version : meta['dist-tags']?.latest
  const tarball = version ? meta.versions?.[version]?.dist?.tarball : undefined
  if (!tarball) throw new Error(`npm 上没有 ${origin.name}@${origin.version ?? 'latest'}`)
  return tarball
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败（${res.status}）：${url}`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Error('插件包太大（超过 50 MB）')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_DOWNLOAD) throw new Error('插件包太大（超过 50 MB）')
  return buf
}

/**
 * Unpacks a .tar.gz into `into`, dropping the archive's top folder (npm's `package/`, GitHub's `repo-sha/`). Links,
 * devices and anything that would land outside `into` are skipped or refused.
 */
export function extractTarball(gz: Buffer, into: string): void {
  let tar: Buffer
  try { tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED }) } catch (error) { throw new Error(`插件包不是有效的 .tar.gz：${(error as Error).message}`) }
  const root = resolve(into)
  let offset = 0
  let files = 0
  let longName: string | undefined
  let paxPath: string | undefined
  const str = (b: Buffer) => { const end = b.indexOf(0); return b.subarray(0, end < 0 ? b.length : end).toString('utf8') }
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(b => b === 0)) break
    const size = parseInt(str(header.subarray(124, 136)).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('插件包已损坏')
    const type = String.fromCharCode(header[156]!)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = str(body); continue }
    if (type === 'x') { paxPath = body.toString('utf8').match(/^\d+ path=(.*)$/m)?.[1]; continue }
    if (type === 'g') continue
    const prefix = header.subarray(257, 263).toString() === 'ustar\0' || header.subarray(257, 262).toString() === 'ustar' ? str(header.subarray(345, 500)) : ''
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${str(header.subarray(0, 100))}` : str(header.subarray(0, 100)))
    longName = paxPath = undefined
    if (type !== '0' && type !== '\0' && type !== '5') continue
    const rel = name.split('/').slice(1).join('/')
    if (!rel) continue
    const target = resolve(root, normalize(rel))
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`插件包里有不安全的路径：${name}`)
    if (type === '5') { mkdirSync(target, { recursive: true }); continue }
    if (++files > MAX_FILES) throw new Error('插件包里的文件太多')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
}
