/**
 * Update check and self-update.
 *
 * The check reads the latest GitHub Release of the public repository; no sign-in is needed (GITHUB_TOKEN or GH_TOKEN,
 * when set, is sent to get a higher rate limit). The headless Linux package updates itself by running install.sh, the
 * same script a fresh install uses, against the installation this process runs from; the data directory is never
 * touched. For the desktop app (macOS, Windows) the service downloads the new version in the background, checks it
 * against the SHA-256 digest GitHub publishes for it and stages it under <home>/updates; the app installs it when it
 * quits or when the owner asks (apps/desktop/lib/update.cjs), because only the app can quit itself and swap its files.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VERSION } from './config'

export const REPO = 'cyDione/super-assistant'
/** SUPER_ASSISTANT_UPDATE_API points the check at another server with the same API (used by tests). */
const api = (env: NodeJS.ProcessEnv) => (env.SUPER_ASSISTANT_UPDATE_API || `https://api.github.com/repos/${REPO}`).replace(/\/$/, '')

/** The release file for this machine: the headless tar.gz on Linux, the installer for the desktop app. */
export function assetPattern(desktop: boolean, platform: NodeJS.Platform = process.platform, arch: string = process.arch): RegExp {
  if (!desktop) return new RegExp(`^super-assistant-.+-linux-${arch}\\.tar\\.gz$`)
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
  return new RegExp(`^super-assistant-.+-${os}-${arch}[.-]`)
}

/**
 * The file the desktop app updates itself from: the zip of the .app on macOS (unpacked and swapped in place, the same
 * way install.sh installs it), the NSIS installer on Windows (run silently). Other systems have none.
 */
export function installerPattern(platform: NodeJS.Platform = process.platform, arch: string = process.arch): RegExp | null {
  if (platform === 'darwin') return new RegExp(`^super-assistant-.+-mac-${arch}\\.zip$`)
  if (platform === 'win32') return new RegExp(`^super-assistant-.+-win-${arch}-setup\\.exe$`)
  return null
}

/** How this process was installed: from the release package (can update itself) or run from a source checkout. */
export type Install = { kind: 'package'; prefix: string } | { kind: 'source'; root: string } | { kind: 'desktop' } | { kind: 'other' }

/** `entry` is the running cli.mjs. A package is laid out as <prefix>/{bin/super-assistant,lib/cli.mjs,runtime/node}. */
export function detectInstall(entry: string): Install {
  const prefix = resolve(dirname(entry), '..')
  if (existsSync(join(prefix, 'bin/super-assistant')) && existsSync(join(prefix, 'runtime/node')) && existsSync(join(prefix, 'lib/cli.mjs'))) {
    return { kind: 'package', prefix }
  }
  const root = resolve(dirname(entry), '../../..')
  return existsSync(join(root, 'pnpm-workspace.yaml')) ? { kind: 'source', root } : { kind: 'other' }
}

/**
 * Whether this process is the super-assistant systemd user service, so that install.sh's `systemctl restart` brings it
 * back on the new version. INVOCATION_ID is not enough: GNOME Terminal runs as a systemd user service itself, so every
 * shell in it carries one. The unit sets SUPER_ASSISTANT_SERVICE=1; units written by older versions don't, so the cgroup
 * name is checked too.
 */
export function runsAsService(env: NodeJS.ProcessEnv = process.env, cgroupFile = '/proc/self/cgroup'): boolean {
  if (env.SUPER_ASSISTANT_SERVICE === '1') return true
  try { return /\/super-assistant\.service(\/|$)/m.test(readFileSync(cgroupFile, 'utf8')) } catch { return false }
}

/** Compares dotted versions ("v0.2.0", "0.10.1"); a pre-release ("1.0.0-rc.1") sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/i, '').split('-', 2)
    return { nums: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  return x.pre < y.pre ? -1 : 1
}

/** A GitHub token from the environment, if any. The repository is public, so this only raises the rate limit. */
export function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GITHUB_TOKEN || env.GH_TOKEN || undefined
}

const headers = (token: string | undefined, accept: string) =>
  ({ ...(token ? { authorization: `Bearer ${token}` } : {}), accept, 'user-agent': 'super-assistant-updater' })

export interface Asset { name: string; url: string; size: number; digest: string | null }
export interface Release { tag: string; version: string; url: string; notes: string; publishedAt: string | null; hasPackage: boolean
  /** The file this install updates itself from (the desktop app's), when the release has one. */
  installer?: Asset | null }

export async function fetchLatestRelease(token: string | undefined, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env,
  asset: RegExp = assetPattern(false), prerelease = false, installer: RegExp | null = null): Promise<Release> {
  // The beta channel takes the newest release, pre-releases included; /releases/latest skips them.
  const res = await fetchImpl(`${api(env)}/releases${prerelease ? '?per_page=15' : '/latest'}`, { headers: headers(token, 'application/vnd.github+json'), signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) throw new Error('还没有发布任何版本')
  if (res.status === 401) throw new Error('GITHUB_TOKEN 无效或已过期（检查更新不需要令牌，可以删掉它）')
  if (res.status === 403 || res.status === 429) throw new Error('GitHub 访问频率受限，稍后再试（或在数据目录的 env 文件里设置 GITHUB_TOKEN）')
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`)
  type Raw = { tag_name: string; html_url: string; body?: string | null; published_at?: string | null; draft?: boolean
    assets?: { name: string; browser_download_url?: string; size?: number; digest?: string | null }[] }
  const data = await res.json() as Raw | Raw[]
  const r = Array.isArray(data) ? data.find(x => !x.draft) : data
  if (!r) throw new Error('还没有发布任何版本')
  return {
    tag: r.tag_name, version: r.tag_name.replace(/^v/i, ''), url: r.html_url, notes: (r.body ?? '').slice(0, 4000),
    publishedAt: r.published_at ?? null, hasPackage: (r.assets ?? []).some(a => asset.test(a.name)), installer: pick(r.assets, installer),
  }
}

function pick(assets: { name: string; browser_download_url?: string; size?: number; digest?: string | null }[] | undefined, pattern: RegExp | null): Asset | null {
  const a = pattern ? (assets ?? []).find(x => pattern.test(x.name) && x.browser_download_url) : undefined
  return a ? { name: a.name, url: a.browser_download_url!, size: a.size ?? 0, digest: a.digest ?? null } : null
}

/** install.sh as published at `tag` (so an update always runs the newest installer). */
async function fetchInstaller(token: string | undefined, tag: string, fetchImpl: typeof fetch, env: NodeJS.ProcessEnv): Promise<string> {
  const res = await fetchImpl(`${api(env)}/contents/install.sh?ref=${encodeURIComponent(tag)}`, {
    headers: headers(token, 'application/vnd.github.raw'), signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`读取 ${tag} 的 install.sh 失败：GitHub 返回 ${res.status}`)
  return res.text()
}

export interface Run { state: 'running' | 'installed' | 'failed'; target: string; startedAt: number; log: string; error?: string }

/**
 * The desktop app's new version, downloaded by the service. `path` (once ready) is what the app installs from: the
 * unpacked Super-assistant.app on macOS, the setup .exe on Windows.
 */
export interface Download { state: 'downloading' | 'ready' | 'failed'; tag: string; version: string; received: number; size: number; path?: string; error?: string }

export interface UpdateStatus {
  current: string
  install: Install['kind']
  /** Only a package install updates itself; a source checkout updates with git. */
  canUpdate: boolean
  checkedAt: number | null
  latest: Release | null
  available: boolean
  checkError: string | null
  /** The update run started from this process, if any. */
  run: Run | null
  /** Desktop app: the downloaded new version, if any. */
  download: Download | null
  hint: string
  prefs: UpdatePrefs
}

export interface UpdaterOptions {
  home: string
  entry: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** Called after an update installed, when nothing else (systemd) will restart this process. */
  restart?: () => void
  /** Run by the systemd service (default: detected with runsAsService). */
  service?: boolean
  /** Started by the desktop app: new versions are downloaded here and installed by the app. */
  desktop?: boolean
  /** The system and CPU the desktop download is for (tests). */
  platform?: NodeJS.Platform
  arch?: string
}

const DAY = 24 * 60 * 60 * 1000

/**
 * 设置 → 系统和更新: check by itself, which channel, and whether a found update downloads and installs by itself (the
 * Linux package installs and restarts; the desktop app downloads in the background and installs when it quits).
 */
export interface UpdatePrefs { auto: boolean; channel: 'stable' | 'beta'; install: boolean }
export const DEFAULT_UPDATE_PREFS: UpdatePrefs = { auto: true, channel: 'stable', install: true }
/** The name of the app inside the macOS zip. */
export const MAC_APP = 'Super-assistant.app'

export class Updater {
  readonly install: Install
  private latest: Release | null = null
  private checkedAt: number | null = null
  private checkError: string | null = null
  private checking: Promise<void> | null = null
  private run: UpdateStatus['run'] = null
  private download: Download | null = null
  private downloading: Promise<UpdateStatus> | null = null
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private timer: NodeJS.Timeout | null = null
  private readonly env: NodeJS.ProcessEnv
  private readonly fetchImpl: typeof fetch
  private readonly service: boolean
  private prefs: UpdatePrefs = DEFAULT_UPDATE_PREFS

  constructor(private readonly opts: UpdaterOptions) {
    this.install = opts.desktop ? { kind: 'desktop' } : detectInstall(opts.entry)
    this.env = opts.env ?? process.env
    this.fetchImpl = opts.fetch ?? fetch
    this.service = opts.service ?? runsAsService(this.env)
    this.platform = opts.platform ?? process.platform
    this.arch = opts.arch ?? process.arch
    this.restore()
  }

  /** Checks shortly after start and then twice a day. SUPER_ASSISTANT_UPDATE_CHECK=0 turns the background check off. */
  startBackgroundChecks(): void {
    if (this.env.SUPER_ASSISTANT_UPDATE_CHECK === '0' || (this.install.kind !== 'package' && this.install.kind !== 'desktop')) return
    const tick = () => {
      if (!this.prefs.auto) return
      void this.check().then(s => {
        if (!this.prefs.install || !s.available || !s.canUpdate) return
        if (this.install.kind === 'desktop') return this.fetchDesktop()
        if (this.run?.state !== 'running') return this.update()
      })
        .catch(() => { /* recorded in checkError or run */ })
    }
    const first = setTimeout(tick, 15_000)
    first.unref()
    this.timer = setInterval(tick, DAY / 2)
    this.timer.unref()
  }

  stop(): void { if (this.timer) clearInterval(this.timer) }

  status(): UpdateStatus {
    const available = Boolean(this.latest && this.latest.hasPackage && compareVersions(this.latest.version, VERSION) > 0)
    const hint = this.install.kind === 'source'
      ? `源码运行：在 ${this.install.root} 里 git pull && pnpm install && pnpm build 后重启`
      : this.install.kind === 'desktop' ? (this.desktopCanUpdate() ? '新版本在后台下载好后，退出应用时自动安装（数据会保留）' : '桌面版：从发布页下载新版安装包，覆盖安装即可（数据会保留）')
      : this.install.kind === 'other' ? '这种安装方式不支持自动更新'
      : this.service ? '更新后 systemd 服务会自动重启' : '更新后服务会自动重启'
    if (this.run?.state === 'running') this.run = { ...this.run, log: tail(join(this.opts.home, 'logs/update.log')) }
    return {
      current: VERSION, install: this.install.kind,
      canUpdate: this.install.kind === 'package' ? process.platform === 'linux' : this.install.kind === 'desktop' && this.desktopCanUpdate(),
      checkedAt: this.checkedAt, latest: this.latest, available, checkError: this.checkError, run: this.run, download: this.download, hint, prefs: this.prefs,
    }
  }

  /** Reads the latest release; concurrent calls share one request. */
  async check(): Promise<UpdateStatus> {
    if (!this.checking) {
      this.checking = (async () => {
        try {
          const desktop = this.install.kind === 'desktop'
          this.latest = await fetchLatestRelease(githubToken(this.env), this.fetchImpl, this.env, assetPattern(desktop, this.platform, this.arch),
            this.prefs.channel === 'beta', desktop ? installerPattern(this.platform, this.arch) : null)
          this.checkError = null
        } catch (error) {
          this.checkError = (error as Error).message
        } finally {
          this.checkedAt = Date.now()
          this.checking = null
          this.persist()
        }
      })()
    }
    await this.checking
    return this.status()
  }

  /**
   * Everything needed to run install.sh for the latest release: the script as published at that tag (falling back to
   * the copy in this package) and its environment. Throws when there is nothing to install.
   */
  async prepare(): Promise<{ tag: string; script: string; env: NodeJS.ProcessEnv }> {
    if (this.install.kind !== 'package') throw new Error(this.status().hint)
    if (process.platform !== 'linux') throw new Error('自动更新目前只支持 Linux 安装包')
    const prefix = this.install.prefix
    const status = await this.check()
    if (!status.latest) throw new Error(status.checkError ?? '读不到最新版本')
    if (!status.available) throw new Error(`已是最新版本（${VERSION}）`)
    const token = githubToken(this.env)
    const tag = status.latest.tag
    const script = await fetchInstaller(token, tag, this.fetchImpl, this.env).catch(error => {
      const bundled = join(prefix, 'install.sh')
      if (existsSync(bundled)) return readFileSync(bundled, 'utf8')
      throw error
    })
    return { tag, script, env: { ...this.env, ...(token ? { GITHUB_TOKEN: token } : {}), SUPER_ASSISTANT_PREFIX: prefix, SUPER_ASSISTANT_VERSION: tag } }
  }

  /**
   * Installs the latest release in the background with install.sh. Under systemd, install.sh restarts the service;
   * otherwise `restart` is called once it finished. Progress is in status().run and <home>/logs/update.log.
   */
  async update(): Promise<UpdateStatus> {
    // The desktop app: download (the app asks the service, then installs what it staged).
    if (this.install.kind === 'desktop') {
      const status = await this.check()
      if (!status.canUpdate) throw new Error(status.hint)
      if (!status.available) throw new Error(`已是最新版本（${VERSION}）`)
      void this.fetchDesktop()
      return this.status()
    }
    if (this.run?.state === 'running') return this.status()
    const { tag, script, env } = await this.prepare()
    const logDir = join(this.opts.home, 'logs')
    mkdirSync(logDir, { recursive: true })
    const logFile = join(logDir, 'update.log')
    const scriptFile = join(logDir, 'update-install.sh')
    writeFileSync(scriptFile, script, { mode: 0o700 })
    writeFileSync(logFile, `${new Date().toISOString()} 更新 ${VERSION} → ${tag}\n`)
    const fd = openSync(logFile, 'a')
    const child = spawn('bash', [scriptFile], {
      // detached: own process group, so a restart of this process does not take the installer with it.
      detached: true, stdio: ['ignore', fd, fd], env,
    })
    const run: Run = { state: 'running', target: tag, startedAt: Date.now(), log: '' }
    this.run = run
    child.on('error', error => { this.run = { ...run, state: 'failed', error: error.message, log: tail(logFile) } })
    child.on('exit', code => {
      if (code === 0) {
        this.run = { ...run, state: 'installed', log: tail(logFile) }
        // As the systemd service, install.sh has already asked systemd for a restart; otherwise restart ourselves on the new code.
        if (!this.service) setTimeout(() => this.opts.restart?.(), 500)
      } else {
        this.run = { ...run, state: 'failed', error: `install.sh 退出码 ${code}`, log: tail(logFile) }
      }
    })
    child.unref()
    closeSync(fd)
    return this.status()
  }

  private desktopCanUpdate(): boolean { return installerPattern(this.platform, this.arch) !== null }
  private updatesDir() { return join(this.opts.home, 'updates') }

  /**
   * Downloads the latest release's desktop installer in the background (concurrent calls share one download), checks its
   * SHA-256 against GitHub's digest and stages it: on macOS the zip is unpacked with ditto and the quarantine flag is
   * cleared, so Gatekeeper does not stop the updated app. Progress is in status().download.
   */
  fetchDesktop(): Promise<UpdateStatus> {
    const latest = this.latest
    const asset = latest?.installer
    if (!latest || !asset || compareVersions(latest.version, VERSION) <= 0) return Promise.resolve(this.status())
    if (this.download?.state === 'ready' && this.download.tag === latest.tag) return Promise.resolve(this.status())
    if (this.downloading) return this.downloading
    this.downloading = (async () => {
      const dir = join(this.updatesDir(), latest.tag)
      const file = join(dir, asset.name)
      this.download = { state: 'downloading', tag: latest.tag, version: latest.version, received: 0, size: asset.size }
      try {
        // Older versions and half-finished downloads go; only this one is kept.
        rmSync(this.updatesDir(), { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
        const res = await this.fetchImpl(asset.url, { headers: { 'user-agent': 'super-assistant-updater' }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) })
        if (!res.ok || !res.body) throw new Error(`下载 ${asset.name} 失败：GitHub 返回 ${res.status}`)
        const hash = createHash('sha256')
        const progress = this.download
        const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
        body.on('data', (chunk: Buffer) => { hash.update(chunk); progress.received += chunk.length })
        await pipeline(body, createWriteStream(`${file}.part`))
        if (asset.size && progress.received !== asset.size) throw new Error(`下载不完整（${progress.received} / ${asset.size} 字节）`)
        const digest = `sha256:${hash.digest('hex')}`
        if (asset.digest && asset.digest.toLowerCase() !== digest) throw new Error(`${asset.name} 校验失败，已丢弃`)
        renameSync(`${file}.part`, file)
        let path = file
        if (this.platform === 'darwin') {
          const out = join(dir, 'app')
          const unzip = spawnSync('ditto', ['-x', '-k', file, out], { encoding: 'utf8' })
          if (unzip.status !== 0) throw new Error(`解压 ${asset.name} 失败：${(unzip.stderr || unzip.error?.message || '').trim()}`)
          path = join(out, MAC_APP)
          if (!existsSync(path)) throw new Error(`${asset.name} 里没有 ${MAC_APP}`)
          // A file the service downloads itself carries no quarantine flag; clear it anyway, so Gatekeeper never stops the update.
          spawnSync('xattr', ['-dr', 'com.apple.quarantine', path])
          rmSync(file, { force: true })
        }
        this.download = { ...progress, state: 'ready', path }
        writeFileSync(join(this.updatesDir(), 'ready.json'), JSON.stringify(this.download))
      } catch (error) {
        this.download = { ...this.download!, state: 'failed', error: (error as Error).message }
        rmSync(`${file}.part`, { force: true })
      } finally {
        this.downloading = null
      }
      return this.status()
    })()
    return this.downloading
  }

  setPrefs(patch: Partial<UpdatePrefs>): UpdateStatus {
    this.prefs = { ...this.prefs, ...patch }
    try { writeFileSync(this.prefsFile(), JSON.stringify(this.prefs)) } catch { /* best effort */ }
    return this.status()
  }

  private cacheFile() { return join(this.opts.home, 'update-check.json') }
  private prefsFile() { return join(this.opts.home, 'update-settings.json') }

  private persist() {
    try { writeFileSync(this.cacheFile(), JSON.stringify({ latest: this.latest, checkedAt: this.checkedAt, checkError: this.checkError })) } catch { /* best effort */ }
  }

  private restore() {
    try {
      const saved = JSON.parse(readFileSync(this.cacheFile(), 'utf8')) as { latest: Release | null; checkedAt: number | null; checkError: string | null }
      this.latest = saved.latest
      this.checkedAt = saved.checkedAt
      this.checkError = saved.checkError
    } catch { /* first run */ }
    try { this.prefs = { ...DEFAULT_UPDATE_PREFS, ...JSON.parse(readFileSync(this.prefsFile(), 'utf8')) as Partial<UpdatePrefs> } } catch { /* defaults */ }
    if (this.install.kind !== 'desktop') return
    // A download staged before a restart is still ready; once that version runs (or the files are gone) it is cleaned up.
    try {
      const ready = JSON.parse(readFileSync(join(this.updatesDir(), 'ready.json'), 'utf8')) as Download
      if (ready.state === 'ready' && ready.path && existsSync(ready.path) && compareVersions(ready.version, VERSION) > 0) this.download = ready
      else rmSync(this.updatesDir(), { recursive: true, force: true })
    } catch {
      if (existsSync(this.updatesDir()) && readdirSync(this.updatesDir()).length) rmSync(this.updatesDir(), { recursive: true, force: true })
    }
  }
}

function tail(file: string, max = 4000): string {
  try { const text = readFileSync(file, 'utf8'); return text.length > max ? text.slice(-max) : text } catch { return '' }
}
