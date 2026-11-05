/**
 * The work behind the conversation, shown the way a person would describe it:
 * - in the chat, only what needs the owner (a yes/no, a question, taking over the browser, a problem) and a quiet "working on…" line;
 * - everything else — what was done, step by step — is one click away in the activity view, never in the conversation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, AppWindow, CheckCircle2, Image as ImageIcon, Table2, ChevronDown, ChevronRight, CircleDot, Clock, FileText, Globe, Hand, Loader2, MessageCircleQuestion, OctagonX, RotateCcw, ShieldAlert, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Stage, type Ticket, type TicketDetail, type TranscriptItem } from './api'
import { openTask, useLive, useOpenTask } from './live'
import { go } from './route'
import { Button, cx } from './ui'
import { HandoffModal } from './handoff'
import { ArtifactModal, previewKind } from './preview'

export const useTickets = () => useQuery({ queryKey: ['tickets'], queryFn: () => api.get<{ tickets: Ticket[] }>('/tickets') })

/** What a stage means to the owner, in plain words. */
export const STATE_TEXT: Record<Stage, string> = {
  'person/approve': '等你点头', 'person/answer': '等你回复', 'person/blocked': '卡住了', 'person/failed': '出了问题',
  queued: '马上开始', working: '正在做', idle: '在等后续', ended: '已结束',
}
export const endedText = (t: Ticket) => (t.ended?.outcome === 'completed' ? '完成了' : t.ended?.outcome === 'dropped' ? '不需要做' : '停下了')
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
export function NeedsYou({ t, onAnswer }: { t: Ticket; onAnswer(text: string, ticketId: string): void }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['tickets'] })
  const decide = useMutation({ mutationFn: (v: { id: string; approve: boolean; note?: string; scope?: 'task' }) => api.post(`/approvals/${v.id}`, { approve: v.approve, ...(v.note ? { note: v.note } : {}), ...(v.scope ? { scope: v.scope } : {}) }),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['grants'] }) } })
  const retry = useMutation({ mutationFn: () => api.post(`/tickets/${t.id}/retry`), onSuccess: refresh })
  const stop = useMutation({ mutationFn: () => api.post(`/tickets/${t.id}/stop`), onSuccess: refresh })
  const [handoff, setHandoff] = useState<string | null>(null)
  const [detail, setDetail] = useState(false)

  const shell = (children: React.ReactNode) => <div className="rounded-2xl border border-line bg-panel px-4 py-3 shadow-sm">{children}</div>

  if (t.approvals.length) {
    const a = t.approvals[0]!
    return shell(<>
      <div className="flex items-center gap-1.5 text-sm font-medium"><ShieldAlert size={15} className="text-warn" />这一步要你同意{a.risk === 'destructive' ? '（不可撤销）' : ''}</div>
      <div className="mt-1 text-sm text-muted">{a.reason}</div>
      <button onClick={() => setDetail(v => !v)} className="mt-1.5 flex items-center gap-0.5 text-xs text-faint hover:text-muted">{detail ? <ChevronDown size={12} /> : <ChevronRight size={12} />}具体操作</button>
      {detail && <pre className="mt-1 overflow-x-auto rounded-lg bg-sunken px-3 py-2 font-mono text-xs whitespace-pre-wrap">{a.command}</pre>}
      <div className="mt-2.5 flex gap-1.5">
        <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, approve: true })}>同意这一次</Button>
        {a.risk !== 'destructive' && <Button size="sm" disabled={decide.isPending} title="这件事做完之前，同类操作不再问你" onClick={() => decide.mutate({ id: a.id, approve: true, scope: 'task' })}>这件事里都同意</Button>}
        <Button size="sm" disabled={decide.isPending} onClick={() => { const note = prompt('不同意的原因（可留空）') ?? undefined; decide.mutate({ id: a.id, approve: false, ...(note ? { note } : {}) }) }}>不同意</Button>
      </div>
      {t.approvals.length > 1 && <div className="mt-1.5 text-xs text-faint">还有 {t.approvals.length - 1} 步也在等你</div>}
    </>)
  }
  if (t.attention?.kind === 'handoff') return shell(<>
    <div className="flex items-center gap-1.5 text-sm font-medium"><Globe size={15} className="text-warn" />需要你在浏览器里操作一下</div>
    <div className="mt-1 text-sm text-muted">{t.attention.question}</div>
    <Button size="sm" variant="primary" className="mt-2.5" onClick={() => setHandoff(t.attention!.question)}>打开浏览器</Button>
    {handoff && <HandoffModal ticketId={t.id} reason={handoff} onClose={() => setHandoff(null)} />}
  </>)
  if (t.attention?.options?.length) return shell(<div className="flex flex-wrap gap-1.5">
    {t.attention.options.map(o => <Button key={o} size="sm" onClick={() => onAnswer(o, t.id)}>{o}</Button>)}
  </div>)
  if (t.stage === 'person/blocked' || t.stage === 'person/failed') return shell(<div className="flex flex-wrap items-center gap-1.5">
    <span className="mr-auto text-sm text-muted">「{t.title}」{t.stage === 'person/failed' ? '出了问题' : '卡住了'}——可以直接回复我，或者：</span>
    <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}><RotateCcw size={13} />再试一次</Button>
    <Button size="sm" variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>算了</Button>
  </div>)
  return null
}

/** The quiet line under the conversation while work goes on; it opens what was done. */
export function WorkingLine({ tickets }: { tickets: Ticket[] }) {
  if (!tickets.length) return null
  return <div className="flex flex-wrap gap-x-3 gap-y-1">
    {tickets.map(t => <button key={t.id} onClick={() => openTask(t.id)} className="flex min-w-0 items-center gap-1.5 text-xs text-faint hover:text-muted" title="看看我做了什么">
      <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-50" /><span className="relative inline-flex size-2 rounded-full bg-accent" /></span>
      <span className="truncate">{t.stage === 'queued' ? '马上开始' : '正在处理'}：{t.title}</span>
    </button>)}
  </div>
}

// ── "What I did": the activity of one piece of work, told as steps ──────────

/** A step in plain words; the raw call stays one click away. */
function describeStep(tool: string, input: any): { icon: string; text: string } {
  const i = input ?? {}
  const short = (v: unknown, n = 80) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s }
  switch (tool) {
    case 'shell': return { icon: '⌘', text: `运行 ${short(i.command, 70)}` }
    case 'read_file': return { icon: '📄', text: `查看 ${short(i.path)}` }
    case 'write_file': return { icon: '✏️', text: `写入 ${short(i.path)}` }
    case 'edit_file': return { icon: '✏️', text: `修改 ${short(i.path)}` }
    case 'list_dir': return { icon: '📁', text: `浏览 ${short(i.path ?? '.')}` }
    case 'web_fetch': return { icon: '🌐', text: `阅读网页 ${short(i.url, 60)}` }
    case 'browser_open': return { icon: '🌐', text: `打开 ${short(i.url, 60)}` }
    case 'browser_click': case 'browser_type': case 'browser_snapshot': case 'browser_screenshot': return { icon: '🌐', text: '在浏览器里操作' }
    case 'request_handoff': return { icon: '🙋', text: '请你接管浏览器' }
    case 'job_status': case 'job_stop': return { icon: '⏳', text: '查看后台命令' }
    case 'recall': return { icon: '🔎', text: '回顾之前的记录' }
    case 'remember': return { icon: '🧠', text: '记下一条经验' }
    case 'search_memory': return { icon: '🧠', text: '翻看记忆' }
    case 'subagent_start': return { icon: '👥', text: `分出一个子任务：${short(i.job, 60)}` }
    case 'subagent_stop': return { icon: '👥', text: '停下一个子任务' }
    case 'report': return { icon: '📝', text: i.status === 'ready' ? '整理好结果' : i.status === 'waiting' ? '有问题要问你' : i.status === 'progress' ? '告一段落，等后续' : i.status === 'dropped' ? '判断不需要做' : '说明遇到的问题' }
    case 'handback': return { icon: '↩︎', text: '把一条无关的消息转回去' }
    case 'github_follow': return { icon: '🔗', text: '关注一个 GitHub 讨论' }
    default: return { icon: '•', text: tool.replace(/^mcp_/, '').replace(/_/g, ' ') }
  }
}

export function TaskDrawer() {
  const id = useOpenTask()
  const qc = useQueryClient()
  const detail = useQuery({ queryKey: ['ticket', id], enabled: Boolean(id), queryFn: () => api.get<TicketDetail>(`/tickets/${id}`) })
  const working = useLive(s => (id ? s.workerState[id] === 'running' : false))
  const stop = useMutation({ mutationFn: () => api.post(`/tickets/${id}/stop`), onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }) })
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [detail.data?.transcript.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') openTask(null) }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  if (!id) return null
  const d = detail.data
  const t = d?.ticket
  const steps = d ? toSteps(d.transcript, d.ticket.directory) : []
  const report = t?.latestReport
  return <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onMouseDown={e => { if (e.target === e.currentTarget) openTask(null) }}>
    <div className="flex h-full w-full max-w-xl flex-col border-l border-line bg-panel shadow-2xl">
      <div className="flex items-start gap-2 border-b border-line px-5 py-4">
        {t && <div className="mt-0.5"><StateIcon t={t} /></div>}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{t?.title ?? '…'}</div>
          {t && <div className="mt-0.5 text-xs text-muted">{t.stage === 'ended' ? endedText(t) : STATE_TEXT[t.stage]}{t.proactive ? ' · 我主动发现的' : ''} · {new Date(t.createdAt).toLocaleString()}{d && d.usage.tokens > 0 ? ` · ${fmtTokens(d.usage.tokens)} tokens${d.usage.costUsd ? `（约 $${d.usage.costUsd.toFixed(2)}）` : ''}` : ''}</div>}
        </div>
        {t?.conversationId && <Button size="sm" variant="ghost" onClick={() => { go(`/c/${t.conversationId}`); openTask(null) }}>回到对话</Button>}
        {t && t.stage !== 'ended' && <Button size="sm" variant="ghost" onClick={() => { if (confirm(`停下「${t.title}」？`)) stop.mutate() }}><Square size={12} />停下</Button>}
        <button onClick={() => openTask(null)} className="mt-0.5 text-faint hover:text-fg" aria-label="关闭"><X size={18} /></button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {t?.proactive && t.why && <div className="mb-4 flex gap-2 rounded-xl bg-accent-soft px-3 py-2.5 text-sm"><Sparkles size={15} className="mt-0.5 shrink-0 text-accent" />没人找我，是按你的主动策略做的：{t.why}</div>}
        {report && report.status !== 'progress' && report.summary && <section className="mb-5">
          <h3 className="mb-1.5 text-xs font-medium text-muted">{report.status === 'ready' ? '结果' : '最新情况'}</h3>
          <div className="prose-chat rounded-xl border border-line px-4 py-3 text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report.summary}</ReactMarkdown></div>
        </section>}
        <h3 className="mb-2 text-xs font-medium text-muted">我做了什么</h3>
        {!steps.length && <div className="text-sm text-faint">{working ? '刚开始…' : '还没有步骤'}</div>}
        <ol className="space-y-1">{steps.map(s => <Step key={s.id} step={s} />)}</ol>
        {working && <div className="mt-2 flex items-center gap-1.5 text-xs text-faint"><Loader2 size={12} className="animate-spin" />进行中</div>}
        {d && d.jobs.length > 0 && <div className="mt-3 text-xs text-faint">后台还在运行 {d.jobs.length} 个命令</div>}
      </div>
    </div>
  </div>
}

type StepItem = { id: string; icon: string; text: string; detail?: string; output?: string; pending?: boolean; kind: 'step' | 'note' | 'error' }

function toSteps(items: TranscriptItem[], dir: string): StepItem[] {
  // Paths read better relative to the working directory.
  const local = (v: unknown): any => (typeof v === 'string' ? v.split(`${dir}/`).join('').split(dir).join('.') : Array.isArray(v) ? v.map(local) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, local(x)])) : v)
  const out: StepItem[] = []
  items.forEach((item, i) => {
    if (item.kind === 'tool-call') {
      const result = items.slice(i + 1).find(r => r.kind === 'tool-result' && r.callId === item.callId) as Extract<TranscriptItem, { kind: 'tool-result' }> | undefined
      const { icon, text } = describeStep(item.tool, local(item.input))
      out.push({ id: item.id, icon, text, detail: JSON.stringify(item.input, null, 2), ...(result ? { output: result.output } : { pending: true }), kind: 'step' })
    } else if (item.kind === 'text' && item.text.trim()) out.push({ id: item.id, icon: '💬', text: item.text.trim().split('\n')[0]!.slice(0, 140), detail: item.text, kind: 'note' })
    else if (item.kind === 'marker' && item.type === 'error') out.push({ id: item.id, icon: '⚠️', text: `出错：${item.message ?? ''}`, kind: 'error' })
  })
  return out
}

function Step({ step }: { step: StepItem }) {
  const [open, setOpen] = useState(false)
  return <li>
    <button onClick={() => setOpen(v => !v)} className={cx('flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-sunken', step.kind === 'error' && 'text-danger', step.kind === 'note' && 'text-muted')}>
      <span className="w-5 shrink-0 text-center text-xs leading-5">{step.icon}</span>
      <span className="min-w-0 flex-1 break-words">{step.text}</span>
      {step.pending && <Loader2 size={12} className="mt-1 shrink-0 animate-spin text-faint" />}
    </button>
    {open && (step.detail || step.output) && <div className="mb-2 space-y-1.5 pl-9">
      {step.kind === 'note' ? <div className="prose-chat text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{step.detail!}</ReactMarkdown></div>
        : <pre className="overflow-x-auto rounded-lg bg-sunken px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{step.detail}</pre>}
      {step.output && <pre className="max-h-72 overflow-auto rounded-lg border border-line px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">{step.output}</pre>}
    </div>}
  </li>
}

/** A delivered file: images show as themselves; anything else opens a preview in place. */
export function FileChip({ id, name, size }: { id: string; name: string; size: number }) {
  const [open, setOpen] = useState(false)
  const kind = previewKind(name)
  const Icon = kind === 'html' ? AppWindow : kind === 'csv' ? Table2 : kind === 'image' ? ImageIcon : FileText
  return <>
    {kind === 'image' ? <button onClick={() => setOpen(true)} className="block overflow-hidden rounded-xl border border-line hover:border-accent" title={name}>
      <img src={`/api/artifacts/${id}`} alt={name} className="max-h-48 max-w-72 object-cover" />
    </button> : <button onClick={() => setOpen(true)}
      className="flex max-w-full min-w-0 items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-left text-sm hover:border-accent">
      <Icon size={16} className="shrink-0 text-accent" />
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-xs text-faint">{kind === 'html' ? '可交互' : fmtSize(size)}</span>
    </button>}
    {open && <ArtifactModal id={id} name={name} onClose={() => setOpen(false)} />}
  </>
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
