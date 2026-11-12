/**
 * Cloud computers (云电脑): a Linux machine of 糯糯's own somewhere else, which a plugin connects. The plugin only says how
 * to reach one provider's machine (its state, waking it, running one command); everything else is shared here, so a new
 * provider is a small adapter, like a chat app under the Channel layer:
 *
 * - waking and probing: before use the machine is woken if it sleeps, probed, and kept awake while a task uses it;
 * - its own space: with sudo, an account `nuonuo` (in the docker group, without sudo) whose home is on the persistent
 *   disk, so the owner's own files, browser and sessions on that machine stay untouched;
 * - the tools: a shell with background jobs, moving files between the task folder here and there, and a browser service
 *   with several Chromium profiles and named tabs open at once;
 * - being the default: unless the owner chose 本机 in 执行, a worker's `shell` runs there and the local one becomes
 *   `local_shell` (see `computerExtension`).
 */
import type { Blobs, TurnContext } from '@nuonuo/agent-runtime'
import { SNAPSHOT_SCRIPT } from '@nuonuo/agent-runtime'
import type { AgentExtensions, Ticket } from '@nuonuo/core'
import { tool, type ToolSet } from 'ai'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, posix, resolve, sep } from 'node:path'
import { z } from 'zod'
import { BROWSER_SH, BROWSERD_SOURCE } from './computer-browserd'
import type { PluginContext } from './plugins'

// ── What a provider plugin implements ──────────────────────────────────────

export interface ComputerCapabilities {
  /** The login user may `sudo -n`: nuonuo gets an account of its own. Without it, nuonuo works in a folder of the login user. */
  sudo: boolean
  /** Docker is installed. */
  docker: boolean
  /** The machine pauses by itself when idle (and is woken before use). */
  sleeps: boolean
  /** A folder on a disk that survives restarts; nuonuo's space is `<dataDir>/nuonuo`. */
  dataDir: string
  /** The longest one `exec` may take, in seconds. */
  maxExecSeconds: number
  /** Variables set for every command (e.g. to keep browsers off the owner's screen). */
  env?: Record<string, string>
}

export type ComputerState = 'ready' | 'asleep' | 'waking' | 'off' | 'unconfigured' | 'error'

export interface ComputerStatus {
  state: ComputerState
  /** The machine's name at the provider. */
  name?: string
  /** One line for the owner (why it is off, which plan…). */
  detail?: string
  /** When waking is refused for a while (a provider's cooldown). */
  retryAfterSeconds?: number
}

export interface ComputerExecRequest {
  /** A bash command line, run as the machine's login user. */
  command: string
  stdin?: string
  timeoutSeconds: number
}

export interface ComputerExecResult { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; truncated?: boolean }

/** A cloud computer provider, declared in a plugin's `computers`. Every method gets the plugin's own context. */
export interface ComputerKind<Ctx = PluginContext> {
  /** Lowercase letters, digits, `-` and `_`; unique among providers. */
  id: string
  title: string
  description?: string
  capabilities: ComputerCapabilities
  /** Where the machine is now, without waking it. */
  status(ctx: Ctx): Promise<ComputerStatus>
  /** Wakes or starts it and waits until it runs (or says why it cannot). */
  wake(ctx: Ctx): Promise<ComputerStatus>
  exec(ctx: Ctx, request: ComputerExecRequest): Promise<ComputerExecResult>
  /** Keeps it from pausing for `seconds` while a task waits on it silently (renewed while the task uses it). */
  keepAwake?(ctx: Ctx, request: { key: string; seconds: number }): Promise<void>
}

/** Identity with checks, for plugins: `sdk.defineComputer({...})`. */
export function defineComputer<Ctx = PluginContext>(kind: ComputerKind<Ctx>): ComputerKind<Ctx> {
  const problem = computerProblem(kind)
  if (problem) throw new Error(problem)
  return kind
}

export function computerProblem(kind: unknown): string | undefined {
  const k = kind as Partial<ComputerKind<unknown>> | undefined
  if (!k || typeof k !== 'object') return '云电脑必须是对象'
  if (typeof k.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(k.id)) return `云电脑 id「${String(k?.id)}」不合法`
  if (typeof k.title !== 'string' || !k.title) return `云电脑 ${k.id} 缺少 title`
  for (const m of ['status', 'wake', 'exec'] as const) if (typeof k[m] !== 'function') return `云电脑 ${k.id} 缺少 ${m}`
  const c = k.capabilities
  if (!c || typeof c.dataDir !== 'string' || !c.dataDir.startsWith('/') || typeof c.maxExecSeconds !== 'number') return `云电脑 ${k.id} 的 capabilities 不完整（dataDir、maxExecSeconds）`
  return undefined
}

/** A provider with its plugin's context bound, as the service uses it. */
export interface BoundComputer {
  id: string
  title: string
  description?: string
  pluginId: string
  capabilities: ComputerCapabilities
  status(): Promise<ComputerStatus>
  wake(): Promise<ComputerStatus>
  exec(request: ComputerExecRequest): Promise<ComputerExecResult>
  keepAwake?(request: { key: string; seconds: number }): Promise<void>
}

// ── The shared layer ───────────────────────────────────────────────────────

/** Bumped when the setup below changes, so every machine is set up again once. */
const SETUP_REVISION = 1
const SETUP_VERSION = createHash('sha256').update(`${SETUP_REVISION}\n${BROWSERD_SOURCE}\n${BROWSER_SH}\n${SNAPSHOT_SCRIPT}`).digest('hex').slice(0, 12)
const PLAYWRIGHT = 'playwright-core@1'
const ACCOUNT = 'nuonuo'
/** Re-probe a machine after this long without a successful command. */
const READY_FOR_MS = 60_000
const LEASE_SECONDS = 900
const OUTPUT_LIMIT = 60_000
const CHUNK = 256 * 1024
const FILE_LIMIT = 100 * 1024 * 1024

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64')

export class ComputerError extends Error {}

export interface ComputerView extends ComputerStatus { id: string; title: string; description?: string; pluginId: string; workspace: string; capabilities: ComputerCapabilities }

export interface BrowserTab { name: string; url: string; title: string }
export interface BrowserInfo { name: string; tabs: BrowserTab[]; idleSeconds: number }

interface Session { readyAt: number; setup?: Promise<void> }

export class Computers {
  private sessions = new Map<string, Session>()
  private leases = new Map<string, number>()

  constructor(private list: () => BoundComputer[], private now: () => number = Date.now) {}

  all(): BoundComputer[] {
    const seen = new Set<string>()
    return this.list().filter(c => !seen.has(c.id) && seen.add(c.id))
  }

  /** The computer tasks use: the first connected provider. */
  current(): BoundComputer | undefined { return this.all()[0] }

  get(id: string): BoundComputer {
    const c = this.all().find(x => x.id === id)
    if (!c) throw new ComputerError(`没有云电脑 ${id}（插件没开？）`)
    return c
  }

  /** nuonuo's own folder on that machine. */
  workspace(c: BoundComputer): string { return posix.join(c.capabilities.dataDir, ACCOUNT) }
  taskDir(c: BoundComputer, ticketId: string): string { return posix.join(this.workspace(c), 'tasks', ticketId) }

  async views(): Promise<ComputerView[]> {
    return Promise.all(this.all().map(async c => {
      const status = await c.status().catch(error => ({ state: 'error' as const, detail: (error as Error).message }))
      return { id: c.id, title: c.title, ...(c.description ? { description: c.description } : {}), pluginId: c.pluginId, workspace: this.workspace(c), capabilities: c.capabilities, ...status }
    }))
  }

  /** Wakes the machine if needed, checks that it answers, and sets nuonuo's space up the first time (or after an update). */
  async ready(c: BoundComputer): Promise<void> {
    const s = this.session(c)
    if (this.now() - s.readyAt < READY_FOR_MS) return
    let st = await c.status()
    if (st.state === 'unconfigured') throw new ComputerError(st.detail ?? `${c.title} 还没设置好：在插件设置里填好再试`)
    if (st.state !== 'ready') st = await c.wake()
    if (st.state !== 'ready') {
      const wait = st.retryAfterSeconds ? `，大约 ${Math.ceil(st.retryAfterSeconds / 60)} 分钟后再试` : ''
      throw new ComputerError(`${c.title} 现在用不了（${st.detail ?? st.state}）${wait}`)
    }
    const probe = await c.exec({ command: `echo __nuonuo_ok__; cat ${q(`${this.workspace(c)}/.computer/version`)} 2>/dev/null`, timeoutSeconds: 30 })
    if (!probe.stdout.includes('__nuonuo_ok__')) throw new ComputerError(`${c.title} 没有回应：${(probe.stderr || probe.stdout).slice(0, 200)}`)
    if (probe.stdout.split('\n')[1]?.trim() !== SETUP_VERSION) {
      s.setup ??= this.setup(c).finally(() => { s.setup = undefined })
      await s.setup
    }
    s.readyAt = this.now()
  }

  /** Forget that the machine was ready (it went to sleep under us). */
  stale(c: BoundComputer): void { this.session(c).readyAt = 0 }

  private session(c: BoundComputer): Session {
    let s = this.sessions.get(c.id)
    if (!s) this.sessions.set(c.id, s = { readyAt: 0 })
    return s
  }

  /** The account (or folder), the browser service and its helper script. */
  private async setup(c: BoundComputer): Promise<void> {
    const w = this.workspace(c)
    if (c.capabilities.sudo) {
      const r = await c.exec({ timeoutSeconds: 60, command: [
        'set -e',
        `id ${ACCOUNT} >/dev/null 2>&1 || sudo -n useradd --home-dir ${q(w)} --create-home --shell /bin/bash ${ACCOUNT}`,
        `if getent group docker >/dev/null; then sudo -n usermod -aG docker ${ACCOUNT}; fi`,
        `sudo -n mkdir -p ${q(w)}`, `sudo -n chown ${ACCOUNT}:${ACCOUNT} ${q(w)}`, `sudo -n chmod 750 ${q(w)}`,
      ].join('\n') })
      if (r.exitCode !== 0) throw new ComputerError(`在 ${c.title} 上建 ${ACCOUNT} 账户失败：${(r.stderr || r.stdout).slice(0, 300)}`)
    }
    const files: [string, string][] = [['browserd.mjs', BROWSERD_SOURCE], ['browser.sh', BROWSER_SH], ['snapshot.js', SNAPSHOT_SCRIPT],
      ['package.json', JSON.stringify({ name: 'nuonuo-computer', private: true, type: 'module' })]]
    const script = [
      'set -e', `W=${q(w)}`, 'D="$W/.computer"', 'mkdir -p "$D/jobs" "$D/browsers" "$W/tasks"',
      ...files.map(([name, body]) => `printf %s ${b64(body)} | base64 -d > "$D/${name}"`),
      'chmod +x "$D/browser.sh"',
      '[ -s "$D/token" ] || (head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 32 > "$D/token")', 'chmod 600 "$D/token"',
      // A browser service started by the previous version keeps its old code: stop it; the next call starts the new one.
      'pkill -u "$(id -u)" -f "node browserd.mjs" >/dev/null 2>&1 || true',
      `echo ${SETUP_VERSION} > "$D/version"`,
    ].join('\n')
    const r = await this.raw(c, script, { timeoutSeconds: 60, viaStdin: true })
    if (r.exitCode !== 0) throw new ComputerError(`在 ${c.title} 上准备 nuonuo 的空间失败：${(r.stderr || r.stdout).slice(0, 300)}`)
  }

  /** Runs a script in nuonuo's space (as its account when there is one), from a fresh login shell. */
  private raw(c: BoundComputer, script: string, opts: { stdin?: string; timeoutSeconds: number; viaStdin?: boolean }): Promise<ComputerExecResult> {
    const env = Object.entries(c.capabilities.env ?? {}).map(([k, v]) => `export ${k}=${q(v)}`).join('\n')
    const body = `${env ? `${env}\n` : ''}export NUONUO_HOME=${q(this.workspace(c))}\nmkdir -p "$NUONUO_HOME" && cd "$NUONUO_HOME"\n${script}`
    const as = c.capabilities.sudo ? `sudo -n -u ${ACCOUNT} -H ` : ''
    const timeoutSeconds = Math.min(opts.timeoutSeconds, c.capabilities.maxExecSeconds)
    // A long script (setup) travels on stdin; a command line carries the others, so their own stdin stays free.
    return opts.viaStdin
      ? c.exec({ command: `${as}bash -l -s`, stdin: body, timeoutSeconds })
      : c.exec({ command: `${as}bash -lc "$(printf %s ${b64(body)} | base64 -d)"`, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}), timeoutSeconds })
  }

  /** Runs a script in nuonuo's space once the machine is ready; one retry if it went to sleep in between. */
  async run(c: BoundComputer, script: string, opts: { stdin?: string; timeoutSeconds: number }): Promise<ComputerExecResult> {
    await this.ready(c)
    try { return await this.raw(c, script, opts) } catch (error) {
      if (!/not.?running|asleep|suspend|waking|409/i.test((error as Error).message)) throw error
      this.stale(c)
      await this.ready(c)
      return this.raw(c, script, opts)
    }
  }

  /** Keeps the machine awake while a task uses it (renewed at most every two minutes). */
  touch(c: BoundComputer, key: string): void {
    if (!c.keepAwake) return
    const k = `${c.id}:${key}`
    if (this.now() - (this.leases.get(k) ?? 0) < 120_000) return
    this.leases.set(k, this.now())
    void c.keepAwake({ key, seconds: LEASE_SECONDS }).catch(() => {})
  }

  // ── Shell with background jobs ───────────────────────────────────────────

  /**
   * Starts a command as a job (so it survives the call), waits up to `waitSeconds` for it, and returns its output so far.
   * The job ends after `timeoutSeconds` at the latest.
   */
  async start(c: BoundComputer, command: string, opts: { cwd: string; env?: Record<string, string>; waitSeconds: number; timeoutSeconds: number }): Promise<JobResult> {
    const id = `cj${this.now().toString(36)}${randomBytes(2).toString('hex')}`
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `export ${k}=${q(v)}`).join('\n')
    const job = `cd ${q(opts.cwd)} || exit 97\n${env}\n${command}\n`
    const script = [
      'J="$NUONUO_HOME/.computer/jobs"', 'mkdir -p "$J"', `mkdir -p ${q(opts.cwd)}`,
      `printf %s ${b64(job)} | base64 -d > "$J/${id}.sh"`,
      `(setsid nohup bash -c 'echo $$ > "$1.pid"; timeout -k 10 ${Math.max(1, Math.round(opts.timeoutSeconds))} bash -l "$1.sh" > "$1.log" 2>&1 < /dev/null; echo $? > "$1.exit"' _ "$J/${id}" > /dev/null 2>&1 < /dev/null &)`,
      waitFor(id, opts.waitSeconds), report(id),
    ].join('\n')
    const r = await this.run(c, script, { timeoutSeconds: opts.waitSeconds + 30 })
    return parseJob(id, r)
  }

  async job(c: BoundComputer, id: string, waitSeconds = 0): Promise<JobResult> {
    if (!/^cj[0-9a-z]+$/.test(id)) throw new ComputerError(`没有任务 ${id}`)
    const r = await this.run(c, ['J="$NUONUO_HOME/.computer/jobs"', `[ -f "$J/${id}.sh" ] || { echo __MISSING__; exit 0; }`, waitFor(id, waitSeconds), report(id)].join('\n'), { timeoutSeconds: waitSeconds + 30 })
    if (r.stdout.startsWith('__MISSING__')) throw new ComputerError(`没有任务 ${id}`)
    return parseJob(id, r)
  }

  async stopJob(c: BoundComputer, id: string): Promise<boolean> {
    if (!/^cj[0-9a-z]+$/.test(id)) return false
    const r = await this.run(c, `J="$NUONUO_HOME/.computer/jobs"; [ -f "$J/${id}.exit" ] && { echo done; exit 0; }; P=$(cat "$J/${id}.pid" 2>/dev/null) && pkill -TERM -s "$P" && { sleep 0.5; [ -f "$J/${id}.exit" ] || echo 143 > "$J/${id}.exit"; echo stopped; }`, { timeoutSeconds: 20 })
    return r.stdout.includes('stopped')
  }

  // ── Files ────────────────────────────────────────────────────────────────

  async upload(c: BoundComputer, local: string, remote: string): Promise<number> {
    const size = statSync(local).size
    if (size > FILE_LIMIT) throw new ComputerError(`文件太大（${Math.round(size / 1048576)} MB），一次最多 100 MB`)
    const data = readFileSync(local)
    await this.run(c, `mkdir -p ${q(posix.dirname(remote))} && : > ${q(remote)}`, { timeoutSeconds: 20 })
    for (let off = 0; off === 0 || off < data.length; off += CHUNK) {
      const r = await this.run(c, `base64 -d >> ${q(remote)}`, { stdin: b64(data.subarray(off, off + CHUNK)), timeoutSeconds: 120 })
      if (r.exitCode !== 0) throw new ComputerError(`写入 ${remote} 失败：${r.stderr.slice(0, 200)}`)
      if (data.length === 0) break
    }
    return data.length
  }

  async download(c: BoundComputer, remote: string, local: string): Promise<number> {
    const head = await this.run(c, `stat -c %s ${q(remote)}`, { timeoutSeconds: 20 })
    const size = Number(head.stdout.trim())
    if (head.exitCode !== 0 || !Number.isFinite(size)) throw new ComputerError(`云电脑上没有文件 ${remote}`)
    if (size > FILE_LIMIT) throw new ComputerError(`文件太大（${Math.round(size / 1048576)} MB），一次最多 100 MB`)
    const parts: Buffer[] = []
    for (let off = 0; off < size; off += CHUNK) {
      const r = await this.run(c, `tail -c +${off + 1} ${q(remote)} | head -c ${CHUNK} | base64 -w0`, { timeoutSeconds: 120 })
      if (r.exitCode !== 0 || r.truncated) throw new ComputerError(`读取 ${remote} 失败：${r.stderr.slice(0, 200) || '输出被截断'}`)
      parts.push(Buffer.from(r.stdout.trim(), 'base64'))
    }
    mkdirSync(dirname(local), { recursive: true })
    const data = Buffer.concat(parts)
    writeFileSync(local, data)
    return data.length
  }

  // ── Browsers ─────────────────────────────────────────────────────────────

  async browser<T = Record<string, unknown>>(c: BoundComputer, request: Record<string, unknown>): Promise<T> {
    const install = `[ -d "$NUONUO_HOME/.computer/node_modules/playwright-core" ] || (cd "$NUONUO_HOME/.computer" && npm install ${PLAYWRIGHT} --silent --no-audit --no-fund >/dev/null 2>&1) || { echo '{"ok":false,"error":"在云电脑上安装 playwright-core 失败（没有 node/npm，或连不上 npm）"}'; exit 0; }`
    const r = await this.run(c, `${install}\nbash "$NUONUO_HOME/.computer/browser.sh"`, { stdin: JSON.stringify(request), timeoutSeconds: 200 })
    let out: { ok?: boolean; error?: string } & Record<string, unknown>
    try { out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}') } catch { throw new ComputerError(`浏览器服务没有回应：${(r.stderr || r.stdout).slice(0, 300)}`) }
    if (!out.ok) throw new ComputerError(out.error || '浏览器出错')
    return out as T
  }
}

export interface JobResult { id: string; status: 'running' | 'exited' | 'timeout'; exitCode: number | null; output: string }

const waitFor = (id: string, seconds: number) => seconds > 0 ? `for i in $(seq 1 ${Math.round(seconds * 4)}); do [ -f "$J/${id}.exit" ] && break; sleep 0.25; done` : ':'
const report = (id: string) => `if [ -f "$J/${id}.exit" ]; then echo "__EXIT__$(cat "$J/${id}.exit")"; else echo __RUNNING__; fi; tail -c ${OUTPUT_LIMIT} "$J/${id}.log" 2>/dev/null`

function parseJob(id: string, r: ComputerExecResult): JobResult {
  if (r.exitCode !== 0 && !/__EXIT__|__RUNNING__/.test(r.stdout)) throw new ComputerError(`云电脑执行失败：${(r.stderr || r.stdout).slice(0, 300)}`)
  const nl = r.stdout.indexOf('\n')
  const first = nl < 0 ? r.stdout : r.stdout.slice(0, nl)
  const output = nl < 0 ? '' : r.stdout.slice(nl + 1)
  if (first.startsWith('__RUNNING__')) return { id, status: 'running', exitCode: null, output }
  const code = Number(first.replace('__EXIT__', '').trim())
  return { id, status: code === 124 || code === 137 ? 'timeout' : 'exited', exitCode: Number.isFinite(code) ? code : null, output }
}

// ── The agents' side ───────────────────────────────────────────────────────

export type GateDecision = { action: 'allow' } | { action: 'block'; reason: string } | { action: 'escalate'; approvalId: string; reason: string }

export interface ComputerExtensionOptions {
  blobs: Blobs
  /** 执行 → 执行环境: 'auto' makes the cloud computer the default when one is connected; 'local' keeps this machine. */
  mode(): 'auto' | 'local'
  /** How long a command may run in the foreground before it moves to the background, and its hard limit. */
  limits(): { foregroundSeconds: number; timeoutMinutes: number }
  /** The review of a command (the Reviewer's gateShell with `remote`). */
  gate?(ticket: Ticket, sessionId: string, command: string, input: Record<string, unknown>): Promise<GateDecision>
  /** Hands a finished background job to the worker's session (as the local shell does). */
  push(sessionId: string, payload: unknown): void
}

/** What the approval executor gets for an approved command (`tool: 'computer'`). */
export interface ComputerApprovalInput { computer: string; command: string; cwd: string; ticketId: string }

/** Runs a command the owner approved, in the foreground (up to the provider's limit). */
export async function runApproved(computers: Computers, input: Record<string, unknown>): Promise<string> {
  const c = computers.get(String(input.computer))
  const r = await computers.start(c, String(input.command), { cwd: String(input.cwd), waitSeconds: Math.min(540, c.capabilities.maxExecSeconds - 40), timeoutSeconds: 3600 })
  return r.status === 'running' ? `[${r.id} 仍在运行，用 job_status 查看]\n${r.output}` : `[退出码 ${r.exitCode}]\n${r.output || '（无输出）'}`
}

/** The tools and prompt for workers. Called per task; nothing when no cloud computer is connected. */
export function computerExtension(computers: Computers, opts: ComputerExtensionOptions): AgentExtensions & { shellOverride(ticket: Ticket, ctx: TurnContext): ToolSet | undefined } {
  const isDefault = () => opts.mode() !== 'local' && Boolean(computers.current())
  const watching = new Set<string>()

  const watch = (c: BoundComputer, sessionId: string, job: JobResult, command: string) => {
    if (watching.has(job.id)) return
    watching.add(job.id)
    const deadline = Date.now() + opts.limits().timeoutMinutes * 60_000 + 60_000
    let delay = 10_000
    const tick = async () => {
      try {
        const r = await computers.job(c, job.id)
        if (r.status !== 'running') {
          watching.delete(job.id)
          opts.push(sessionId, { type: 'job', jobId: job.id, command, status: r.status, exitCode: r.exitCode, output: opts.blobs.spill('shell-output', r.output || '（无输出）') })
          return
        }
      } catch { /* asleep or unreachable for a moment: try again later */ }
      if (Date.now() > deadline) { watching.delete(job.id); return }
      delay = Math.min(60_000, delay * 1.5)
      setTimeout(tick, delay).unref?.()
    }
    setTimeout(tick, delay).unref?.()
  }

  const render = (r: JobResult, label: string) => {
    const head = r.status === 'running'
      ? `[${r.id} 仍在运行，已转入后台。完成后结果会作为新消息送达；无需等待，可以先做别的。用 ${label}job_status 查看进度，${label}job_stop 终止。]`
      : `[${r.id} ${r.status === 'exited' ? `退出码 ${r.exitCode}` : '超时被终止'}]`
    return `${head}\n${opts.blobs.spill('shell-output', r.output || '（无输出）')}`
  }

  const shellTools = (ticket: Ticket, ctx: TurnContext, prefix: string): ToolSet => {
    const c = () => { const x = computers.current(); if (!x) throw new ComputerError('云电脑没有连接'); computers.touch(x, ticket.id); return x }
    const cwdOf = (x: BoundComputer, cwd?: string) => cwd ? posix.resolve(computers.taskDir(x, ticket.id), cwd) : computers.taskDir(x, ticket.id)
    return {
      [`${prefix}shell`]: tool({
        description: `Run a bash command on your cloud computer (${computers.current()?.title ?? ''}), in your task folder there unless cwd says otherwise. Internet and docker work there. With background: true it starts and returns at once; otherwise commands still running after ${Math.max(20, opts.limits().foregroundSeconds)}s move to the background and their result arrives later as a message — never sleep or poll in a loop. Hard limit ${opts.limits().timeoutMinutes} minutes.`,
        inputSchema: z.object({ command: z.string().min(1), background: z.boolean().optional(), cwd: z.string().optional().describe('A folder on the cloud computer (relative to your task folder there)') }),
        execute: async ({ command, background, cwd }) => {
          const x = c()
          const dir = cwdOf(x, cwd)
          const input: ComputerApprovalInput = { computer: x.id, command, cwd: dir, ticketId: ticket.id }
          const decision = opts.gate ? await opts.gate(ticket, ctx.session.id, command, { ...input }) : { action: 'allow' as const }
          if (decision.action === 'block') throw new ComputerError(`审核拦截了这条命令：${decision.reason}。不要换个写法绕过；需要的话用 report(waiting, human_action) 问主人。`)
          if (decision.action === 'escalate') return `[需要主人批准（${decision.approvalId}）：${decision.reason}。命令还没有执行。主人批准后它会在云电脑上运行，结果作为新消息送达。先做不依赖它的部分，或者 report(progress) 后结束本轮等待。]`
          const r = await computers.start(x, command, { cwd: dir, env: { NUONUO_TICKET: ticket.id }, waitSeconds: background ? 0 : Math.max(20, opts.limits().foregroundSeconds), timeoutSeconds: opts.limits().timeoutMinutes * 60 })
          if (r.status === 'running') watch(x, ctx.session.id, r, command)
          return render(r, prefix)
        },
      }),
      [`${prefix}job_status`]: tool({
        description: 'Show the status and latest output of a background job on the cloud computer.',
        inputSchema: z.object({ job_id: z.string() }),
        execute: async ({ job_id }) => render(await computers.job(c(), job_id), prefix),
      }),
      [`${prefix}job_stop`]: tool({
        description: 'Stop a background job on the cloud computer.',
        inputSchema: z.object({ job_id: z.string() }),
        execute: async ({ job_id }) => (await computers.stopJob(c(), job_id) ? `已终止 ${job_id}` : `${job_id} 不在运行`),
      }),
    }
  }

  const otherTools = (ticket: Ticket): ToolSet => {
    const c = () => { const x = computers.current(); if (!x) throw new ComputerError('云电脑没有连接'); computers.touch(x, ticket.id); return x }
    const local = (path: string) => {
      const full = resolve(ticket.directory, path)
      if (full !== ticket.directory && !full.startsWith(ticket.directory + sep)) throw new ComputerError('本机这边只能用工作目录里的文件')
      return full
    }
    const remote = (x: BoundComputer, path: string) => posix.resolve(computers.taskDir(x, ticket.id), path)
    const where = z.object({
      browser: z.string().regex(/^[\w.-]{1,40}$/).optional().describe('Which browser (a separate profile with its own logins and cookies); default "main"'),
      tab: z.string().regex(/^[\w.-]{1,40}$/).optional().describe('Which tab in that browser; default is this task\'s own tab'),
    })
    const target = (x: { browser?: string | undefined; tab?: string | undefined }) => ({ browser: x.browser ?? 'main', tab: x.tab ?? ticket.id.replace(/[^\w.-]/g, '_').slice(0, 40) })
    type PageView = { title: string; url: string; items: string[]; text: string }
    const page = (r: { page: PageView }, t: { browser: string; tab: string }) =>
      `浏览器 ${t.browser} / 标签页 ${t.tab}\n页面：${r.page.title}\n地址：${r.page.url}\n\n可操作元素（用 ref 点击或输入）：\n${r.page.items.join('\n') || '（无）'}\n\n正文：\n${opts.blobs.spill('page-text', r.page.text, 6_000)}`
    const act = (op: string, schema: z.ZodObject<any>, description: string) => tool({
      description, inputSchema: schema.extend(where.shape),
      execute: async (input: Record<string, unknown>) => {
        const t = target(input as { browser?: string; tab?: string })
        return page(await computers.browser<{ page: PageView }>(c(), { ...input, ...t, op }), t)
      },
    })
    return {
      computer_upload: tool({
        description: 'Copy a file from your local working directory to the cloud computer (to your task folder there unless `to` says otherwise).',
        inputSchema: z.object({ path: z.string().describe('Path in the local working directory'), to: z.string().optional().describe('Path on the cloud computer') }),
        execute: async ({ path, to }) => { const x = c(); const dest = remote(x, to ?? path.split(/[\\/]/).pop()!); const n = await computers.upload(x, local(path), dest); return `已上传 ${n} 字节到云电脑 ${dest}` },
      }),
      computer_download: tool({
        description: 'Copy a file from the cloud computer into your local working directory (deliverables must end up there).',
        inputSchema: z.object({ path: z.string().describe('Path on the cloud computer (relative to your task folder there)'), to: z.string().optional().describe('Path in the local working directory') }),
        execute: async ({ path, to }) => { const x = c(); const dest = local(to ?? posix.basename(path)); const n = await computers.download(x, remote(x, path), dest); return `已下载 ${n} 字节到 ${dest}` },
      }),
      computer_browser_open: act('open', z.object({ url: z.string().url() }), 'Open a URL in a browser on your cloud computer. Returns the page text and its interactive elements with refs. Several browsers (separate logins) and tabs can be open at once.'),
      computer_browser_snapshot: act('snapshot', z.object({}), 'Read a cloud browser tab again: text and interactive elements with refs.'),
      computer_browser_click: act('click', z.object({ ref: z.string().regex(/^e\d+$/) }), 'Click an element by its ref from the latest snapshot of that tab.'),
      computer_browser_type: act('type', z.object({ ref: z.string().regex(/^e\d+$/), text: z.string(), submit: z.boolean().optional() }), 'Type into an input by its ref (replacing its value); submit presses Enter afterwards. Never type the owner\'s passwords or payment details.'),
      computer_browser_press: act('press', z.object({ key: z.string().min(1).describe('e.g. Enter, Escape, PageDown, Control+A') }), 'Press a key in a cloud browser tab.'),
      computer_browser_scroll: act('scroll', z.object({ dy: z.number().optional().describe('Pixels down (negative: up); default 600') }), 'Scroll a cloud browser tab.'),
      computer_browser_back: act('back', z.object({}), 'Go back in a cloud browser tab.'),
      computer_browser_eval: tool({
        description: 'Run a JavaScript expression in a cloud browser tab and return its value as text (to extract data from a page).',
        inputSchema: z.object({ expression: z.string().min(1) }).extend(where.shape),
        execute: async input => { const t = target(input); const r = await computers.browser<{ value: string }>(c(), { ...input, ...t, op: 'evaluate' }); return opts.blobs.spill('page-eval', r.value, 12_000) },
      }),
      computer_browser_screenshot: tool({
        description: 'Look at a cloud browser tab: returns a screenshot you can see. With save, it is also stored in the local working directory (for reports).',
        inputSchema: z.object({ full_page: z.boolean().optional(), save: z.string().regex(/^[\w-]{1,40}$/).optional().describe('File name (without .jpg) under screenshots/') }).extend(where.shape),
        execute: async input => {
          const t = target(input)
          const r = await computers.browser<{ image: string; mediaType: string; url: string; title: string }>(c(), { ...t, fullPage: Boolean(input.full_page), op: 'screenshot' })
          let saved = ''
          if (input.save) { const file = local(`screenshots/${input.save}.jpg`); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(r.image, 'base64')); saved = file }
          return { ...r, saved }
        },
        toModelOutput: ({ output }) => ({ type: 'content', value: [
          { type: 'text', text: `${output.title} ${output.url}${output.saved ? `（已保存 ${output.saved}）` : ''}` },
          { type: 'image-data', data: output.image, mediaType: output.mediaType },
        ] }),
      }),
      computer_browser_tabs: tool({
        description: 'List the browsers open on the cloud computer and their tabs.',
        inputSchema: z.object({}),
        execute: async () => {
          const r = await computers.browser<{ browsers: BrowserInfo[] }>(c(), { op: 'list' })
          return r.browsers.length ? r.browsers.map(b => `${b.name}：\n${b.tabs.map(t => `  - ${t.name}: ${t.title} ${t.url}`).join('\n') || '  （没有标签页）'}`).join('\n') : '（没有打开的浏览器）'
        },
      }),
      computer_browser_close: tool({
        description: 'Close a tab (or, without tab, a whole browser) on the cloud computer. Logins stay saved.',
        inputSchema: z.object({ browser: where.shape.browser, tab: z.string().regex(/^[\w.-]{1,40}$/).optional() }),
        execute: async ({ browser, tab }) => (await computers.browser<{ closed: boolean }>(c(), { op: 'close', browser: browser ?? 'main', ...(tab ? { tab } : {}) })).closed ? '已关闭' : '没有这个标签页',
      }),
      computer_status: tool({
        description: 'Show whether the cloud computer is awake, and wake it.',
        inputSchema: z.object({}),
        execute: async () => {
          const x = c()
          await computers.ready(x)
          const r = await computers.run(x, 'echo "磁盘：$(df -h "$NUONUO_HOME" | tail -1 | awk \'{print $4" 可用 / "$2}\')"; echo "内存：$(free -h | awk \'/Mem/{print $7" 可用 / "$2}\')"; command -v docker >/dev/null && echo "docker：$(docker ps -q 2>/dev/null | wc -l) 个容器在运行"', { timeoutSeconds: 30 })
          return `${x.title} 在线。nuonuo 的空间：${computers.workspace(x)}\n${r.stdout.trim()}`
        },
      }),
    }
  }

  const prompt = (ticket: Ticket) => {
    const c = computers.current()
    if (!c) return undefined
    const def = isDefault()
    const w = computers.workspace(c)
    return `## 云电脑（${c.title}）${def ? '：你的默认执行环境' : ''}
You have a Linux computer of your own in the cloud. ${def ? '`shell` (with job_status / job_stop) runs there' : '`computer_shell` (with computer_job_status / computer_job_stop) runs there'}, ${c.capabilities.sudo ? `as the account \`${ACCOUNT}\` (no sudo)` : 'in nuonuo\'s own folder'}, home ${w}; your task folder there is ${computers.taskDir(c, ticket.id)} and commands start in it. Internet works there${c.capabilities.docker ? '; so does docker (label your containers with `--label nuonuo=1` and leave other containers alone)' : ''}. The owner also uses this machine: stay inside ${w} and never touch other accounts' files or processes. ${c.capabilities.sleeps ? 'It sleeps when idle; the tools wake it (the first call can take ~10 s).' : ''}
- Files: read_file / write_file / edit_file / list_dir work on the LOCAL working directory ${ticket.directory}, not on the cloud computer. Move files with computer_upload / computer_download; deliverables must end up in the local folder.
- ${def ? '`local_shell` runs on the owner\'s own machine: use it only when the work needs the owner\'s local folders, repositories or apps.' : 'Your `shell` runs on the owner\'s machine; use the cloud computer for downloads, installs, docker, long jobs and anything that needs the internet.'}
- Browsing: computer_browser_* drive Chromium on the cloud computer. Several browsers (\`browser\`: separate profiles, each keeping its own logins) with named tabs (\`tab\`) can be open at once, so you can work on several sites side by side; by default you get your own tab in browser "main". ${def ? 'Use them for browsing by default; browser_* is the owner\'s local browser with their own logins: use it only for a site that needs the owner\'s login or a handoff.' : ''}`
  }

  return {
    workerTools: (ticket, ctx) => !computers.current() ? {} : isDefault() ? otherTools(ticket) : { ...shellTools(ticket, ctx, 'computer_'), ...otherTools(ticket) },
    workerPrompt: ticket => prompt(ticket),
    routerPrompt: () => {
      const c = computers.current()
      return c ? `## 云电脑\nWorkers have a cloud computer of their own (${c.title}): internet, a shell${c.capabilities.docker ? ', docker' : ''} and several browsers at once. Requests that need browsing, downloads, installing software or long-running jobs are tasks (start_task).` : ''
    },
    shellOverride: (ticket, ctx) => isDefault() ? shellTools(ticket, ctx, '') : undefined,
  }
}
