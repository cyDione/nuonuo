/** Task cards in the timeline, the task drawer with the worker's transcript, and the panel of what waits for the owner. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Brain, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Clock, FolderOpen, Hand, Loader2, MessageCircleQuestion, OctagonX, RotateCcw, Square, Terminal, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Stage, type Ticket, type TicketDetail, type TranscriptItem } from './api'
import { openTask, useLive, useOpenTask } from './live'
import { go } from './route'
import { Button, cx } from './ui'

export const useTickets = () => useQuery({ queryKey: ['tickets'], queryFn: () => api.get<{ tickets: Ticket[] }>('/tickets') })

const STAGE_TONE: Record<Stage, string> = {
  'person/answer': 'text-warn', 'person/blocked': 'text-warn', 'person/failed': 'text-danger',
  queued: 'text-muted', working: 'text-accent', idle: 'text-muted', ended: 'text-faint',
}

export function StageIcon({ t, size = 14 }: { t: Ticket; size?: number }) {
  const cls = cx('shrink-0', STAGE_TONE[t.stage])
  if (t.stage === 'working') return <Loader2 size={size} className={cx(cls, 'animate-spin')} />
  if (t.stage === 'person/answer') return <MessageCircleQuestion size={size} className={cls} />
  if (t.stage === 'person/blocked') return <Hand size={size} className={cls} />
  if (t.stage === 'person/failed') return <AlertTriangle size={size} className={cls} />
  if (t.stage === 'queued') return <Clock size={size} className={cls} />
  if (t.stage === 'ended') return t.ended?.outcome === 'completed' ? <CheckCircle2 size={size} className="shrink-0 text-ok" /> : <OctagonX size={size} className={cls} />
  return <CircleDot size={size} className={cls} />
}

const endedLabel = (t: Ticket) => (t.ended?.outcome === 'completed' ? '已完成' : t.ended?.outcome === 'dropped' ? '无需处理' : '已停止')

export function TaskCard({ ticketId, onAnswer }: { ticketId: string; onAnswer(text: string, ticketId: string): void }) {
  const qc = useQueryClient()
  const tickets = useTickets()
  const t = tickets.data?.tickets.find(x => x.id === ticketId)
  const live = useLive(s => s.workerText[ticketId] ?? '')
  const [expanded, setExpanded] = useState(false)
  const stop = useMutation({ mutationFn: () => api.post(`/tickets/${ticketId}/stop`), onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }) })
  const retry = useMutation({ mutationFn: () => api.post(`/tickets/${ticketId}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }) })
  if (!t) return null
  const report = t.latestReport
  const showReport = report && report.status !== 'progress' && report.summary
  const liveLine = t.stage === 'working' ? live.trim().split('\n').filter(Boolean).at(-1) : undefined
  return <div className="rounded-xl border border-line bg-panel">
    <div className="flex items-center gap-2 px-4 py-3">
      <StageIcon t={t} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
      <span className={cx('text-xs', STAGE_TONE[t.stage])}>{t.stage === 'ended' ? endedLabel(t) : t.stageLabel}</span>
    </div>
    {liveLine && <div className="truncate border-t border-line px-4 py-2 font-mono text-xs text-faint">{liveLine}</div>}
    {t.attention && <div className="border-t border-line px-4 py-3">
      <div className="text-sm">{t.attention.question}</div>
      {t.attention.options?.length ? <div className="mt-2 flex flex-wrap gap-1.5">
        {t.attention.options.map(o => <Button key={o} size="sm" onClick={() => onAnswer(o, t.id)}>{o}</Button>)}
      </div> : null}
      <div className="mt-1.5 text-xs text-faint">直接在下方输入框回复即可，消息会交给这个任务。</div>
    </div>}
    {showReport && !t.attention && <div className="border-t border-line px-4 py-3">
      <div className={cx('prose-chat text-sm', !expanded && 'line-clamp-4')}><ReactMarkdown remarkPlugins={[remarkGfm]}>{report.summary}</ReactMarkdown></div>
      {report.summary.length > 200 && <button onClick={() => setExpanded(v => !v)} className="mt-1 text-xs text-accent">{expanded ? '收起' : '展开全部'}</button>}
    </div>}
    <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 py-1.5">
      <Button size="sm" variant="ghost" onClick={() => openTask(t.id)}><Terminal size={13} />查看过程</Button>
      {(t.stage === 'person/blocked' || t.stage === 'person/failed') && <Button size="sm" variant="ghost" onClick={() => retry.mutate()} disabled={retry.isPending}><RotateCcw size={13} />重试</Button>}
      {t.stage !== 'ended' && <Button size="sm" variant="ghost" onClick={() => { if (confirm(`停止任务「${t.title}」？`)) stop.mutate() }} disabled={stop.isPending}><Square size={12} />停止</Button>}
      <span className="ml-auto flex min-w-0 items-center gap-1 truncate pr-2 font-mono text-[11px] text-faint" title={t.directory}><FolderOpen size={12} className="shrink-0" />{t.directory.split('/').slice(-2).join('/')}</span>
    </div>
  </div>
}

export function TaskDrawer() {
  const id = useOpenTask()
  const detail = useQuery({ queryKey: ['ticket', id], enabled: Boolean(id), queryFn: () => api.get<TicketDetail>(`/tickets/${id}`) })
  const live = useLive(s => (id ? s.workerText[id] ?? '' : ''))
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => { if (stick.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [detail.data?.transcript.length, live])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') openTask(null) }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  if (!id) return null
  const d = detail.data
  return <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l border-line bg-panel shadow-2xl">
    <div className="flex items-center gap-2 border-b border-line px-5 py-3">
      {d && <StageIcon t={d.ticket} />}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{d?.ticket.title ?? '…'}</div>
        {d && <div className="truncate font-mono text-[11px] text-faint">{d.ticket.id} · {d.ticket.directory}</div>}
      </div>
      {d?.ticket.conversationId && <Button size="sm" variant="ghost" onClick={() => { go(`/c/${d.ticket.conversationId}`); openTask(null) }}>回到对话</Button>}
      <button onClick={() => openTask(null)} className="text-faint hover:text-fg" aria-label="关闭"><X size={18} /></button>
    </div>
    {d && d.jobs.length > 0 && <div className="border-b border-line bg-sunken px-5 py-2 text-xs text-muted">
      后台运行中：{d.jobs.map(j => <code key={j.jobId} className="mr-2 font-mono">{j.command.slice(0, 60)}</code>)}
    </div>}
    <div ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
      {d?.transcript.map((item, i) => <TranscriptRow key={item.id} item={item} result={item.kind === 'tool-call' ? d.transcript.slice(i + 1).find(r => r.kind === 'tool-result' && r.callId === item.callId) as any : undefined} />)}
      {live && <div className="prose-chat whitespace-pre-wrap text-sm text-muted">{live}<span className="caret" /></div>}
      {d && !d.transcript.length && <div className="text-sm text-faint">还没有开始…</div>}
    </div>
  </div>
}

function TranscriptRow({ item, result }: { item: TranscriptItem; result?: Extract<TranscriptItem, { kind: 'tool-result' }> }) {
  const [open, setOpen] = useState(false)
  switch (item.kind) {
    case 'input': return <div className="rounded-lg bg-sunken px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted">{item.text}</div>
    case 'reasoning': return <details className="text-xs text-faint"><summary className="flex cursor-pointer items-center gap-1"><Brain size={12} />思考</summary>
      <div className="mt-1 whitespace-pre-wrap">{item.text}</div></details>
    case 'text': return <div className="prose-chat text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown></div>
    case 'tool-call': {
      const summary = toolSummary(item.tool, item.input)
      return <div className="rounded-lg border border-line">
        <button onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="font-medium text-accent">{item.tool}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-muted">{summary}</span>
          {!result && <Loader2 size={12} className="animate-spin text-faint" />}
        </button>
        {open && <div className="space-y-2 border-t border-line px-3 py-2">
          <pre className="overflow-x-auto font-mono text-[11px] whitespace-pre-wrap text-muted">{JSON.stringify(item.input, null, 2)}</pre>
          {result && <pre className="max-h-80 overflow-auto rounded bg-sunken p-2 font-mono text-[11px] whitespace-pre-wrap">{result.output}</pre>}
        </div>}
      </div>
    }
    case 'tool-result': return null
    case 'marker': return <div className={cx('text-xs', item.type === 'error' ? 'text-danger' : 'text-faint')}>— {item.type === 'error' ? `出错：${item.message}` : item.type === 'step-limit' ? '达到单轮步数上限' : item.type} —</div>
    case 'compaction': return <details className="text-xs text-faint"><summary className="cursor-pointer">— 上下文已压缩 —</summary><div className="mt-1 whitespace-pre-wrap">{item.summary}</div></details>
  }
}

function toolSummary(tool: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  if (tool === 'shell') return input.command
  if (tool === 'report') return `${input.status}: ${String(input.summary ?? '').slice(0, 80)}`
  return input.path ?? input.url ?? input.ref ?? input.job_id ?? JSON.stringify(input).slice(0, 100)
}

/** Right-hand panel: tasks that wait for the owner first, then running ones. Hidden when there is nothing. */
export function TasksPanel({ currentConversation }: { currentConversation?: string }) {
  const tickets = useTickets()
  const list = tickets.data?.tickets ?? []
  const person = list.filter(t => t.stage.startsWith('person/'))
  const active = list.filter(t => t.stage === 'working' || t.stage === 'queued' || t.stage === 'idle')
  const recent = list.filter(t => t.stage === 'ended').slice(0, 5)
  if (!person.length && !active.length && !recent.length) return null
  const Row = ({ t }: { t: Ticket }) => <button onClick={() => openTask(t.id)}
    className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-sunken', t.conversationId === currentConversation && 'bg-sunken/60')}>
    <StageIcon t={t} size={13} /><span className="min-w-0 flex-1 truncate">{t.title}</span>
    <span className="shrink-0 text-[11px] text-faint">{t.stage === 'ended' ? endedLabel(t) : t.stageLabel}</span>
  </button>
  return <aside className="w-72 shrink-0 space-y-4 overflow-y-auto border-l border-line bg-panel p-3 max-xl:hidden">
    {person.length > 0 && <section>
      <h3 className="px-2.5 pb-1 text-xs font-medium text-warn">待你处理 · {person.length}</h3>
      {person.map(t => <Row key={t.id} t={t} />)}
    </section>}
    {active.length > 0 && <section>
      <h3 className="px-2.5 pb-1 text-xs font-medium text-muted">进行中 · {active.length}</h3>
      {active.map(t => <Row key={t.id} t={t} />)}
    </section>}
    {recent.length > 0 && <section>
      <h3 className="px-2.5 pb-1 text-xs font-medium text-faint">最近结束</h3>
      {recent.map(t => <Row key={t.id} t={t} />)}
    </section>}
  </aside>
}
