import { tool } from 'ai'
import { z } from 'zod'
import type { Blobs } from '../blobs'
import type { Jobs } from '../jobs'

export interface ShellOptions {
  sessionId: string
  cwd: string
  env: Record<string, string>
  /** After this long a command moves to the background and the call returns. */
  foregroundMs: number
  /** Hard limit for any command, background included. */
  timeoutMs: number
  blocked: string[]
  signal: AbortSignal
}

const firstWords = (command: string) => command.split(/[;&|()\n`$]+/).map(part => part.trim().split(/\s+/)[0] ?? '').filter(Boolean)

export function shellTools(jobs: Jobs, blobs: Blobs, opts: ShellOptions) {
  const render = (r: { jobId: string; status: string; exitCode: number | null; output: string; durationMs: number }) => {
    const head = r.status === 'running'
      ? `[${r.jobId} 仍在运行，已转入后台（${Math.round(r.durationMs / 1000)}s）。完成后结果会作为新消息送达；无需等待，可以先做别的。用 job_status 查看进度，job_stop 终止。]`
      : `[${r.jobId} ${r.status === 'exited' ? `退出码 ${r.exitCode}` : r.status === 'timeout' ? '超时被终止' : '被终止'}，用时 ${(r.durationMs / 1000).toFixed(1)}s]`
    return `${head}\n${blobs.spill('shell-output', r.output || '（无输出）')}`
  }
  return {
    shell: tool({
      description: `Run a bash command in the task's working directory. Commands still running after ${Math.round(opts.foregroundMs / 1000)}s continue in the background and their result arrives later as a message — never sleep or poll in a loop. Hard limit ${Math.round(opts.timeoutMs / 60000)} minutes.`,
      inputSchema: z.object({ command: z.string().min(1) }),
      execute: async ({ command }) => {
        const hit = firstWords(command).find(word => opts.blocked.includes(word))
        if (hit) throw new Error(`命令 ${hit} 在这个执行环境中被禁止`)
        return render(await jobs.run({ sessionId: opts.sessionId, command, cwd: opts.cwd, env: opts.env, foregroundMs: opts.foregroundMs, timeoutMs: opts.timeoutMs, signal: opts.signal }))
      },
    }),
    job_status: tool({
      description: 'Show the status and latest output of a background job.',
      inputSchema: z.object({ job_id: z.string() }),
      execute: async ({ job_id }) => {
        const r = jobs.status(opts.sessionId, job_id)
        if (!r) throw new Error(`没有 ${job_id}`)
        return render({ ...r, output: r.output.slice(-6_000) })
      },
    }),
    job_stop: tool({
      description: 'Stop a background job.',
      inputSchema: z.object({ job_id: z.string() }),
      execute: async ({ job_id }) => (jobs.stop(opts.sessionId, job_id) ? `已终止 ${job_id}` : `${job_id} 不在运行`),
    }),
  }
}
