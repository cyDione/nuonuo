/**
 * "今天": the assistant's desk, beside the conversation. Who it is and how it is doing, what waits for you (answerable
 * right here), what it is working on, what comes next and what it just finished. On narrower screens the same panel
 * opens as a drawer, and on phones as a sheet from the bottom.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, AlertTriangle, CheckCircle2, ChevronRight, Globe, Hand, MessageCircleQuestion, PanelRightClose, PanelRightOpen, ShieldAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type Routine, type Ticket } from './api'
import { HandoffModal } from './handoff'
import { openActivity, openTask, useActivityOpen, useLive } from './live'
import { Avatar, statusLine, usePersona } from './persona'
import { go } from './route'
import { StateIcon, needsOwner, useTickets } from './tasks'
import { cx, IconButton } from './ui'
import { togglePane, usePanes, usePresence, useTilt } from './shell'

const time = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function when(at: number) {
  const d = new Date(at), now = new Date()
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000)
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return days === 0 ? `今天 ${hm}` : days === 1 ? `明天 ${hm}` : days < 7 ? `${WEEK[d.getDay()]} ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
const since = (at: number) => { const m = Math.max(1, Math.round((Date.now() - at) / 60_000)); return m < 60 ? `${m} 分钟` : `${Math.round(m / 60)} 小时` }

export function TodayPanel({ onClose, variant = 'side' }: { onClose?(): void; variant?: 'side' | 'drawer' | 'sheet' }) {
  const persona = usePersona()
  const connected = useLive(s => s.connected)
  const tickets = useTickets().data?.tickets ?? []
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') }).data?.routines ?? []
  const live = tickets.filter(t => t.stage !== 'ended')
  const person = live.filter(needsOwner)
  const going = live.filter(t => !needsOwner(t))
  const done = tickets.filter(t => t.stage === 'ended' && t.ended?.outcome === 'completed').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)
  const upcoming = routines.filter(r => r.enabled && r.next).sort((a, b) => a.next! - b.next!).slice(0, 4)
  const status = statusLine(live)
  const now = new Date()
  const hero = useTilt<HTMLDivElement>(2)

  return <div className="flex h-full flex-col">
    <div ref={hero} data-tone="sky" className={cx('flow tilt px-4 pt-3.5 pb-5', variant === 'sheet' ? 'mx-2.5 rounded-[22px]' : 'm-2.5 rounded-[18px]')}>
      <div className="relative flex items-center">
        <span className="flex-1 text-xs font-medium tabular-nums opacity-65">{now.getMonth() + 1}月{now.getDate()}日 · {WEEK[now.getDay()]}</span>
        {onClose && <IconButton label={variant === 'side' ? '收起' : '关闭'} onClick={onClose} className="-mr-1.5 text-white/75 hover:bg-white/15 hover:text-white">{variant === 'side' ? <PanelRightClose size={17} /> : <X size={18} />}</IconButton>}
      </div>
      <div className="relative mt-3 flex items-center gap-3.5">
        <Avatar persona={persona} size={76} mood={connected ? status.tone : 'sleepy'} track />
        <div className="min-w-0">
          <div className="truncate font-display text-[22px] leading-tight font-semibold text-white">{persona.name}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {!connected ? <Chip dot="bg-faint">重连中</Chip> : <>
              {going.length > 0 && <Chip dot="bg-accent" key={`g${going.length}`}>正在做 {going.length}</Chip>}
              {person.length > 0 && <Chip dot="bg-sun" key={`p${person.length}`}>等你 {person.length}</Chip>}
              {!going.length && !person.length && <Chip dot="bg-ok">空闲</Chip>}
            </>}
          </div>
        </div>
      </div>
    </div>

    <div className="stagger min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pt-2 pb-4">
      {person.length > 0 && <Section title="需要你" count={person.length}>
        <div className="space-y-2">{person.map(t => <NeedCard key={t.id} t={t} />)}</div>
      </Section>}
      {going.length > 0 && <Section title="正在做">
        <div className="space-y-1.5">{going.map(t => <GoingCard key={t.id} t={t} />)}</div>
      </Section>}
      {upcoming.length > 0 && <Section title="接下来">
        {upcoming.map(r => <a key={r.id} href={r.conversationId ? `#/c/${r.conversationId}` : '#/settings/routines'} className="press flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-sm hover:bg-sunken">
          <AlarmClock size={15} className="shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          <span className="shrink-0 rounded-lg bg-sunken px-2 py-0.5 text-xs font-medium text-muted tabular-nums">{when(r.next!)}</span>
        </a>)}
      </Section>}
      {done.length > 0 && <Section title="刚完成">
        {done.map(t => <button key={t.id} onClick={() => openTask(t.id)} className="press flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left text-sm text-muted hover:bg-sunken hover:text-fg">
          <CheckCircle2 size={15} className="shrink-0 text-ok" />
          <span className="min-w-0 flex-1 truncate">{t.title}</span>
          <span className="shrink-0 text-xs text-faint tabular-nums">{time(t.ended?.at ?? t.updatedAt)}</span>
        </button>)}
      </Section>}
      {!person.length && !going.length && !upcoming.length && !done.length && <div className="flex flex-col items-center gap-1 py-10 text-sm text-faint">
        <CheckCircle2 size={22} className="text-ok" />没有要你处理的事
      </div>}
    </div>

    <a href="#/activity" onClick={() => onClose && variant !== 'side' && onClose()} className="press group mx-4 mb-3 flex items-center gap-1 self-start rounded-full px-2 py-1.5 text-[13px] font-medium text-muted hover:text-fg">
      全部动态<ChevronRight size={14} className="transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
    </a>
  </div>
}

function GoingCard({ t }: { t: Ticket }) {
  const tilt = useTilt<HTMLButtonElement>(2)
  return <button ref={tilt} onClick={() => openTask(t.id)} className="tilt anim-drop press block w-full rounded-2xl bg-accent-soft/50 px-3.5 py-3 text-left hover:bg-accent-soft">
    <span className="flex items-center gap-2.5 text-sm">
      <StateIcon t={t} size={15} />
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      <span className="shrink-0 text-xs text-faint tabular-nums">{since(t.createdAt)}</span>
    </span>
    {t.stage === 'working' && <span className="progress mt-2.5 block h-1" />}
  </button>
}

function Chip({ dot, children }: { dot: string; children: React.ReactNode }) {
  return <span className="bump inline-flex items-center gap-1.5 rounded-full bg-card/90 px-2.5 py-1 text-xs font-medium text-fg tabular-nums">
    <span className={cx('size-1.5 rounded-full', dot)} />{children}
  </span>
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return <section>
    <h2 className="mb-2 flex items-center gap-1.5 px-1 text-[13px] font-semibold">{title}
      {count ? <span key={count} className="bump rounded-full bg-warn-soft px-1.5 text-[11px] leading-[18px] font-semibold text-warn tabular-nums">{count}</span> : null}
    </h2>
    {children}
  </section>
}

/** One thing waiting for the owner, answerable without leaving the panel. */
export function NeedCard({ t }: { t: Ticket }) {
  const qc = useQueryClient()
  const [leaving, setLeaving] = useState(false)
  const [handoff, setHandoff] = useState(false)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['tickets'] }); qc.invalidateQueries({ queryKey: ['grants'] }) }
  const after = { onMutate: () => setLeaving(true), onSuccess: refresh, onError: () => setLeaving(false) }
  const decide = useMutation({ mutationFn: (v: { id: string; approve: boolean; scope?: 'task' }) => api.post(`/approvals/${v.id}`, { approve: v.approve, ...(v.scope ? { scope: v.scope } : {}) }), ...after })
  const answer = useMutation({ mutationFn: (text: string) => api.post(`/conversations/${t.conversationId}/messages`, { content: text, replyTo: t.id }),
    ...after, onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['messages', t.conversationId] }) } })
  const retry = useMutation({ mutationFn: () => api.post(`/tickets/${t.id}/retry`), ...after })
  const stop = useMutation({ mutationFn: () => api.post(`/tickets/${t.id}/stop`), ...after })
  const busy = decide.isPending || answer.isPending || retry.isPending || stop.isPending

  const a = t.approvals[0]
  const kind = a ? 'approve' : t.attention?.kind === 'handoff' ? 'handoff' : t.stage === 'person/failed' ? 'failed' : t.stage === 'person/blocked' ? 'blocked' : 'answer'
  const Icon = { approve: ShieldAlert, handoff: Globe, failed: AlertTriangle, blocked: Hand, answer: MessageCircleQuestion }[kind]
  const tone = kind === 'answer' ? 'bg-accent-soft text-accent' : kind === 'failed' ? 'bg-danger/10 text-danger' : 'bg-warn-soft text-warn'
  const detail = a ? a.reason : t.attention?.question
  const tilt = useTilt<HTMLDivElement>()

  return <div ref={tilt} className={cx('tilt anim-drop rounded-2xl border border-line bg-card p-3.5', leaving && 'leaving')}>
    <button onClick={() => openTask(t.id)} className="flex w-full items-start gap-2.5 text-left">
      <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-[10px]', tone)}><Icon size={15} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{t.title}</span>
        {detail && <span className="mt-0.5 line-clamp-2 text-xs text-pretty text-muted">{detail}</span>}
      </span>
    </button>
    <div className="mt-3 flex flex-wrap gap-1.5">
      {kind === 'approve' && <>
        <Act primary disabled={busy} onClick={() => decide.mutate({ id: a!.id, approve: true })}>同意</Act>
        {a!.risk !== 'destructive' && <Act disabled={busy} onClick={() => decide.mutate({ id: a!.id, approve: true, scope: 'task' })}>都同意</Act>}
        <Act ghost disabled={busy} onClick={() => decide.mutate({ id: a!.id, approve: false })}>不要</Act>
      </>}
      {kind === 'answer' && (t.attention?.options?.length
        ? t.attention.options.map(o => <Act key={o} disabled={busy || !t.conversationId} onClick={() => answer.mutate(o)}>{o}</Act>)
        : <Act primary onClick={() => { if (t.conversationId) go(`/c/${t.conversationId}`); openActivity(false) }}>去回复</Act>)}
      {kind === 'handoff' && <Act primary onClick={() => setHandoff(true)}>打开浏览器</Act>}
      {(kind === 'failed' || kind === 'blocked') && <>
        <Act primary disabled={busy} onClick={() => retry.mutate()}>再试一次</Act>
        <Act ghost disabled={busy} onClick={() => stop.mutate()}>算了</Act>
      </>}
    </div>
    {handoff && <HandoffModal ticketId={t.id} reason={t.attention?.question ?? ''} onClose={() => setHandoff(false)} />}
  </div>
}

function Act({ primary, ghost, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; ghost?: boolean }) {
  return <button {...props} className={cx('press h-8 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap disabled:opacity-50',
    primary ? 'bg-accent text-accent-fg hover:opacity-90' : ghost ? 'text-muted hover:bg-sunken hover:text-fg' : 'border border-line hover:border-faint')}>{children}</button>
}

/** The button that brings the panel back: in the chat's corner when it is folded away or the screen is too narrow for it. */
export function TodayToggle({ className }: { className?: string }) {
  const isCollapsed = !usePanes().rightOpen
  const waiting = (useTickets().data?.tickets ?? []).filter(needsOwner).length
  const open = () => { if (matchMedia('(min-width: 1280px)').matches) togglePane('right', true); else openActivity(true) }
  return <button onClick={open} aria-label="今天" title="今天 (⌘.)" className={cx('press no-drag flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-muted hover:bg-sunken hover:text-fg',
    isCollapsed ? '' : 'xl:hidden', className)}>
    <PanelRightOpen size={16} />
    {waiting > 0 && <span key={waiting} className="bump rounded-full bg-sun px-1.5 text-[11px] leading-[18px] font-semibold text-[#121212] tabular-nums">{waiting}</span>}
  </button>
}

/** Narrow screens: the panel as a drawer (tablets) or a bottom sheet (phones). */
export function TodayDrawer() {
  const open = useActivityOpen()
  const [phone, setPhone] = useState(() => matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const mq = matchMedia('(max-width: 767px)')
    const on = () => setPhone(mq.matches)
    mq.addEventListener('change', on)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') openActivity(false) }
    addEventListener('keydown', onKey)
    return () => { mq.removeEventListener('change', on); removeEventListener('keydown', onKey) }
  }, [])
  const { shown, leaving } = usePresence(open)
  if (!shown) return null
  const close = () => openActivity(false)
  return <div className={cx('anim-fade fixed inset-0 z-30 flex bg-[var(--scrim)]', phone ? 'items-end' : 'justify-end', leaving && 'out-fade pointer-events-none')} onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div role="dialog" aria-modal="true" aria-label="今天" className={phone
      ? cx('anim-sheet flex h-[86dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-card pt-2 pb-[env(safe-area-inset-bottom)] shadow-2xl', leaving && 'out-sheet')
      : cx('anim-drawer-r my-2 mr-2 flex h-[calc(100%-1rem)] w-[360px] flex-col overflow-hidden rounded-[24px] bg-card shadow-2xl', leaving && 'out-r')}>
      {phone && <span className="mx-auto mb-2 h-1.5 w-10 shrink-0 rounded-full bg-line" aria-hidden />}
      <TodayPanel onClose={close} variant={phone ? 'sheet' : 'drawer'} />
    </div>
  </div>
}
