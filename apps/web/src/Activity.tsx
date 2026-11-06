/**
 * Activity: what the conversations do not show. In the order the prototype's panel asks its questions — what needs me,
 * what is going on, what comes next, what I noticed on my own, and where every event went.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Inbox, KeyRound, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { api, type ActivityEvent, type Routine, type Ticket } from './api'
import { openTask } from './live'
import { endedText, NeedsYou, needsOwner, STATE_TEXT, StateIcon, useTickets } from './tasks'
import { SourceIcon, SOURCE_LABEL } from './icons'
import { Button, cx } from './ui'
import { go } from './route'

const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.round(s / 3600)} 小时前`
  return new Date(at).toLocaleDateString()
}

export function Activity() {
  return <Page title="动态"><ActivityBody /></Page>
}

function ActivityBody({ compact }: { compact?: boolean }) {
  const tickets = useTickets().data?.tickets ?? []
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') }).data?.routines ?? []
  const activity = useQuery({ queryKey: ['activity'], queryFn: () => api.get<{ proactive: string; events: ActivityEvent[] }>('/activity') }).data
  const person = tickets.filter(needsOwner)
  const going = tickets.filter(t => !needsOwner(t) && t.stage !== 'ended')
  const done = tickets.filter(t => t.stage === 'ended').slice(0, 12)
  const upcoming = routines.filter(r => r.enabled && r.next).sort((a, b) => a.next! - b.next!).slice(0, 6)
  const noticed = (activity?.events ?? []).filter(e => e.proactive?.act)
  const [log, setLog] = useState(false)

  return <div className="space-y-6">
    <Section title="需要你" tone="warn" count={person.length}>
      {person.length ? <div className="space-y-3">{person.map(t => <div key={t.id} className="space-y-1.5">
        <Row t={t} />
        <div className="pl-2"><NeedsYou t={t} onAnswer={() => t.conversationId && go(`/c/${t.conversationId}`)} /></div>
      </div>)}</div> : <p className="flex items-center gap-2 rounded-2xl bg-sunken px-3 py-2.5 text-sm text-muted"><CheckCircle2 size={15} className="text-ok" />没有</p>}
    </Section>
    {going.length > 0 && <Section title="正在做" count={going.length}>{going.map(t => <Row key={t.id} t={t} />)}</Section>}
    <Grants />
    {upcoming.length > 0 && <Section title="接下来">
      {upcoming.map(r => <a key={r.id} href={r.conversationId ? `#/c/${r.conversationId}` : '#/settings/routines'} className="press flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm hover:bg-sunken">
        <AlarmClock size={14} className="shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate">{r.name}</span>
        <span className="shrink-0 text-xs text-faint tabular-nums">{new Date(r.next!).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      </a>)}
    </Section>}
    {(noticed.length > 0 || activity?.proactive !== 'off') && <Section title="我主动留意到的">
      {noticed.length ? noticed.slice(0, 20).map(e => <Noticed key={e.id} e={e} />) : <p className="px-1 text-sm text-faint">还没有。</p>}
    </Section>}
    {done.length > 0 && <Section title="最近完成">{done.map(t => <Row key={t.id} t={t} />)}</Section>}
    <section>
      <button onClick={() => setLog(v => !v)} aria-expanded={log} className="eyebrow flex items-center gap-1 px-1 hover:text-fg">
        {log ? <ChevronDown size={13} /> : <ChevronRight size={13} />}外部事件记录（{activity?.events.length ?? 0}）
      </button>
      {log && <div className="anim-fade mt-2 divide-y divide-line rounded-2xl border border-line bg-panel">
        {(activity?.events ?? []).map(e => <EventRow key={e.id} e={e} />)}
        {!activity?.events.length && <p className="px-4 py-3 text-sm text-faint">没有外部事件。</p>}
      </div>}
    </section>
  </div>
}

/** What the owner allowed for the rest of a task ("这件事里都允许"); revocable. Healthy state takes no space. */
function Grants() {
  const qc = useQueryClient()
  const grants = useQuery({ queryKey: ['grants'], queryFn: () => api.get<{ grants: { id: string; ticketId: string; label: string; title: string; createdAt: number }[] }>('/grants') }).data?.grants ?? []
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/grants/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['grants'] }) })
  if (!grants.length) return null
  return <Section title="你允许过的" count={grants.length}>
    {grants.map(g => <div key={g.id} className="flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm">
      <KeyRound size={14} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate">{g.label}<span className="text-faint"> · {g.title}</span></span>
      <Button size="sm" variant="ghost" onClick={() => revoke.mutate(g.id)} disabled={revoke.isPending}>撤回</Button>
    </div>)}
  </Section>
}

function Row({ t }: { t: Ticket }) {
  return <button onClick={() => openTask(t.id)} className="press flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm hover:bg-sunken">
    <StateIcon t={t} />
    <span className="min-w-0 flex-1 truncate">{t.title}</span>
    {t.proactive && <Sparkles size={12} className="shrink-0 text-accent" aria-label="主动发现" />}
    {t.source !== 'webchat' && <SourceIcon source={t.source} size={12} className="shrink-0 text-faint" />}
    <span className="shrink-0 text-xs text-faint tabular-nums">{t.stage === 'ended' ? endedText(t) : STATE_TEXT[t.stage]} · {ago(t.updatedAt)}</span>
  </button>
}

function Noticed({ e }: { e: ActivityEvent }) {
  const qc = useQueryClient()
  const act = useMutation({ mutationFn: () => api.post(`/triggers/${e.id}/act`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['activity'] }); qc.invalidateQueries({ queryKey: ['tickets'] }) } })
  const feedback = useMutation({ mutationFn: (useful: boolean) => api.post(`/triggers/${e.id}/feedback`, { useful }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['activity'] }); qc.invalidateQueries({ queryKey: ['proactive'] }) } })
  return <div className="flex items-start gap-2.5 rounded-xl px-2 py-2 text-sm max-sm:flex-wrap">
    <SourceIcon source={e.source} size={14} className="mt-0.5 shrink-0 text-muted" />
    <div className="min-w-0 flex-1">
      <div className="truncate">{e.proactive?.title ?? e.text.slice(0, 60)}</div>
      <div className="text-xs text-muted">{e.proactive?.reason}</div>
    </div>
    <div className="flex shrink-0 items-center gap-1">
      {e.ticketId ? <Button size="sm" variant="ghost" onClick={() => openTask(e.ticketId)}>看看</Button>
        : <Button size="sm" onClick={() => act.mutate()} disabled={act.isPending}>去做</Button>}
      {e.feedback ? <span className="px-1 text-xs text-faint">{e.feedback.useful ? '你觉得有用' : '以后不管这类'}</span> : <>
        <Button size="sm" variant="ghost" title="这次留意得好" onClick={() => feedback.mutate(true)} disabled={feedback.isPending}>有用</Button>
        <Button size="sm" variant="ghost" title="写进主动策略：以后不管这类事" onClick={() => feedback.mutate(false)} disabled={feedback.isPending}>别管这类</Button>
      </>}
    </div>
  </div>
}

function EventRow({ e }: { e: ActivityEvent }) {
  const tone = { ok: 'text-ok', muted: 'text-faint', warn: 'text-warn', accent: 'text-accent' }[e.outcome.tone]
  return <div className="flex items-start gap-2.5 px-4 py-2.5 text-sm">
    <SourceIcon source={e.source} size={14} className="mt-0.5 shrink-0 text-muted" />
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <span className="font-medium text-fg">{e.source === 'cron' ? '定时任务' : e.actor}</span>{!e.human && <span className="rounded bg-sunken px-1 text-[10px]">bot</span>}
        <span className="text-faint">{SOURCE_LABEL[e.source] ?? e.source} · {ago(e.at)}</span>
        {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="text-accent"><ExternalLink size={11} /></a>}
      </div>
      <div className="mt-0.5 line-clamp-2 text-sm">{e.text}</div>
      <div className={cx('mt-0.5 text-xs', tone)}>{e.outcome.text}</div>
    </div>
    {e.ticketId && <button onClick={() => openTask(e.ticketId)} className="shrink-0 text-xs text-accent">详情</button>}
  </div>
}

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-3xl space-y-7 px-4 py-8 md:px-6">
      <header className="anim-rise">
        <h1 className="font-display text-3xl font-semibold text-balance">{title}</h1>
      </header>
      {children}
    </div>
  </div>
}

function Section({ title, count, tone, children }: { title: string; count?: number; tone?: 'warn'; children: React.ReactNode }) {
  return <section>
    <h2 className={cx('mb-2 flex items-center gap-1.5 px-1 text-[13px] font-semibold', tone === 'warn' && count ? 'text-warn' : 'text-fg')}>
      {tone === 'warn' && count ? <Inbox size={14} /> : null}{title}
      {count ? <span className={cx('rounded-full px-1.5 text-[11px] leading-[18px] tabular-nums', tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-sunken text-muted')}>{count}</span> : null}
      <span className="ml-2 h-px flex-1 bg-line" />
    </h2>
    {children}
  </section>
}
