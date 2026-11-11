/**
 * 原始记录 (Figma v7, one history line): every event that came in from outside, and every review decision, unfiltered. For
 * when you want to check; the right pane's 活动 and 权限 tell the same story in plain words.
 */
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { api, type ActivityEvent, type AuditEntry } from '../api'
import { SourceIcon, SOURCE_LABEL } from '../icons'
import { openTask } from '../live'
import { cx } from '../ui'
import { Block, Btn, Row, Section } from './kit'
import { locale, tx } from '../i18n'

const DECISION: Record<string, { label: string; cls: string }> = { allow: { label: tx('放行'), cls: 'text-ok' }, block: { label: tx('拦截'), cls: 'text-danger' }, escalate: { label: tx('问你'), cls: 'text-warn' } }
const ACTOR: Record<string, string> = { reviewer: tx('审核模型'), rule: tx('规则'), owner: tx('你'), system: tx('系统') }
const stamp = (at: number) => new Date(at).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function RawRecords() {
  const [open, setOpen] = useState<'events' | 'audit' | null>(null)
  const events = useQuery({ queryKey: ['activity'], queryFn: () => api.get<{ events: ActivityEvent[] }>('/activity') }).data?.events ?? []
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ entries: AuditEntry[] }>('/audit'), enabled: open === 'audit' }).data?.entries ?? []
  const toggle = (k: 'events' | 'audit') => setOpen(o => (o === k ? null : k))
  return <Section title={tx('原始记录')} foot={tx('只给想核对的时候看；平时右侧栏的「活动」和「权限」会用大白话告诉你。')}>
    <Row label={tx('外面进来的事件')} sub={tx('来源推来的每一条，包括它没理会的 · {0} 条', events.length)}><Btn onClick={() => toggle('events')}>{open === 'events' ? tx('收起') : tx('查看')}</Btn></Row>
    {open === 'events' && <Block className="max-h-[420px] overflow-y-auto">
      {!events.length ? <p className="py-4 text-center text-[13px] text-faint">{tx('还没有事件')}</p> : events.map(e => <div key={e.id} className="flex items-start gap-2.5 border-t border-line py-2 text-[13px] first:border-0">
        <SourceIcon source={e.source} size={14} className="mt-0.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span className="font-medium text-fg">{e.source === 'cron' ? tx('定时任务') : e.actor}</span>{!e.human && <span className="rounded bg-card px-1 text-[10px]">bot</span>}
            <span className="text-faint">{SOURCE_LABEL[e.source] ?? e.source} · {stamp(e.at)}</span>
            {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="text-accent" aria-label={tx('打开原文')}><ExternalLink size={11} /></a>}
          </span>
          <span className="mt-0.5 line-clamp-2 block">{e.text}</span>
          <span className={cx('mt-0.5 block text-xs', { ok: 'text-ok', muted: 'text-faint', warn: 'text-warn', accent: 'text-accent' }[e.outcome.tone])}>{e.outcome.text}</span>
        </span>
        {e.ticketId && <button onClick={() => openTask(e.ticketId)} className="shrink-0 text-xs text-accent">{tx('详情')}</button>}
      </div>)}
    </Block>}
    <Row label={tx('审核记录')} sub={tx('每一次审核和批准，谁定的、为什么')}><Btn onClick={() => toggle('audit')}>{open === 'audit' ? tx('收起') : tx('查看')}</Btn></Row>
    {open === 'audit' && <Block className="max-h-[420px] overflow-y-auto">
      {!audit.length ? <p className="py-4 text-center text-[13px] text-faint">{tx('还没有需要审核的动作')}</p>
        : audit.map(e => <div key={e.id} className="flex gap-3 border-t border-line py-2 text-[13px] first:border-0">
          <span className="w-[92px] shrink-0 text-xs text-faint">{stamp(e.at)}</span>
          <span className={cx('w-8 shrink-0 font-medium', DECISION[e.decision]?.cls)}>{DECISION[e.decision]?.label ?? e.decision}</span>
          <span className="min-w-0 flex-1">
            <code className="font-mono text-xs break-all">{e.input}</code>
            <span className="block text-xs text-muted">{ACTOR[e.actor] ?? e.actor}{e.reason ? ` · ${e.reason}` : ''}</span>
          </span>
        </div>)}
    </Block>}
  </Section>
}
