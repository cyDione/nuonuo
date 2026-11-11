/**
 * The work behind the conversation, shown the way a person would describe it:
 * - in the chat, only what needs the owner (a yes/no, a question, taking over the browser, a problem) and a quiet "working on…" line;
 * - everything else — what was done, step by step — is one click away in the activity view, never in the conversation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, AppWindow, Brain, CheckCircle2, Image as ImageIcon, Table2, ChevronDown, ChevronRight, CircleDot, Clock, CornerUpLeft, Dot, FileText, FolderOpen, Globe, Hand, History, Hourglass, Link2, Loader2, MessageCircleQuestion, MessageSquareText, MousePointerClick, NotebookPen, OctagonX, PencilLine, Repeat, RotateCcw, ShieldAlert, Sparkles, Square, SquareTerminal, Users, X, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Stage, type Ticket, type TicketDetail, type TranscriptItem } from './api'
import { openTask, useLive, useOpenTask } from './live'
import { go } from './route'
import { Button, cx, IconButton } from './ui'
import { getPrefs } from './prefs'
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

// ── "What I did": the activity of one piece of work, told as steps ──────────

/** A step in plain words; the raw call stays one click away. */
function describeStep(tool: string, input: any): { icon: LucideIcon; text: string } {
  const i = input ?? {}
  const short = (v: unknown, n = 80) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s }
  switch (tool) {
    case 'shell': return { icon: SquareTerminal, text: tx('运行 {0}', short(i.command, 70)) }
    case 'read_file': return { icon: FileText, text: tx('查看 {0}', short(i.path)) }
    case 'write_file': return { icon: PencilLine, text: tx('写入 {0}', short(i.path)) }
    case 'edit_file': return { icon: PencilLine, text: tx('修改 {0}', short(i.path)) }
    case 'list_dir': return { icon: FolderOpen, text: tx('浏览 {0}', short(i.path ?? '.')) }
    case 'web_fetch': return { icon: Globe, text: tx('阅读网页 {0}', short(i.url, 60)) }
    case 'browser_open': return { icon: Globe, text: tx('打开 {0}', short(i.url, 60)) }
    case 'browser_click': case 'browser_type': case 'browser_snapshot': case 'browser_screenshot': return { icon: MousePointerClick, text: tx('在浏览器里操作') }
    case 'request_handoff': return { icon: Hand, text: tx('请你接管浏览器') }
    case 'job_status': case 'job_stop': return { icon: Hourglass, text: tx('查看后台命令') }
    case 'recall': return { icon: History, text: tx('回顾之前的记录') }
    case 'remember': return { icon: Brain, text: tx('记下一条经验') }
    case 'search_memory': return { icon: Brain, text: tx('翻看记忆') }
    case 'subagent_start': return { icon: Users, text: tx('分出一个子任务：{0}', short(i.job, 60)) }
    case 'subagent_stop': return { icon: Users, text: tx('停下一个子任务') }
    case 'report': return { icon: NotebookPen, text: i.status === 'ready' ? tx('整理好结果') : i.status === 'waiting' ? tx('有问题要问你') : i.status === 'progress' ? tx('告一段落，等后续') : i.status === 'dropped' ? tx('判断不需要做') : tx('说明遇到的问题') }
    case 'handback': return { icon: CornerUpLeft, text: tx('把一条无关的消息转回去') }
    case 'github_follow': return { icon: Link2, text: tx('关注一个 GitHub 讨论') }
    default: return { icon: Dot, text: tool.replace(/^mcp_/, '').replace(/_/g, ' ') }
  }
}

export function TaskDrawer() {
  // Keeps the last task on screen while the drawer slides away.
  const { shown: id, leaving } = usePresence(useOpenTask())
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
  return <div className={cx('anim-fade fixed inset-0 z-40 flex justify-end bg-[var(--scrim)]', leaving && 'out-fade')} onMouseDown={e => { if (e.target === e.currentTarget) openTask(null) }}>
    <div role="dialog" aria-modal="true" aria-label={t?.title ?? tx('任务')} className={cx('anim-drawer-r flex h-full w-full max-w-xl flex-col bg-card shadow-2xl md:my-2 md:mr-2 md:h-[calc(100%-1rem)] md:rounded-[24px]', leaving && 'out-r')}>
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        {t && <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sunken"><StateIcon t={t} size={16} /></div>}
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[17px] font-semibold">{t?.title ?? '…'}</div>
          {t && <div className="mt-0.5 text-xs text-pretty text-muted tabular-nums">{t.stage === 'ended' ? endedText(t) : STATE_TEXT[t.stage]}{t.proactive ? tx(' · 我主动发现的') : ''} · {new Date(t.createdAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{d && d.usage.tokens > 0 ? ` · ${fmtTokens(d.usage.tokens)} tokens${d.usage.costUsd ? tx('（约 ${0}）', d.usage.costUsd.toFixed(2)) : ''}` : ''}</div>}
        </div>
        <IconButton label={tx('关闭')} onClick={() => openTask(null)}><X size={18} /></IconButton>
      </div>
      {t && <div className="flex flex-wrap gap-1.5 border-b border-line px-5 py-2.5 empty:hidden">
        {t.conversationId && <Button size="sm" variant="secondary" onClick={() => { go(`/c/${t.conversationId}`); openTask(null) }}>{tx('回到对话')}</Button>}
        {t.stage !== 'ended' && <Button size="sm" variant="ghost" onClick={() => { if (confirm(tx('停下「{0}」？', t.title))) stop.mutate() }}><Square size={12} />{tx('停下')}</Button>}
      </div>}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {t?.proactive && t.why && <div className="mb-4 flex gap-2 rounded-2xl bg-accent-soft px-3.5 py-3 text-sm text-pretty"><Sparkles size={15} className="mt-0.5 shrink-0 text-accent" />{tx('没人找我，是按你的主动策略做的：{0}', t.why)}</div>}
        {report && report.status !== 'progress' && report.summary && <section className="mb-5">
          <h3 className="eyebrow mb-2">{report.status === 'ready' ? tx('结果') : tx('最新情况')}</h3>
          <div className="prose-chat rounded-2xl bg-sunken px-4 py-3 text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report.summary}</ReactMarkdown></div>
        </section>}
        {d?.files && d.files.length > 0 && <section className="mb-5">
          <h3 className="eyebrow mb-2">{tx('文件')}</h3>
          <div className="flex flex-wrap items-start gap-2">{d.files.map(f => <FileChip key={f.id} {...f} />)}</div>
        </section>}
        <h3 className="eyebrow mb-2">{tx('我做了什么')}</h3>
        {!steps.length && <div className="text-sm text-faint">{working ? tx('刚开始…') : tx('还没有步骤')}</div>}
        <ol className="relative space-y-0.5 before:absolute before:top-3 before:bottom-3 before:left-[22px] before:w-px before:bg-line">{steps.map(s => <Step key={s.id} step={s} />)}</ol>
        {working && <div className="mt-2 flex items-center gap-1.5 text-xs text-faint"><Loader2 size={12} className="animate-spin" />{tx('进行中')}</div>}
        {d && d.jobs.length > 0 && <div className="mt-3 text-xs text-faint">{tx('后台还在运行 {0} 个命令', d.jobs.length)}</div>}
      </div>
    </div>
  </div>
}

type StepItem = { id: string; icon: LucideIcon; text: string; detail?: string; output?: string; pending?: boolean; kind: 'step' | 'note' | 'error' }

function toSteps(items: TranscriptItem[], dir: string): StepItem[] {
  // Paths read better relative to the working directory.
  const local = (v: unknown): any => (typeof v === 'string' ? v.split(`${dir}/`).join('').split(dir).join('.') : Array.isArray(v) ? v.map(local) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, local(x)])) : v)
  const out: StepItem[] = []
  items.forEach((item, i) => {
    if (item.kind === 'tool-call') {
      const result = items.slice(i + 1).find(r => r.kind === 'tool-result' && r.callId === item.callId) as Extract<TranscriptItem, { kind: 'tool-result' }> | undefined
      const { icon, text } = describeStep(item.tool, local(item.input))
      out.push({ id: item.id, icon, text, detail: JSON.stringify(item.input, null, 2), ...(result ? { output: result.output } : { pending: true }), kind: 'step' })
    } else if (item.kind === 'text' && item.text.trim()) out.push({ id: item.id, icon: MessageSquareText, text: item.text.trim().split('\n')[0]!.slice(0, 140), detail: item.text, kind: 'note' })
    else if (item.kind === 'marker' && item.type === 'error') out.push({ id: item.id, icon: AlertTriangle, text: tx('出错：{0}', item.message ?? ''), kind: 'error' })
  })
  return out
}

function Step({ step }: { step: StepItem }) {
  // 显示原始记录 (设置 → 数据和隐私): each call opens with its raw input and output.
  const [open, setOpen] = useState(() => getPrefs().showRaw && step.kind === 'step')
  return <li>
    <button onClick={() => setOpen(v => !v)} aria-expanded={open} className={cx('relative flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-sunken', step.kind === 'error' && 'text-danger', step.kind === 'note' && 'text-muted')}>
      <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-lg border border-line bg-panel', step.kind === 'error' ? 'text-danger' : 'text-muted')}><step.icon size={13} /></span>
      <span className="min-w-0 flex-1 py-0.5 break-words">{step.text}</span>
      {step.pending && <Loader2 size={12} className="mt-1 shrink-0 animate-spin text-faint" />}
    </button>
    {open && (step.detail || step.output) && <div className="anim-fade mb-2 space-y-1.5 pl-11">
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
