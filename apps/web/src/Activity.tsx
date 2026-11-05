/**
 * Activity: what the conversations do not show. In the order the prototype's panel asks its questions — what needs me,
 * what is going on, what comes next, what I noticed on my own, and where every event went.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, FolderOpen, Inbox, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { api, type ActivityEvent, type Artifact, type AttentionStats, type Routine, type Ticket } from './api'
import { openTask } from './live'
import { endedText, FileChip, fmtSize, NeedsYou, needsOwner, STATE_TEXT, StateIcon, useTickets } from './tasks'
import { SourceIcon, SOURCE_LABEL } from './icons'
import { Button, cx, Empty } from './ui'
import { go } from './route'

const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.round(s / 3600)} 小时前`
  return new Date(at).toLocaleDateString()
}

export function Activity() {
  const tickets = useTickets().data?.tickets ?? []
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') }).data?.routines ?? []
  const activity = useQuery({ queryKey: ['activity'], queryFn: () => api.get<{ proactive: string; stats: AttentionStats; events: ActivityEvent[] }>('/activity') }).data
  const person = tickets.filter(needsOwner)
  const going = tickets.filter(t => !needsOwner(t) && t.stage !== 'ended')
  const done = tickets.filter(t => t.stage === 'ended').slice(0, 12)
  const upcoming = routines.filter(r => r.enabled && r.next).sort((a, b) => a.next! - b.next!).slice(0, 6)
  const noticed = (activity?.events ?? []).filter(e => e.proactive?.act)
  const [log, setLog] = useState(false)

  return <Page title="活动" intro="对话里只放结果和需要你拿主意的事；这里是背后在发生的一切。">
    <Section title="需要你" tone="warn" count={person.length}>
      {person.length ? <div className="space-y-2">{person.map(t => <div key={t.id} className="space-y-1.5">
        <Row t={t} />
        <div className="pl-7"><NeedsYou t={t} onAnswer={() => t.conversationId && go(`/c/${t.conversationId}`)} /></div>
      </div>)}</div> : <p className="px-1 text-sm text-faint">没有需要你处理的事。</p>}
    </Section>
    {going.length > 0 && <Section title="正在做" count={going.length}>{going.map(t => <Row key={t.id} t={t} />)}</Section>}
    {upcoming.length > 0 && <Section title="接下来">
      {upcoming.map(r => <a key={r.id} href={r.conversationId ? `#/c/${r.conversationId}` : '#/settings/routines'} className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-sunken">
        <AlarmClock size={14} className="shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate">{r.name}</span>
        <span className="shrink-0 text-xs text-faint">{new Date(r.next!).toLocaleString()}</span>
      </a>)}
    </Section>}
    {(noticed.length > 0 || activity?.proactive !== 'off') && <Section title="我主动留意到的" intro={activity?.proactive === 'observe' ? '观察模式：只记下我本来会去做的事，你点「去做」我才动手。' : activity?.proactive === 'auto' ? '自动模式：值得做的我会先悄悄做，有结果再告诉你。' : undefined}>
      {noticed.length ? noticed.slice(0, 20).map(e => <Noticed key={e.id} e={e} />) : <p className="px-1 text-sm text-faint">还没有。</p>}
    </Section>}
    {activity?.stats && <Stats s={activity.stats} />}
    {done.length > 0 && <Section title="最近完成">{done.map(t => <Row key={t.id} t={t} />)}</Section>}
    <section>
      <button onClick={() => setLog(v => !v)} className="flex items-center gap-1 px-1 text-xs font-medium text-muted hover:text-fg">
        {log ? <ChevronDown size={13} /> : <ChevronRight size={13} />}外部事件记录（{activity?.events.length ?? 0}）
      </button>
      {log && <div className="mt-2 divide-y divide-line rounded-xl border border-line bg-panel">
        {(activity?.events ?? []).map(e => <EventRow key={e.id} e={e} />)}
        {!activity?.events.length && <p className="px-4 py-3 text-sm text-faint">没有外部事件。</p>}
      </div>}
    </section>
  </Page>
}

/** How much attention the agent took, and how its initiative went — the numbers the article's critics ask for. */
function Stats({ s }: { s: AttentionStats }) {
  const asked = s.approvals + s.questions
  if (!asked && !s.screened) return null
  return <p className="px-1 text-xs text-faint">
    最近 {s.days} 天：找你拿主意 {asked} 次（批准 {s.approvals}、提问 {s.questions}）
    {s.screened > 0 && <>；主动判断 {s.screened} 件，留意到 {s.picked} 件，悄悄做了 {s.silent} 件，告诉你 {s.told} 件{s.useful + s.useless > 0 ? `，你标记有用 ${s.useful}、没用 ${s.useless}` : ''}</>}。
  </p>
}

function Row({ t }: { t: Ticket }) {
  return <button onClick={() => openTask(t.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-sunken">
    <StateIcon t={t} />
    <span className="min-w-0 flex-1 truncate">{t.title}</span>
    {t.proactive && <Sparkles size={12} className="shrink-0 text-accent" aria-label="主动发现" />}
    {t.source !== 'webchat' && <SourceIcon source={t.source} size={12} className="shrink-0 text-faint" />}
    <span className="shrink-0 text-xs text-faint">{t.stage === 'ended' ? endedText(t) : STATE_TEXT[t.stage]} · {ago(t.updatedAt)}</span>
  </button>
}

function Noticed({ e }: { e: ActivityEvent }) {
  const qc = useQueryClient()
  const act = useMutation({ mutationFn: () => api.post(`/triggers/${e.id}/act`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['activity'] }); qc.invalidateQueries({ queryKey: ['tickets'] }) } })
  const feedback = useMutation({ mutationFn: (useful: boolean) => api.post(`/triggers/${e.id}/feedback`, { useful }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['activity'] }); qc.invalidateQueries({ queryKey: ['proactive'] }) } })
  return <div className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-sm">
    <SourceIcon source={e.source} size={14} className="mt-0.5 shrink-0 text-muted" />
    <div className="min-w-0 flex-1">
      <div className="truncate">{e.proactive?.title ?? e.text.slice(0, 60)}</div>
      <div className="text-xs text-muted">{e.proactive?.reason}</div>
      <div className="mt-0.5 truncate text-xs text-faint">{e.actor}：{e.text.slice(0, 120)}</div>
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

export function Library() {
  const items = useQuery({ queryKey: ['artifacts'], queryFn: () => api.get<{ artifacts: Artifact[] }>('/artifacts') }).data?.artifacts
  return <Page title="成果" intro="我交给你的文件都在这里，原件保存在各自的工作目录中。">
    {items && !items.length && <Empty icon={<FolderOpen size={28} />} title="还没有文件">我做完的事如果有文件（报告、脚本、图片……），会跟着回复一起发给你，也会出现在这里。</Empty>}
    <div className="divide-y divide-line rounded-xl border border-line bg-panel empty:hidden">
      {items?.map(a => <div key={a.id} className="flex items-center gap-3 px-4 py-2.5">
        <div className="min-w-0 flex-1"><FileChip id={a.id} name={a.name} size={a.size} /></div>
        <div className="hidden min-w-0 shrink text-right text-xs text-faint sm:block">
          <button onClick={() => openTask(a.ticketId)} className="block max-w-56 truncate hover:text-muted">{a.title}</button>
          <span>{ago(a.createdAt)} · {fmtSize(a.size)}</span>
        </div>
        <a href={`/api/artifacts/${a.id}?download=1`} className="shrink-0 text-xs text-accent">下载</a>
      </div>)}
    </div>
  </Page>
}

function Page({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
      <header><h1 className="text-lg font-semibold">{title}</h1><p className="mt-1 text-sm text-muted">{intro}</p></header>
      {children}
    </div>
  </div>
}

function Section({ title, intro, count, tone, children }: { title: string; intro?: string; count?: number; tone?: 'warn'; children: React.ReactNode }) {
  return <section>
    <h2 className={cx('mb-1 flex items-center gap-1.5 px-1 text-xs font-medium', tone === 'warn' && count ? 'text-warn' : 'text-muted')}>
      {tone === 'warn' ? (count ? <Inbox size={13} /> : <CheckCircle2 size={13} className="text-ok" />) : null}{title}{count ? ` · ${count}` : ''}
    </h2>
    {intro && <p className="mb-1 px-1 text-xs text-faint">{intro}</p>}
    {children}
  </section>
}
