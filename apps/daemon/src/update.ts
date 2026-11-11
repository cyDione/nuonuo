/**
 * Update check and self-update.
 *
 * The check reads the latest GitHub Release of the public repository; no sign-in is needed (GITHUB_TOKEN or GH_TOKEN,
 * when set, is sent to get a higher rate limit). The headless Linux package updates itself by running install.sh, the
 * same script a fresh install uses, against the installation this process runs from; the data directory is never
 * touched. The desktop app only reports the new version, with a link to its installer.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

export interface Release { tag: string; version: string; url: string; notes: string; publishedAt: string | null; hasPackage: boolean }

export async function fetchLatestRelease(token: string | undefined, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env,
  asset: RegExp = assetPattern(false), prerelease = false): Promise<Release> {
  // The beta channel takes the newest release, pre-releases included; /releases/latest skips them.
  const res = await fetchImpl(`${api(env)}/releases${prerelease ? '?per_page=15' : '/latest'}`, { headers: headers(token, 'application/vnd.github+json'), signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) throw new Error('还没有发布任何版本')
  if (res.status === 401) throw new Error('GITHUB_TOKEN 无效或已过期（检查更新不需要令牌，可以删掉它）')
  if (res.status === 403 || res.status === 429) throw new Error('GitHub 访问频率受限，稍后再试（或在数据目录的 env 文件里设置 GITHUB_TOKEN）')
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`)
  type Raw = { tag_name: string; html_url: string; body?: string | null; published_at?: string | null; draft?: boolean; assets?: { name: string }[] }
  const data = await res.json() as Raw | Raw[]
  const r = Array.isArray(data) ? data.find(x => !x.draft) : data
  if (!r) throw new Error('还没有发布任何版本')
  return {
    tag: r.tag_name, version: r.tag_name.replace(/^v/i, ''), url: r.html_url, notes: (r.body ?? '').slice(0, 4000),
    publishedAt: r.published_at ?? null, hasPackage: (r.assets ?? []).some(a => asset.test(a.name)),
  }
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
  /** Started by the desktop app: report new versions, but the installer is downloaded by hand. */
  desktop?: boolean
}

const DAY = 24 * 60 * 60 * 1000

/** 设置 → 系统和更新: check by itself, which channel, and whether a found update installs by itself (package installs only). */
export interface UpdatePrefs { auto: boolean; channel: 'stable' | 'beta'; install: boolean }
export const DEFAULT_UPDATE_PREFS: UpdatePrefs = { auto: true, channel: 'stable', install: false }

export class Updater {
  readonly install: Install
  private latest: Release | null = null
  private checkedAt: number | null = null
  private checkError: string | null = null
  private checking: Promise<void> | null = null
  private run: UpdateStatus['run'] = null
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
    this.restore()
  }

  /** Checks shortly after start and then twice a day. SUPER_ASSISTANT_UPDATE_CHECK=0 turns the background check off. */
  startBackgroundChecks(): void {
    if (this.env.SUPER_ASSISTANT_UPDATE_CHECK === '0' || (this.install.kind !== 'package' && this.install.kind !== 'desktop')) return
    const tick = () => {
      if (!this.prefs.auto) return
      void this.check().then(s => { if (this.prefs.install && s.available && s.canUpdate && this.run?.state !== 'running') return this.update() })
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
      : this.install.kind === 'desktop' ? '桌面版：从发布页下载新版安装包，覆盖安装即可（数据会保留）'
      : this.install.kind === 'other' ? '这种安装方式不支持自动更新'
      : this.service ? '更新后 systemd 服务会自动重启' : '更新后服务会自动重启'
    if (this.run?.state === 'running') this.run = { ...this.run, log: tail(join(this.opts.home, 'logs/update.log')) }
    return {
      current: VERSION, install: this.install.kind, canUpdate: this.install.kind === 'package' && process.platform === 'linux',
      checkedAt: this.checkedAt, latest: this.latest, available, checkError: this.checkError, run: this.run, hint, prefs: this.prefs,
    }
  }

  /** Reads the latest release; concurrent calls share one request. */
  async check(): Promise<UpdateStatus> {
    if (!this.checking) {
      this.checking = (async () => {
        try {
          this.latest = await fetchLatestRelease(githubToken(this.env), this.fetchImpl, this.env, assetPattern(this.install.kind === 'desktop'), this.prefs.channel === 'beta')
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
  }
}

function tail(file: string, max = 4000): string {
  try { const text = readFileSync(file, 'utf8'); return text.length > max ? text.slice(-max) : text } catch { return '' }
}
