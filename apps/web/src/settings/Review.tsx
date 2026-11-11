/**
 * 规则与审核 (Figma 21 · 06): who decides what needs asking first (the review model by your rules, or you every time),
 * the rules in your own words, the regex shortcuts, and the record of every decision.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type AuditEntry, type ReviewSettings } from '../api'
import { cx } from '../ui'
import { Area, Block, Btn, Choice, Page, Row, SaveBar, Section } from './kit'

const lines = (v: string) => v.split('\n').map(s => s.trim()).filter(Boolean)
const DECISION: Record<string, { label: string; cls: string }> = { allow: { label: '放行', cls: 'text-ok' }, block: { label: '拦截', cls: 'text-danger' }, escalate: { label: '问你', cls: 'text-warn' } }
const ACTOR: Record<string, string> = { reviewer: '审核模型', rule: '规则', owner: '你', system: '系统' }

export function Review() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['review'], queryFn: () => api.get<{ settings: ReviewSettings; defaults: ReviewSettings }>('/settings/review') })
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ entries: AuditEntry[] }>('/audit'), refetchInterval: 15_000 })
  const [draft, setDraft] = useState<{ rules: string; allow: string; deny: string } | null>(null)
  const [open, setOpen] = useState<'allow' | 'deny' | 'audit' | null>(null)
  const saved = query.data?.settings
  const text = (s: ReviewSettings) => ({ rules: s.rules.join('\n'), allow: s.allow.join('\n'), deny: s.deny.join('\n') })
  useEffect(() => { if (saved) setDraft(text(saved)) }, [JSON.stringify(saved)])
  const save = useMutation({ mutationFn: (s: ReviewSettings) => api.put('/settings/review', s), onSuccess: () => qc.invalidateQueries({ queryKey: ['review'] }) })
  if (!saved || !draft) return <Page title="规则与审核"><div /></Page>
  const next = { ...saved, rules: lines(draft.rules), allow: lines(draft.allow), deny: lines(draft.deny) }
  const dirty = JSON.stringify(text(next)) !== JSON.stringify(text(saved))
  const entries = audit.data?.entries ?? []
  const today = entries.filter(e => new Date(e.at).toDateString() === new Date().toDateString()).length
  const regex = (key: 'allow' | 'deny', label: string) => <>
    <Row label={label} sub="正则，每行一条" onClick={() => setOpen(o => (o === key ? null : key))}><span className="text-[13px] text-muted">{lines(draft[key]).length} 条</span></Row>
    {open === key && <Block><Area className="font-mono" value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })}
      placeholder={key === 'allow' ? '^git push origin super-assistant/' : 'push .*\\b(main|master)\\b'} /></Block>}
  </>
  return <Page title="规则与审核">
    <Section title="要问一声的事，谁来拍板" foot="哪些事它能自己做、哪些要先问你，在右侧栏「权限」里一项项改。">
      <Row label="由谁决定" sub="审核模型按你的规则放行、拦截，拿不准再问你">
        <Choice label="由谁决定" value={saved.mode} onChange={mode => save.mutate({ ...saved, mode })} options={[{ id: 'model', label: '审核模型判断' }, { id: 'ask', label: '每个都问我' }]} />
      </Row>
    </Section>
    <Section title="规则">
      <Block>
        <div className="mb-2.5 text-sm">用自己的话写，每行一条</div>
        <Area className="min-h-[92px]" value={draft.rules} onChange={e => setDraft({ ...draft, rules: e.target.value })} placeholder={'发邮件、发评论之前先让我看一眼。\n不要删任何文件。'} />
      </Block>
    </Section>
    <Section title="高级">
      {regex('allow', '直接放行')}
      {regex('deny', '直接拦截')}
    </Section>
    <SaveBar dirty={dirty} pending={save.isPending} error={save.error} onReset={() => setDraft(text(saved))} onSave={() => save.mutate(next)}
      extra={<Btn onClick={() => setDraft(text({ ...saved, ...query.data!.defaults }))}>恢复默认</Btn>} />
    <Section title="记录" foot="读取密码和密钥的命令一律禁止，不能改。">
      <Row label="审计记录" sub={`每一次审核和批准都记在这里 · 今天 ${today} 次`}><Btn onClick={() => setOpen(o => (o === 'audit' ? null : 'audit'))}>{open === 'audit' ? '收起' : '查看'}</Btn></Row>
      {open === 'audit' && <Block className="max-h-[420px] overflow-y-auto">
        {!entries.length ? <p className="py-4 text-center text-[13px] text-faint">还没有需要审核的动作</p>
          : entries.map(e => <div key={e.id} className="flex gap-3 border-t border-line py-2 text-[13px] first:border-0">
            <span className="w-[92px] shrink-0 text-xs text-faint">{new Date(e.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span className={cx('w-8 shrink-0 font-medium', DECISION[e.decision]?.cls)}>{DECISION[e.decision]?.label ?? e.decision}</span>
            <span className="min-w-0 flex-1">
              <code className="font-mono text-xs break-all">{e.input}</code>
              <span className="block text-xs text-muted">{ACTOR[e.actor] ?? e.actor}{e.reason ? ` · ${e.reason}` : ''}</span>
            </span>
          </div>)}
      </Block>}
    </Section>
  </Page>
}
