/**
 * Shell jobs. A command runs in the foreground for a short while; if it is still running then, it moves to the background
 * and the call returns at once (asynchronous ReAct: the session keeps taking messages), and its completion is pushed to the
 * session's inbox as a new event.
 */
import { newId, schema, type Store } from '@nuonuo/db'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { and, eq } from 'drizzle-orm'

const OUTPUT_CAP = 400_000

export interface JobResult { jobId: string; status: 'exited' | 'running' | 'killed' | 'timeout'; exitCode: number | null; output: string; durationMs: number }

interface Live { child: ChildProcess; output: string; started: number; background: boolean; done: Promise<JobResult>; sessionId: string; release?: () => void }

export class Jobs {
  private live = new Map<string, Live>()

  constructor(private store: Store, private onBackgroundDone: (sessionId: string, result: JobResult, command: string) => void) {}

  /**
   * Stops the commands a previous process left running (a crash leaves detached ones alive), marks them killed and returns
   * them so their sessions can be told.
   */
  recover(): { id: string; sessionId: string; command: string }[] {
    const rows = this.store.db.select().from(schema.jobs).where(eq(schema.jobs.status, 'running')).all()
    for (const row of rows) {
      if (row.pid && stillOurs(row.id, row.pid, row.startedAt)) killGroup(row.pid, 'SIGKILL')
      this.store.db.update(schema.jobs).set({ status: 'killed', endedAt: Date.now(), output: `${row.output}\n[服务重启，任务被终止]` })
        .where(eq(schema.jobs.id, row.id)).run()
    }
    return rows.map(r => ({ id: r.id, sessionId: r.sessionId, command: r.command }))
  }

  async run(opts: { sessionId: string; command: string; cwd: string; env: Record<string, string>; foregroundMs: number; timeoutMs: number;
    signal?: AbortSignal }): Promise<JobResult> {
    const id = newId('job')
    const started = Date.now()
    this.store.db.insert(schema.jobs).values({ id, sessionId: opts.sessionId, command: opts.command, cwd: opts.cwd, status: 'running', startedAt: started }).run()
    const [bin, args] = shellFor(opts.command)
    const child = spawn(bin, args, { cwd: opts.cwd, env: { ...opts.env, NUONUO_JOB: id }, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid) this.store.db.update(schema.jobs).set({ pid: child.pid }).where(eq(schema.jobs.id, id)).run()
    const live: Live = { child, output: '', started, background: false, sessionId: opts.sessionId, done: undefined as never }
    const append = (chunk: Buffer) => {
      live.output += chunk.toString('utf8')
      if (live.output.length > OUTPUT_CAP) live.output = `[…前面的输出已丢弃…]\n${live.output.slice(-OUTPUT_CAP)}`
    }
    child.stdout!.on('data', append)
    child.stderr!.on('data', append)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; this.killTree(child) }, opts.timeoutMs)
    live.done = new Promise<JobResult>(resolve => {
      child.on('error', error => { live.output += `\n${error.message}`; })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        const status: JobResult['status'] = timedOut ? 'timeout' : signal ? 'killed' : 'exited'
        const result = { jobId: id, status, exitCode: code, output: live.output, durationMs: Date.now() - started }
        this.store.db.update(schema.jobs).set({ status, exitCode: code, output: live.output, endedAt: Date.now() }).where(eq(schema.jobs.id, id)).run()
        this.live.delete(id)
        if (live.background) this.onBackgroundDone(opts.sessionId, result, opts.command)
        resolve(result)
      })
    })
    this.live.set(id, live)
    const onAbort = () => this.killTree(child)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    // The foreground wait ends early when `promote` is called (a person wrote to the session).
    const raced = await Promise.race([live.done, new Promise<null>(r => { live.release = () => r(null); setTimeout(() => r(null), opts.foregroundMs) })])
    live.release = undefined
    opts.signal?.removeEventListener('abort', onAbort)
    if (raced) return raced
    live.background = true
    this.store.db.update(schema.jobs).set({ background: true }).where(eq(schema.jobs.id, id)).run()
    return { jobId: id, status: 'running', exitCode: null, output: live.output, durationMs: Date.now() - started }
  }

  /** Moves the session's foreground commands to the background now, so its turn can take new input. */
  promote(sessionId: string): number {
    let n = 0
    for (const live of this.live.values()) if (live.sessionId === sessionId && live.release) { live.release(); n++ }
    return n
  }

  status(sessionId: string, jobId: string): JobResult | undefined {
    const live = this.live.get(jobId)
    if (live && live.sessionId === sessionId) return { jobId, status: 'running', exitCode: null, output: live.output, durationMs: Date.now() - live.started }
    const row = this.store.db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.sessionId, sessionId))).get()
    if (!row) return undefined
    return { jobId, status: row.status as JobResult['status'], exitCode: row.exitCode, output: row.output, durationMs: (row.endedAt ?? Date.now()) - row.startedAt }
  }

  running(sessionId: string): { jobId: string; command: string; startedAt: number }[] {
    return this.store.db.select().from(schema.jobs).where(and(eq(schema.jobs.sessionId, sessionId), eq(schema.jobs.status, 'running'))).all()
      .map(r => ({ jobId: r.id, command: r.command, startedAt: r.startedAt }))
  }

  /** Stops a job without notifying its session (the caller asked for it). */
  stop(sessionId: string, jobId: string): boolean {
    const live = this.live.get(jobId)
    if (!live || live.sessionId !== sessionId) return false
    live.background = false
    this.killTree(live.child)
    return true
  }

  stopAll(sessionId: string): number {
    let n = 0
    for (const [id, live] of this.live) if (live.sessionId === sessionId && this.stop(sessionId, id)) n++
    return n
  }

  async shutdown(): Promise<void> {
    for (const live of this.live.values()) { live.background = false; this.killTree(live.child) }
    await Promise.allSettled([...this.live.values()].map(l => l.done))
  }

  private killTree(child: ChildProcess) {
    if (child.exitCode !== null || child.pid === undefined) return
    const pid = child.pid
    killGroup(pid, 'SIGTERM')
    if (process.platform !== 'win32') setTimeout(() => killGroup(pid, 'SIGKILL'), 3_000).unref()
  }
}

let windowsShell: [string, (command: string) => string[]] | undefined

/**
 * The command line a job runs in: bash everywhere it exists (on Windows, Git Bash or WSL's bash on PATH), else PowerShell,
 * so a Windows machine without bash still runs commands instead of failing every one.
 */
export function shellFor(command: string, platform = process.platform): [string, string[]] {
  if (platform !== 'win32') return ['bash', ['-lc', command]]
  windowsShell ??= spawnSync('where', ['bash'], { windowsHide: true }).status === 0
    ? ['bash', c => ['-lc', c]]
    : ['powershell.exe', c => ['-NoProfile', '-NonInteractive', '-Command', c]]
  return [windowsShell[0], windowsShell[1](command)]
}

/** Stops a job's whole process tree: its process group on Unix (jobs start detached, so pid = group), taskkill on Windows. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* gone */ }
    return
  }
  try { process.kill(-pid, signal) } catch { /* gone */ }
}

/**
 * Whether `pid` is still the job a previous run started, so a restart never stops an unrelated process that reused the id:
 * it must have started since the machine booted and, where /proc exists, carry the job's own id in its environment.
 */
function stillOurs(jobId: string, pid: number, startedAt: number): boolean {
  if (startedAt < Date.now() - uptime() * 1000) return false
  if (process.platform === 'win32') { try { process.kill(pid, 0); return true } catch { return false } }
  try { process.kill(-pid, 0) } catch { return false }
  if (process.platform !== 'linux') return true
  // The group leader may be gone while its children run on; any of them carries the marker.
  const marker = `NUONUO_JOB=${jobId}`
  try {
    return readdirSync('/proc').some(n => /^\d+$/.test(n) && (() => { try { return readFileSync(`/proc/${n}/environ`, 'utf8').split('\0').includes(marker) } catch { return false } })())
  } catch { return false }
}
