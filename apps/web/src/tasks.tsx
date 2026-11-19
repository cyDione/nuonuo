/**
 * The work behind the conversation, shown the way a person would describe it:
 * - in the chat, only what needs the owner (a yes/no, a question, taking over the browser, a problem) and a quiet "working on…" line;
 * - everything else — what was done, step by step — is one click away in the activity view, never in the conversation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, AppWindow, Brain, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Clock, Copy, CornerUpLeft, Dot, Download, FileText, FolderOpen, Globe, Hand, History, Hourglass, Image as ImageIcon, Link2, Loader2, MessageCircleQuestion, MousePointerClick, NotebookPen, OctagonX, PencilLine, Repeat, RotateCcw, ShieldAlert, Sparkles, SquareTerminal, Table2, Users, X, XCircle, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Stage, type Ticket, type TicketDetail, type TranscriptItem } from './api'
import { openTask, useLive, useOpenTask } from './live'
import { go } from './route'
import { Button, cx } from './ui'
import { HandoffModal } from './handoff'
import { ArtifactModal, previewKind } from './preview'
import { usePresence } from './shell'
import { locale, tx } from './i18n'

export const useTickets = () => useQuery({ queryKey: ['tickets'], queryFn: () => api.get<{ tickets: Ticket[] }>('/tickets') })

/** What a stage means to the owner, in plain words. */
export const STATE_TEXT: Record<Stage, string> = {
  'person/approve': tx('等你点头'), 'person/answer': tx('等你回复'), 'person/blocked': tx('卡住了'), 'person/failed': tx('出了问题'),
  queued: tx('马上开始'), working: tx('正在做'), idle: tx('在等后续'), ended: tx('已结束'),
}
export const endedText = (t: Ticket) => (t.ended?.outcome === 'completed' ? tx('完成了') : t.ended?.outcome === 'dropped' ? tx('不需要做') : tx('停下了'))
export const needsOwner = (t: Ticket) => t.stage.startsWith('person/')

const TONE: Record<Stage, string> = {
  'person/approve': 'text-warn', 'person/answer': 'text-warn', 'person/blocked': 'text-warn', 'person/failed': 'text-danger',
  queued: 'text-muted', working: 'text-accent', idle: 'text-muted', ended: 'text-faint',
}

export function StateIcon({ t, size = 14 }: { t: Ticket; size?: number }) {
  const cls = cx('shrink-0', TONE[t.stage])
  if (t.stage === 'working') return <Loader2 size={size} className={cx(cls, 'animate-spin')} />
  if (t.stage === 'person/approve') return <ShieldAlert size={size} className={cls} />
  if (t.stage === 'person/answer') return <MessageCircleQuestion size={size} className={cls} />
  if (t.stage === 'person/blocked') return <Hand size={size} className={cls} />
  if (t.stage === 'person/failed') return <AlertTriangle size={size} className={cls} />
  if (t.stage === 'queued') return <Clock size={size} className={cls} />
  if (t.stage === 'ended') return t.ended?.outcome === 'completed' ? <CheckCircle2 size={size} className="shrink-0 text-ok" /> : <OctagonX size={size} className={cls} />
  return <CircleDot size={size} className={cls} />
}

/**
 * One thing the owner is asked for, as part of the conversation: plain words first, technical detail folded away.
 * Answers to questions are typed in the composer like any message (they reach the right work automatically).
 */
export function NeedsYou({ t, onAnswer, onEdit, onLearned }: { t: Ticket; onAnswer(text: string, ticketId: string): void; onEdit?(text: string): void; onLearned?(l: Learned): void }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['tickets'] })
  const decide = useMutation({ mutationFn: (v: { id: string; approve: boolean; note?: string; scope?: Scope }) => api.post<Decided>(`/approvals/${v.id}`, { approve: v.approve, ...(v.note ? { note: v.note } : {}), ...(v.scope ? { scope: v.scope } : {}) }),
    onSuccess: (r, v) => {
      if (v.scope === 'always' && r.approval.grantId) onLearned?.({ id: v.id, grantId: r.approval.grantId, title: t.approvals[0]?.reason ?? tx('已同意') })
      refresh(); qc.invalidateQueries({ queryKey: ['grants'] })
    } })
  const retry = useMutation({ mutationFn: () => api.post(`/tickets/${t.id}/retry`), onSuccess: refresh })
  const stop = useMutation({ mutationFn: () => api.post(`/tickets/${t.id}/stop`), onSuccess: refresh })
  const [handoff, setHandoff] = useState<string | null>(null)
  const [detail, setDetail] = useState(false)

  const shell = (children: React.ReactNode) => <div className="max-w-xl rounded-[20px] border border-warn/25 bg-card px-4 py-3.5 shadow-[var(--shadow-sheet)]">{children}</div>

  if (t.approvals[0]?.card) return <ApprovalCardView t={t} onEdit={onEdit} onLearned={onLearned} />
  if (t.approvals.length) {
    const a = t.approvals[0]!
    return shell(<>
      <div className="flex items-center gap-2 text-sm font-semibold"><Tile><ShieldAlert size={15} /></Tile>{tx('这一步要你同意')}{a.risk === 'destructive' ? tx('（不可撤销）') : ''}</div>
      <div className="mt-2 text-sm text-pretty text-muted">{a.reason}</div>
      <button onClick={() => setDetail(v => !v)} className="mt-1.5 flex items-center gap-0.5 text-xs text-faint hover:text-muted">{detail ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{tx('具体操作')}</button>
      {detail && <pre className="anim-fade mt-1 overflow-x-auto rounded-xl bg-sunken px-3 py-2 font-mono text-xs whitespace-pre-wrap">{a.command}</pre>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, approve: true })}>{tx('同意这一次')}</Button>
        {a.risk !== 'destructive' && <Button size="sm" disabled={decide.isPending} title={tx('这件事做完之前，同类操作不再问你')} onClick={() => decide.mutate({ id: a.id, approve: true, scope: 'task' })}>{tx('这件事里都同意')}</Button>}
        {a.standing && <Button size="sm" disabled={decide.isPending} title={tx('以后同类操作不再问你，可以在「权限」里撤销')} onClick={() => decide.mutate({ id: a.id, approve: true, scope: 'always' })}>{tx('以后这类直接做')}</Button>}
        <Button size="sm" disabled={decide.isPending} onClick={() => { const note = prompt(tx('不同意的原因（可留空）')) ?? undefined; decide.mutate({ id: a.id, approve: false, ...(note ? { note } : {}) }) }}>{tx('不同意')}</Button>
      </div>
      {t.approvals.length > 1 && <div className="mt-1.5 text-xs text-faint">{tx('还有')} {t.approvals.length - 1} {tx('步也在等你')}</div>}
    </>)
  }
  if (t.attention?.kind === 'handoff') return shell(<>
    <div className="flex items-center gap-2 text-sm font-semibold"><Tile><Globe size={15} /></Tile>{tx('需要你在浏览器里操作一下')}</div>
    <div className="mt-2 text-sm text-pretty text-muted">{t.attention.question}</div>
    <Button size="sm" variant="primary" className="mt-3" onClick={() => setHandoff(t.attention!.question)}>{tx('打开浏览器')}</Button>
    {handoff && <HandoffModal ticketId={t.id} reason={handoff} onClose={() => setHandoff(null)} />}
  </>)
  if (t.attention?.options?.length) return shell(<div className="flex flex-wrap items-center gap-1.5">
    <span className="mr-1 flex items-center gap-2 text-sm font-semibold"><Tile><MessageCircleQuestion size={15} /></Tile>{tx('选一个：')}</span>
    {t.attention.options.map(o => <Button key={o} size="sm" onClick={() => onAnswer(o, t.id)}>{o}</Button>)}
  </div>)
  if (t.stage === 'person/blocked' || t.stage === 'person/failed') return shell(<div className="flex flex-wrap items-center gap-1.5">
    <Tile>{t.stage === 'person/failed' ? <AlertTriangle size={15} /> : <Hand size={15} />}</Tile>
    <span className="mr-auto text-sm text-pretty text-muted">「{t.title}」{t.stage === 'person/failed' ? tx('出了问题') : tx('卡住了')}{tx('——可以直接回复我，或者：')}</span>
    <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}><RotateCcw size={13} />{tx('再试一次')}</Button>
    <Button size="sm" variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>{tx('算了')}</Button>
  </div>)
  return null
}

/**
 * The structured confirmation (Figma v6, 18a): before spending, sending or changing something that cannot be taken back,
 * a card with exactly what will happen. Only its button confirms: 「好」 in the chat does not. The button draws a check
 * when pressed, then the card goes.
 */
function ApprovalCardView({ t, onEdit, onLearned }: { t: Ticket; onEdit?: ((text: string) => void) | undefined; onLearned?: ((l: Learned) => void) | undefined }) {
  const qc = useQueryClient()
  const a = t.approvals[0]!
  const card = a.card!
  const [done, setDone] = useState(false)
  const decide = useMutation({
    mutationFn: (v: { approve: boolean; scope?: Scope }) => api.post<Decided>(`/approvals/${a.id}`, { approve: v.approve, ...(v.scope ? { scope: v.scope } : {}) }),
    onSuccess: (r, v) => {
      if (!v.approve) { qc.invalidateQueries({ queryKey: ['tickets'] }); return }
      setDone(true)
      setTimeout(() => {
        if (v.scope === 'always' && r.approval.grantId) onLearned?.({ id: a.id, grantId: r.approval.grantId, title: card.title })
        qc.invalidateQueries({ queryKey: ['tickets'] }); qc.invalidateQueries({ queryKey: ['grants'] })
      }, 750)
    },
  })
  const [detail, setDetail] = useState(false)
  return <div className="max-w-[440px] overflow-hidden rounded-[18px] border border-line bg-card">
    <div className="flex items-center gap-2 px-4 py-3">
      <ShieldAlert size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{card.title}</span>
      {card.note && <span className="shrink-0 text-xs text-faint">{card.note}</span>}
    </div>
    <div className="border-t border-line px-4 pt-3 pb-3.5">
      <dl className="grid grid-cols-[4.5em_1fr] gap-x-3 gap-y-2 text-sm">
        {card.rows.map(r => <div key={r.label} className="contents"><dt className="text-faint">{r.label}</dt><dd className="min-w-0 break-words">{r.value}</dd></div>)}
      </dl>
      <button onClick={() => setDetail(v => !v)} className="mt-2 flex items-center gap-0.5 text-xs text-faint hover:text-muted">{detail ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{tx('具体操作')}</button>
      {detail && <pre className="anim-fade mt-1 overflow-x-auto rounded-xl bg-sunken px-3 py-2 font-mono text-xs whitespace-pre-wrap">{a.command}</pre>}
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => decide.mutate({ approve: true })} disabled={decide.isPending || done}
          className="press flex h-8 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-ink-fg disabled:cursor-default">
          {done && <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="check-draw" /></svg>}
          {done ? tx('好了') : card.confirm}
        </button>
        {!done && <button onClick={() => decide.mutate({ approve: false })} disabled={decide.isPending} className="press h-8 rounded-full border border-line px-4 text-[13px] hover:border-faint">{tx('先不要')}</button>}
        {!done && onEdit && <button onClick={() => onEdit(tx('这一步改一下：'))} className="ml-auto text-xs text-muted hover:text-fg">{tx('改一下')}</button>}
      </div>
      {!done && a.standing && <button onClick={() => decide.mutate({ approve: true, scope: 'always' })} disabled={decide.isPending}
        className="mt-2.5 flex items-center gap-1 text-xs text-muted hover:text-fg"><Repeat size={12} />{tx('{0}，以后这类直接做', card.confirm)}</button>}
    </div>
  </div>
}

type Scope = 'task' | 'always'
interface Decided { approval: { grantId?: string } }

/** An approval answered with 「以后这类直接做」: what was learned, kept in the conversation with a way to take it back. */
export interface Learned { id: string; grantId: string; title: string }

/** Figma v7 B2: the answered card folds to one line, and says where to change it later (糯糯's 权限). */
export function LearnedNote({ l, name, onUndone }: { l: Learned; name: string; onUndone(): void }) {
  const qc = useQueryClient()
  const [undone, setUndone] = useState(false)
  const undo = useMutation({ mutationFn: () => api.del(`/grants/${l.grantId}`), onSuccess: () => { setUndone(true); qc.invalidateQueries({ queryKey: ['grants'] }); setTimeout(onUndone, 1200) } })
  return <div className="max-w-[440px]">
    <div className="flex items-center gap-2 rounded-[14px] border border-line bg-card px-3.5 py-2.5 text-sm">
      <CheckCircle2 size={15} className="shrink-0 text-ok" />
      <span className="min-w-0 flex-1 truncate">{l.title}<span className="text-faint"> · {undone ? tx('下次还会先问你') : tx('以后这类直接做')}</span></span>
      {!undone && <button onClick={() => undo.mutate()} disabled={undo.isPending} className="shrink-0 text-xs text-muted hover:text-fg">{tx('撤销')}</button>}
    </div>
    {!undone && <div className="mt-1.5 px-1 text-xs text-faint">{tx('以后这类{0}直接做。想改的话点{1}的头像，在「权限」里。', name, name)}</div>}
  </div>
}

const Tile = ({ children }: { children: React.ReactNode }) => <span className="flex size-7 shrink-0 items-center justify-center rounded-[10px] bg-warn-soft text-warn">{children}</span>

/** Work going on for this conversation, as small chips above the composer; each opens what was done. */
export function WorkingLine({ tickets }: { tickets: Ticket[] }) {
  if (!tickets.length) return null
  return <div className="flex flex-wrap gap-2">
    {tickets.map(t => <button key={t.id} onClick={() => openTask(t.id)} className="press anim-rise group flex max-w-full min-w-0 items-center gap-2 rounded-full border border-line bg-card py-1.5 pr-2.5 pl-2.5 text-xs text-muted shadow-[var(--shadow-sheet)] hover:text-fg">
      {t.stage === 'queued' ? <Clock size={14} className="shrink-0 text-accent" /> : <Loader2 size={14} className="shrink-0 animate-spin text-accent" />}
      <span className="truncate font-medium">{t.title}</span>
      <span className="progress hidden h-1 w-10 shrink-0 sm:block" />
      <ChevronRight size={13} className="shrink-0 text-faint transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
    </button>)}
  </div>
}

// ── Split-Pane Step Inspector Modal (Figma Section 38 B1 / B2 / B3) ──────────

function isStepOutputError(output: string | undefined): boolean {
  if (!output) return false
  const s = output.trim()
  if (!s) return false
  if (s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>
      if (parsed.ok === false) return true
      if (typeof parsed.error === 'string' && parsed.ok !== true) return true
      if (typeof parsed.exitCode === 'number' && parsed.exitCode !== 0) return true
    } catch {
      if (/"ok"\s*:\s*false/.test(s) || /^\{\s*"error"\s*:/.test(s)) return true
    }
  }
  if (/\[[^\]]*(?:退出码\s+(?!0\b)-?\d+|超时被终止)/.test(s)) return true
  if (/\b(?:exit(?:\s+_?code)?|exitCode)\s*[:=]\s*(?!0\b)-?\d+/i.test(s)) return true
  if (/^(?:Error:|Failed\b|Result:\s*Failed\b)/i.test(s) || /\bResult:\s*Failed\b/i.test(s)) return true
  if (/old_text 在文件中不存在|text not found|not applied|不在工作目录内|审核拦截了这条命令|被禁止/i.test(s)) return true
  return false
}

function relativePath(rawPath: unknown, dir?: string): string {
  const raw = String(rawPath ?? '').trim()
  if (!raw) return ''
  if (dir) {
    const cleanDir = dir.replace(/\/+$/, '')
    if (raw === cleanDir) return '.'
    if (raw.startsWith(`${cleanDir}/`)) return raw.slice(cleanDir.length + 1)
  }
  return raw
}

function baseName(rawPath: unknown): string {
  const raw = String(rawPath ?? '').trim().replace(/\/+$/, '')
  return raw.split('/').pop() || 'snippet.txt'
}

function guessLang(rawPath: unknown): string {
  const name = String(rawPath ?? '').toLowerCase()
  if (name.endsWith('.md') || name.endsWith('.mdx')) return 'markdown'
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.mjs')) return 'javascript'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.sh') || name.endsWith('.zsh') || name.endsWith('.bash')) return 'bash'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.html')) return 'html'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.conf') || name.endsWith('.ini') || name.endsWith('.env')) return 'config'
  return 'text'
}

function formatJsonOrText(raw: string | undefined): string {
  if (!raw) return ''
  const s = raw.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2)
    } catch {
      return raw
    }
  }
  return raw
}

function fmtInspectorElapsed(startAt: number, endOrNow: number): string {
  const sec = Math.max(0, Math.floor((endOrNow - startAt) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const hmSec = (at: number) =>
  new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function describeInspectorStep(
  tool: string,
  input: any,
  status: 'running' | 'done' | 'failed',
  dir?: string,
  ticketTitle?: string,
  isAction?: boolean,
): { icon: LucideIcon; title: string } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  const short = (v: unknown, n = 64) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim()
    return s.length > n ? `${s.slice(0, n)}…` : s
  }
  const rel = (p: unknown) => relativePath(p, dir) || '文件'

  switch (tool) {
    case 'edit_file': {
      const p = rel(i.path)
      return {
        icon: FileText,
        title: status === 'running' ? tx('正在编辑 {0}', p) : status === 'failed' ? tx('编辑 {0} 失败', p) : tx('已编辑 {0}', p),
      }
    }
    case 'write_file': {
      const p = rel(i.path)
      return {
        icon: FileText,
        title: status === 'running' ? tx('正在写入 {0}', p) : status === 'failed' ? tx('写入 {0} 失败', p) : tx('已写入 {0}', p),
      }
    }
    case 'read_file': {
      const p = rel(i.path)
      return {
        icon: FileText,
        title: status === 'running' ? tx('正在读取 {0}', p) : status === 'failed' ? tx('读取 {0} 失败', p) : tx('已读取 {0}', p),
      }
    }
    case 'list_dir':
    case 'find_files': {
      const p = rel(i.path ?? '.')
      return {
        icon: FolderOpen,
        title: status === 'running' ? tx('正在浏览 {0}', p) : status === 'failed' ? tx('浏览 {0} 失败', p) : tx('已浏览 {0}', p),
      }
    }
    case 'shell':
    case 'local_shell':
    case 'computer': {
      const cmd = short(i.command ?? i.cmd ?? '', 58) || tx('命令')
      return {
        icon: SquareTerminal,
        title: status === 'running' ? tx('正在运行 {0}', cmd) : status === 'failed' ? tx('运行 {0} 失败', cmd) : tx('已运行 {0}', cmd),
      }
    }
    case 'job_status':
    case 'local_job_status':
      return {
        icon: SquareTerminal,
        title: status === 'running' ? tx('正在检查后台日志进程 (job_status)') : status === 'failed' ? tx('检查后台日志进程失败') : tx('已检查后台日志进程 (job_status)'),
      }
    case 'job_stop':
    case 'local_job_stop':
      return { icon: SquareTerminal, title: tx('终止后台进程') }
    case 'web_fetch':
    case 'browser_open': {
      const url = short(i.url, 56) || tx('网页')
      return {
        icon: Globe,
        title: status === 'running' ? tx('正在访问 {0}', url) : status === 'failed' ? tx('访问 {0} 失败', url) : tx('已访问 {0}', url),
      }
    }
    case 'browser_click':
    case 'browser_type':
    case 'browser_snapshot':
    case 'browser_screenshot':
      return { icon: MousePointerClick, title: status === 'running' ? tx('正在操作浏览器') : tx('在浏览器里操作') }
    case 'request_handoff':
      return { icon: Hand, title: tx('请你接管浏览器') }
    case 'recall':
      return { icon: History, title: tx('回顾之前的记录') }
    case 'remember':
      return { icon: Brain, title: status === 'failed' ? tx('记下新记忆失败') : tx('记下新记忆') }
    case 'search_memory':
      return { icon: Brain, title: tx('翻看记忆') }
    case 'subagent_start':
      return { icon: Users, title: tx('分出一个子任务：{0}', short(i.job, 48)) }
    case 'subagent_stop':
      return { icon: Users, title: tx('停下一个子任务') }
    case 'report':
      return {
        icon: NotebookPen,
        title: i.status === 'ready' ? tx('整理好结果') : i.status === 'waiting' ? tx('有问题要问你') : i.status === 'progress' ? tx('告一段落，等后续') : i.status === 'dropped' ? tx('判断不需要做') : tx('说明遇到的问题'),
      }
    case 'handback':
      return { icon: CornerUpLeft, title: tx('把一条无关的消息转回去') }
    case 'github_follow':
      return { icon: Link2, title: tx('关注一个 GitHub 讨论') }
    case 'get_my_settings':
      return { icon: FileText, title: tx('读取当前助理设置 (get_my_settings)') }
    case 'update_my_settings':
    case 'update_instructions':
    case 'update_proactive':
    case 'schedule_routine':
    case 'update_routine':
    case 'propose_skill':
      return {
        icon: CheckCircle2,
        title: isAction && ticketTitle ? (status === 'failed' ? `${ticketTitle}失败` : ticketTitle) : tx('更新助理设置 ({0})', tool),
      }
    default: {
      const clean = tool.replace(/^mcp_/, '').replace(/_/g, ' ')
      return {
        icon: Dot,
        title: status === 'running' ? tx('正在执行 {0}', clean) : status === 'failed' ? tx('执行 {0} 失败', clean) : clean,
      }
    }
  }
}

type InspectorNode =
  | { id: 'start'; kind: 'start'; title: string; at: number }
  | {
      id: string
      kind: 'step'
      callId: string
      tool: string
      input: any
      output?: string
      status: 'running' | 'done' | 'failed'
      icon: LucideIcon
      title: string
      note?: string
      at: number
    }
  | { id: 'end'; kind: 'end'; title: string; completed: boolean; at: number }

function buildInspectorNodes(d: TicketDetail, isLiveRunning: boolean): InspectorNode[] {
  const { ticket: t, transcript } = d
  const nodes: InspectorNode[] = [
    {
      id: 'start',
      kind: 'start',
      title: isLiveRunning ? `${tx('已开始')} (${hmSec(t.createdAt)})` : tx('已开始'),
      at: t.createdAt,
    },
  ]

  const allToolCalls = transcript.filter(i => i.kind === 'tool-call') as Extract<TranscriptItem, { kind: 'tool-call' }>[]
  const resultsByCallId = new Map<string, Extract<TranscriptItem, { kind: 'tool-result' }>>()
  for (const item of transcript) {
    if (item.kind === 'tool-result') resultsByCallId.set(item.callId, item)
  }

  const hasNonReportCalls = allToolCalls.some(c => c.tool !== 'report' && c.tool !== 'handback')

  transcript.forEach((item, idx) => {
    if (item.kind !== 'tool-call') return
    if (t.stage === 'ended' && hasNonReportCalls && (item.tool === 'report' || item.tool === 'handback')) return

    const res = resultsByCallId.get(item.callId)
    let status: 'running' | 'done' | 'failed'
    if (!res) {
      if (isLiveRunning || t.stage === 'working') status = 'running'
      else if (t.ended?.outcome === 'completed') status = 'done'
      else status = 'failed'
    } else {
      status = isStepOutputError(res.output) ? 'failed' : 'done'
    }

    // Collect any assistant reasoning or text between this tool-call and the next tool-call
    const noteParts: string[] = []
    for (let j = idx + 1; j < transcript.length; j++) {
      const next = transcript[j]!
      if (next.kind === 'tool-call') break
      if ((next.kind === 'text' || next.kind === 'reasoning') && next.text.trim()) {
        noteParts.push(next.text.trim())
      }
    }

    const { icon, title } = describeInspectorStep(item.tool, item.input, status, t.directory, t.title, t.kind === 'action')
    nodes.push({
      id: item.id,
      kind: 'step',
      callId: item.callId,
      tool: item.tool,
      input: item.input,
      ...(res ? { output: res.output } : {}),
      status,
      icon,
      title,
      ...(noteParts.length ? { note: noteParts.join('\n\n') } : {}),
      at: item.at,
    })
  })

  if (t.stage === 'ended' && !isLiveRunning) {
    const completed = t.ended?.outcome === 'completed'
    nodes.push({
      id: 'end',
      kind: 'end',
      title: completed ? tx('已完成') : endedText(t),
      completed,
      at: t.ended?.at ?? t.updatedAt,
    })
  }

  return nodes
}

function CodeInspectorCard({ lang, content, filename }: { lang: string; content: string; filename?: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void navigator.clipboard?.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const onDownload = () => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const ext = lang.startsWith('markdown') ? 'md' : lang.startsWith('bash') ? 'sh' : lang.startsWith('json') ? 'json' : lang.startsWith('typescript') ? 'ts' : 'txt'
    a.download = filename || `snippet.${ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 500)
  }
  const isTerminal = lang.startsWith('terminal')
  return (
    <div className="rounded-[12px] border border-code-border bg-code-bg px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="font-mono text-[11px] text-muted select-none">{lang}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDownload}
            aria-label={tx('下载代码片段')}
            title={tx('下载')}
            className="press flex size-6 items-center justify-center rounded-md text-muted hover:bg-fg/6 hover:text-fg"
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            onClick={onCopy}
            aria-label={tx('复制代码片段')}
            title={copied ? tx('已复制') : tx('复制')}
            className="press flex size-6 items-center justify-center rounded-md text-muted hover:bg-fg/6 hover:text-fg"
          >
            {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
          </button>
        </div>
      </div>
      <pre
        className={cx(
          'max-h-[250px] overflow-auto font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap break-words',
          isTerminal ? 'text-terminal-fg' : 'text-code-fg',
        )}
      >
        {content}
      </pre>
    </div>
  )
}

function EditFileResultView({
  output,
  status,
  lang,
  filename,
}: {
  output: string | undefined
  status: 'running' | 'done' | 'failed'
  lang: string
  filename: string
}) {
  if (!output) {
    return (
      <div className="text-[12.5px] text-muted">
        <span className="font-semibold text-fg">Result: </span>
        {status === 'running' ? tx('正在应用文件修改…') : status === 'failed' ? 'Failed.' : tx('修改已应用。')}
      </div>
    )
  }

  const s = output.trim()
  const snippetIdx = s.indexOf('snippet:\n')
  if (snippetIdx !== -1) {
    const before = s.slice(0, snippetIdx + 'snippet:'.length).trim()
    const after = s.slice(snippetIdx + 'snippet:\n'.length)
    const lines = before.split('\n').map(l => l.trim()).filter(Boolean)
    const tailSplit = after.lastIndexOf('\nThe edit was not applied')
    const snippetCode = tailSplit !== -1 ? after.slice(0, tailSplit).trim() : after.trim()
    const footerLine = tailSplit !== -1 ? after.slice(tailSplit + 1).trim() : ''
    return (
      <div className="space-y-2.5 text-[12.5px] leading-[18px]">
        {lines.map((line, idx) => (
          <div key={idx} className={idx === 0 ? 'font-medium text-fg' : 'text-muted'}>
            {line}
          </div>
        ))}
        <CodeInspectorCard lang={lang} content={snippetCode} filename={filename} />
        {footerLine && <div className="text-[12px] text-muted">{footerLine}</div>}
      </div>
    )
  }

  if (status === 'failed' && /old_text 在文件中不存在|text not found/i.test(s)) {
    return (
      <div className="space-y-2 text-[12.5px] leading-[18px]">
        <div className="font-medium text-fg">
          Result: Failed. The tool reported <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px]">text not found</code> for the old text.
        </div>
        <div className="text-[12px] text-muted">{s}</div>
        <div className="text-[12px] text-muted">The edit was not applied because the exact old text was not present.</div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 text-[12.5px] leading-[18px]">
      <div className="font-medium text-fg">
        Result: <span className="font-normal text-muted">{s.length <= 160 ? s : status === 'failed' ? 'Failed.' : 'Success.'}</span>
      </div>
      {s.length > 160 && <CodeInspectorCard lang="text" content={s} filename="edit-result.txt" />}
    </div>
  )
}

function StepDetailPane({
  node,
  d,
  isLatestStep,
  liveWorkerText,
  onSelectStep,
}: {
  node: InspectorNode
  d: TicketDetail
  isLatestStep: boolean
  liveWorkerText: string
  onSelectStep(id: string): void
}) {
  const t = d.ticket

  if (node.kind === 'start') {
    const firstInput = d.transcript.find(i => i.kind === 'input') as Extract<TranscriptItem, { kind: 'input' }> | undefined
    return (
      <div className="space-y-4">
        <h3 className="text-[17px] font-bold tracking-tight text-fg">{tx('任务起点与上下文')}</h3>
        {t.proactive && t.why && (
          <div className="flex gap-2 rounded-[14px] bg-accent-soft px-3.5 py-3 text-[13px] text-pretty">
            <Sparkles size={15} className="mt-0.5 shrink-0 text-accent" />
            <span>{tx('没人找我，是按你的主动策略做的：{0}', t.why)}</span>
          </div>
        )}
        <div className="rounded-[12px] border border-line bg-sunken/60 px-4 py-3 text-[12.5px] leading-6">
          <div className="grid grid-cols-[5.5em_1fr] gap-x-3 gap-y-1.5">
            <span className="text-muted">{tx('开始时间')}</span>
            <span className="font-mono text-fg tabular-nums">
              {new Date(t.createdAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
            </span>
            {t.directory && (
              <>
                <span className="text-muted">{tx('工作目录')}</span>
                <span className="break-all font-mono text-fg">{t.directory}</span>
              </>
            )}
            <span className="text-muted">{tx('来源')}</span>
            <span className="text-fg">{t.kind === 'action' ? tx('主 Agent 实时操作') : t.source}</span>
          </div>
        </div>
        {firstInput?.text && (
          <div className="space-y-1.5">
            <div className="text-[12.5px] font-semibold text-fg">{tx('触发指令 / 输入上下文')}:</div>
            <CodeInspectorCard lang="markdown" content={firstInput.text} filename="prompt.md" />
          </div>
        )}
      </div>
    )
  }

  if (node.kind === 'end') {
    const report = t.latestReport
    const stepNodes = buildInspectorNodes(d, false).filter((n): n is Extract<InspectorNode, { kind: 'step' }> => n.kind === 'step')
    return (
      <div className="space-y-4">
        <h3 className="text-[17px] font-bold tracking-tight text-fg">
          {node.completed ? tx('任务执行结果') : tx('任务已停下')}
        </h3>
        {(report?.summary || t.ended?.reason) && (
          <div className="prose-chat rounded-[14px] border border-line bg-sunken/60 px-4 py-3 text-[13px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{report?.summary || t.ended?.reason || endedText(t)}</ReactMarkdown>
          </div>
        )}
        {d.files && d.files.length > 0 && (
          <div className="space-y-2">
            <div className="text-[12.5px] font-semibold text-fg">{tx('产出文件')}</div>
            <div className="flex flex-wrap items-start gap-2">
              {d.files.map(f => <FileChip key={f.id} {...f} />)}
            </div>
          </div>
        )}
        {stepNodes.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[12.5px] font-semibold text-fg">{tx('步骤摘要（点击左侧或下方步骤查看输入/输出）')}</div>
            <div className="divide-y divide-line rounded-[12px] border border-line bg-sunken/40">
              {stepNodes.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectStep(s.id)}
                  className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left text-[12.5px] transition-colors hover:bg-sunken"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 font-mono text-[11px] text-faint tabular-nums">{idx + 1}.</span>
                    <span className={cx('truncate', s.status === 'failed' ? 'text-danger' : 'text-fg')}>{s.title}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{tx('查看详情')} &gt;</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-[11.5px] text-faint tabular-nums">
          <span>
            {tx('完成于')} {new Date(node.at).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
          </span>
          <span>
            {tx('总耗时')} {fmtInspectorElapsed(t.createdAt, node.at)}
          </span>
          {d.usage.tokens > 0 && (
            <span>
              {fmtTokens(d.usage.tokens)} tokens{d.usage.costUsd ? tx('（约 ${0}）', d.usage.costUsd.toFixed(2)) : ''}
            </span>
          )}
        </div>
      </div>
    )
  }

  // Step node
  const i = (node.input && typeof node.input === 'object' ? node.input : {}) as Record<string, any>
  const workerNote = node.note || (isLatestStep && liveWorkerText ? liveWorkerText : '')

  if (node.tool === 'edit_file') {
    const rawPath = String(i.path ?? '')
    const relPath = relativePath(rawPath, t.directory) || rawPath || 'file'
    const lang = guessLang(rawPath)
    const fname = baseName(rawPath)
    const newText = String(i.new_text ?? i.newText ?? i.new_string ?? i.content ?? '')
    const oldText = String(i.old_text ?? i.oldText ?? i.old_string ?? '')
    return (
      <div className="space-y-3">
        <h3 className="text-[17px] font-bold tracking-tight text-fg">{node.title}</h3>
        <div className="text-[12.5px] text-fg">
          Attempted edit to <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px]">{relPath}</code>{' '}
          (path <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px]">{rawPath || relPath}</code>):
        </div>
        <div className="space-y-1.5">
          <div className="text-[12.5px] font-semibold text-fg">New text:</div>
          <CodeInspectorCard lang={lang} content={newText || '(empty)'} filename={fname} />
        </div>
        <div className="space-y-1.5">
          <div className="text-[12.5px] font-semibold text-fg">Old text provided:</div>
          <CodeInspectorCard lang={lang} content={oldText || '(empty)'} filename={fname} />
        </div>
        <EditFileResultView output={node.output} status={node.status} lang={lang} filename={fname} />
        {workerNote && <WorkerNoteCard note={workerNote} running={node.status === 'running'} />}
      </div>
    )
  }

  if (node.tool === 'write_file' || node.tool === 'read_file') {
    const rawPath = String(i.path ?? '')
    const relPath = relativePath(rawPath, t.directory) || rawPath || 'file'
    const lang = guessLang(rawPath)
    const fname = baseName(rawPath)
    const isWrite = node.tool === 'write_file'
    const bodyContent = isWrite
      ? String(i.content ?? '')
      : (node.output ?? (node.status === 'running' ? tx('正在读取文件内容…') : '(空文件)'))
    return (
      <div className="space-y-3">
        <h3 className="text-[17px] font-bold tracking-tight text-fg">{node.title}</h3>
        <div className="text-[12.5px] text-fg">
          {isWrite ? 'Attempted write to' : 'Read file'}{' '}
          <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px]">{relPath}</code>{' '}
          (path <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px]">{rawPath || relPath}</code>):
        </div>
        <div className="space-y-1.5">
          <div className="text-[12.5px] font-semibold text-fg">{isWrite ? 'New text:' : 'File content:'}</div>
          <CodeInspectorCard lang={lang} content={bodyContent} filename={fname} />
        </div>
        {isWrite && (
          <div className="text-[12.5px] text-muted">
            <span className="font-semibold text-fg">Result: </span>
            {node.output || (node.status === 'running' ? tx('正在写入…') : 'Success.')}
          </div>
        )}
        {workerNote && <WorkerNoteCard note={workerNote} running={node.status === 'running'} />}
      </div>
    )
  }

  if (node.tool === 'shell' || node.tool === 'local_shell' || node.tool === 'computer') {
    const cmd = String(i.command ?? i.cmd ?? '')
    const workDir = String(i.cwd ?? t.directory ?? '~')
    return (
      <div className="space-y-3">
        <h3 className="text-[17px] font-bold tracking-tight text-fg">{node.title}</h3>
        <div className="text-[12.5px] text-muted">
          Running shell command in <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-fg">{workDir}</code>
          {node.status === 'running' ? ' (streaming stdout):' : ':'}
        </div>
        <div className="space-y-1.5">
          <div className="text-[12.5px] font-semibold text-fg">Command:</div>
          <CodeInspectorCard lang="bash" content={cmd || '(empty command)'} filename="command.sh" />
        </div>
        <div className="space-y-1.5">
          <div className="text-[12.5px] font-semibold text-fg">Live Output (stdout / stderr):</div>
          <CodeInspectorCard
            lang={node.status === 'running' ? 'terminal · streaming' : 'terminal'}
            content={node.output || (node.status === 'running' ? tx('正在等待实时终端输出…') : tx('(无终端输出)'))}
            filename="terminal.log"
          />
        </div>
        {workerNote && <WorkerNoteCard note={workerNote} running={node.status === 'running'} />}
      </div>
    )
  }

  // Settings / Router action or other generic tool calls
  return (
    <div className="space-y-3">
      <h3 className="text-[17px] font-bold tracking-tight text-fg">{node.title}</h3>
      {t.kind === 'action' && t.latestReport?.summary && (
        <div className="rounded-[12px] border border-line bg-sunken/60 px-3.5 py-2.5 text-[12.5px] text-fg">
          {t.latestReport.summary}
        </div>
      )}
      <div className="space-y-1.5">
        <div className="text-[12.5px] font-semibold text-fg">Parameters ({node.tool}):</div>
        <CodeInspectorCard lang="json" content={JSON.stringify(i, null, 2)} filename={`${node.tool}-input.json`} />
      </div>
      <div className="space-y-1.5">
        <div className="text-[12.5px] font-semibold text-fg">Result:</div>
        <CodeInspectorCard
          lang={node.output?.trim().startsWith('{') ? 'json' : 'text'}
          content={formatJsonOrText(node.output) || (node.status === 'running' ? tx('正在执行…') : tx('已完成'))}
          filename={`${node.tool}-result.txt`}
        />
      </div>
      {workerNote && <WorkerNoteCard note={workerNote} running={node.status === 'running'} />}
    </div>
  )
}

function WorkerNoteCard({ note, running }: { note: string; running: boolean }) {
  return (
    <div className="space-y-1.5 pt-1">
      <div className="text-[12.5px] font-semibold text-fg">Worker note:</div>
      <div className="rounded-[12px] border border-border-running bg-surface-running px-3.5 py-2.5 text-[12px] leading-[18px] text-fg">
        <div className="mb-1 text-[11.5px] font-semibold text-fg-running">
          {running ? tx('实时推理进展') : tx('推理与诊断记录')}
        </div>
        <div className="prose-chat text-[12px] leading-[18px] text-fg">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{note}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}

export function TaskDrawer() {
  const { shown: id, leaving } = usePresence(useOpenTask())
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: ['ticket', id],
    enabled: Boolean(id),
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
  })
  const liveRunning = useLive(s => (id ? s.workerState[id] === 'running' : false))
  const liveWorkerText = useLive(s => (id ? s.workerText[id] ?? '' : ''))
  const stop = useMutation({
    mutationFn: () => api.post(`/tickets/${id}/stop`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tickets'] })
      qc.invalidateQueries({ queryKey: ['ticket', id] })
    },
  })
  const retry = useMutation({
    mutationFn: () => api.post(`/tickets/${id}/retry`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tickets'] })
      qc.invalidateQueries({ queryKey: ['ticket', id] })
    },
  })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [userPicked, setUserPicked] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setSelectedId(null)
    setUserPicked(false)
  }, [id])

  const d = detail.data
  const t = d?.ticket
  const isRunning = Boolean(liveRunning || d?.running || t?.stage === 'working' || t?.stage === 'queued')

  useEffect(() => {
    if (!id || !isRunning) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [id, isRunning])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') openTask(null) }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  if (!id) return null

  const nodes = d ? buildInspectorNodes(d, isRunning) : []
  const stepNodes = nodes.filter((n): n is Extract<InspectorNode, { kind: 'step' }> => n.kind === 'step')

  // Compute effective selected node:
  const activeId = (() => {
    if (!nodes.length) return null
    if (userPicked && selectedId && nodes.some(n => n.id === selectedId)) return selectedId
    if (isRunning) {
      const runningStep = [...stepNodes].reverse().find(n => n.status === 'running')
      return runningStep?.id ?? stepNodes.at(-1)?.id ?? 'start'
    }
    if (selectedId && nodes.some(n => n.id === selectedId)) return selectedId
    const failedStep = stepNodes.find(n => n.status === 'failed')
    if (failedStep) return failedStep.id
    if (t?.kind === 'action' || (!t?.latestReport?.summary && !d?.files?.length)) {
      return stepNodes.at(-1)?.id ?? 'end'
    }
    return stepNodes[0]?.id ?? 'end'
  })()

  const activeNode = nodes.find(n => n.id === activeId) ?? nodes[0] ?? null
  const isLatestStep = Boolean(activeNode && activeNode.kind === 'step' && stepNodes.at(-1)?.id === activeNode.id)
  const stepCount = Math.max(1, stepNodes.length || t?.stepCount || 1)
  const mmss = t ? fmtInspectorElapsed(t.createdAt, isRunning ? now : (t.ended?.at ?? t.updatedAt)) : '00:00'

  return (
    <div
      className={cx('anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-3 sm:p-4', leaving && 'out-fade')}
      onMouseDown={e => { if (e.target === e.currentTarget) openTask(null) }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t?.title ?? tx('任务')}
        className={cx(
          'anim-pop flex h-[min(656px,88dvh)] w-[min(888px,calc(100vw-24px))] flex-col overflow-hidden rounded-[24px] border border-line bg-card shadow-2xl',
          leaving && 'out-pop',
        )}
      >
        {/* Top Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            {t && (
              <div className="mb-1.5 flex items-center gap-2">
                {isRunning ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-pill-running px-2.5 py-0.5 text-[11.5px] font-semibold text-fg-running tabular-nums">
                    <span className="size-1.5 animate-pulse rounded-full bg-fg-running" />
                    {tx('正在执行')} · {tx('第 {0} 步', stepCount)} · {mmss}
                  </span>
                ) : t.stage.startsWith('person/') ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-warn">
                    {STATE_TEXT[t.stage]}
                  </span>
                ) : t.ended?.outcome === 'completed' ? (
                  <span className="inline-flex items-center rounded-full bg-ok-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-ok">
                    {tx('已完成')}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-danger-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-danger">
                    {t.ended?.outcome === 'dropped' ? tx('不需要做') : tx('已停下')}
                  </span>
                )}
              </div>
            )}
            <h2 className="truncate font-display text-[19px] font-bold tracking-tight text-fg">
              {t?.title ?? '…'}
            </h2>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {t?.conversationId && (
              <button
                type="button"
                onClick={() => { go(`/c/${t.conversationId}`); openTask(null) }}
                className="press inline-flex h-[30px] items-center rounded-full border border-line bg-card px-3 text-[12px] font-medium text-fg hover:bg-sunken"
              >
                {tx('回到对话')}
              </button>
            )}
            {t && t.stage !== 'ended' && t.kind !== 'action' && (
              <button
                type="button"
                disabled={stop.isPending}
                onClick={() => { if (confirm(tx('停下「{0}」？', t.title))) stop.mutate() }}
                className="press inline-flex h-[30px] items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-3 text-[12px] font-semibold text-danger hover:bg-danger/15 disabled:opacity-50"
              >
                <span className="size-2 rounded-[2px] bg-danger" />
                {tx('停下')}
              </button>
            )}
            {t && t.kind !== 'action' && (t.stage === 'person/failed' || (t.stage === 'ended' && t.ended?.outcome === 'stopped')) && (
              <button
                type="button"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
                className="press inline-flex h-[30px] items-center gap-1 rounded-full border border-line bg-card px-3 text-[12px] font-medium text-fg hover:bg-sunken disabled:opacity-50"
              >
                <RotateCcw size={12} />
                {tx('重试')}
              </button>
            )}
            <button
              type="button"
              aria-label={tx('关闭')}
              title={tx('关闭')}
              onClick={() => openTask(null)}
              className="press flex size-[30px] items-center justify-center rounded-full bg-sunken text-muted hover:text-fg"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Split-Pane Body */}
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Left Timeline Column (252px) */}
          <div className="flex max-h-[185px] w-full shrink-0 flex-col gap-1 overflow-y-auto border-b border-line bg-inspector-rail p-3.5 sm:max-h-none sm:w-[252px] sm:border-r sm:border-b-0">
            {nodes.map(n => {
              const selected = n.id === activeNode?.id
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(n.id)
                    setUserPicked(true)
                  }}
                  className={cx(
                    'flex w-full items-start gap-2.5 rounded-[12px] px-3 py-2 text-left text-[12.5px] leading-[17px] transition-colors',
                    selected
                      ? 'bg-inspector-active font-medium text-fg'
                      : 'text-muted hover:bg-sunken hover:text-fg',
                  )}
                >
                  {n.kind === 'start' ? (
                    <span className="mt-[4px] flex size-[15px] shrink-0 items-center justify-center">
                      <span className="size-[5px] rounded-full bg-muted" />
                    </span>
                  ) : n.kind === 'end' ? (
                    n.completed ? (
                      <span className="mt-[1px] flex size-[15px] shrink-0 items-center justify-center rounded-full bg-fg text-bg">
                        <Check size={10} strokeWidth={3} />
                      </span>
                    ) : (
                      <XCircle size={15} className="mt-[1px] shrink-0 text-danger" />
                    )
                  ) : n.status === 'running' ? (
                    <Loader2 size={15} className="mt-[1px] shrink-0 animate-spin text-fg-running" />
                  ) : n.status === 'failed' ? (
                    <XCircle size={15} className={cx('mt-[1px] shrink-0', selected ? 'text-fg' : 'text-danger')} />
                  ) : (
                    <n.icon size={15} className="mt-[1px] shrink-0 text-muted" />
                  )}
                  <span className="min-w-0 flex-1 break-words">{n.title}</span>
                </button>
              )
            })}

            {d && d.jobs.length > 0 && (
              <div className="mt-auto pt-2">
                <div className="rounded-[11px] border border-border-running bg-surface-running px-2.5 py-2">
                  <div className="text-[11px] font-semibold text-fg-running">
                    {tx('{0} 个后台命令持续运行中', d.jobs.length)}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted">
                    {d.jobs[0]!.command}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right Inspector Detail Column */}
          <div className="min-w-0 flex-1 overflow-y-auto bg-card px-6 py-5 sm:px-7">
            {!d || !activeNode ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
                <Loader2 size={15} className="animate-spin" />
                {tx('正在加载步骤详情…')}
              </div>
            ) : (
              <StepDetailPane
                node={activeNode}
                d={d}
                isLatestStep={isLatestStep}
                liveWorkerText={liveWorkerText}
                onSelectStep={stepId => {
                  setSelectedId(stepId)
                  setUserPicked(true)
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** A delivered file: images show as themselves; anything else opens a preview in place. */
export function FileChip({ id, name, size }: { id: string; name: string; size: number }) {
  const [open, setOpen] = useState(false)
  const kind = previewKind(name)
  const Icon = kind === 'html' ? AppWindow : kind === 'csv' ? Table2 : kind === 'image' ? ImageIcon : FileText
  return <>
    {kind === 'image' ? <button onClick={() => setOpen(true)} className="press block overflow-hidden rounded-2xl border border-line hover:border-accent" title={name}>
      <img src={`/api/artifacts/${id}`} alt={name} className="max-h-48 max-w-72 object-cover" />
    </button> : <button onClick={() => setOpen(true)}
      className="press flex max-w-full min-w-0 items-center gap-2.5 rounded-2xl border border-line bg-panel py-2 pr-3 pl-2 text-left text-sm hover:border-accent">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><Icon size={16} /></span>
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-xs text-faint tabular-nums">{kind === 'html' ? tx('可交互') : fmtSize(size)}</span>
    </button>}
    {open && <ArtifactModal id={id} name={name} onClose={() => setOpen(false)} />}
  </>
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
