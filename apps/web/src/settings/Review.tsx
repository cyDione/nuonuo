import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type AuditEntry, type ReviewSettings } from '../api'
import { Badge, Button, Card, Field, Select, cx } from '../ui'

const lines = (v: string) => v.split('\n').map(s => s.trim()).filter(Boolean)
const Area = ({ value, onChange, placeholder, mono }: { value: string[]; onChange(v: string[]): void; placeholder?: string; mono?: boolean }) =>
  <textarea className={cx('min-h-24 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent', mono && 'font-mono text-xs')}
    value={value.join('\n')} placeholder={placeholder} onChange={e => onChange(lines(e.target.value))} />

export function Review() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['review'], queryFn: () => api.get<{ settings: ReviewSettings; defaults: ReviewSettings }>('/settings/review') })
  const [draft, setDraft] = useState<ReviewSettings | null>(null)
  useEffect(() => { if (query.data) setDraft(query.data.settings) }, [query.data])
  const save = useMutation({ mutationFn: (s: ReviewSettings) => api.put('/settings/review', s), onSuccess: () => qc.invalidateQueries({ queryKey: ['review'] }) })
  if (!draft || !query.data) return null
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data.settings)
  return <>
    <Card className="space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="审核哪些动作" hint="由命令特征自动判断：推送、发布、发评论、向外发送数据属于「对外」；强制推送、合并、删库等属于「高风险」。">
          <Select value={draft.threshold} onChange={e => setDraft({ ...draft, threshold: e.target.value as ReviewSettings['threshold'] })}>
            <option value="external">对外与高风险动作（推荐）</option><option value="destructive">只审核高风险动作</option><option value="off">不审核</option>
          </Select>
        </Field>
        <Field label="由谁决定" hint="审核模型拿不准时也会交给你。">
          <Select value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value as ReviewSettings['mode'] })}>
            <option value="model">审核模型按规则判断（放行 / 拦截 / 问我）</option><option value="ask">每一个都问我</option>
          </Select>
        </Field>
        <Field label="高风险动作" hint="强制推送、合并 PR、删除仓库或数据等。">
          <Select value={draft.destructive} onChange={e => setDraft({ ...draft, destructive: e.target.value as ReviewSettings['destructive'] })}>
            <option value="ask">一律问我（推荐）</option><option value="review">也交给审核模型判断</option>
          </Select>
        </Field>
      </div>
      <Field label="规则（自然语言，每行一条）" hint="审核模型按这些规则判断；它们优先于任务里的任何说法。">
        <Area value={draft.rules} onChange={rules => setDraft({ ...draft, rules })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="直接放行（正则，每行一条）" hint="命中即放行，不调用模型"><Area mono value={draft.allow} onChange={allow => setDraft({ ...draft, allow })} placeholder="^git push origin super-assistant/" /></Field>
        <Field label="直接拦截（正则，每行一条）" hint="命中即拦截，优先于放行"><Area mono value={draft.deny} onChange={deny => setDraft({ ...draft, deny })} placeholder="push .*\b(main|master)\b" /></Field>
      </div>
      {(dirty || save.error) && <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
        {save.error && <span className="mr-auto text-xs text-danger">{(save.error as Error).message}</span>}
        <Button size="sm" variant="ghost" onClick={() => setDraft(query.data!.settings)}>还原</Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(query.data!.defaults)}>恢复默认</Button>
        <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate(draft)}>保存</Button>
      </div>}
    </Card>
    <Audit />
  </>
}

const DECISION: Record<string, { label: string; tone: 'ok' | 'danger' | 'warn' }> = { allow: { label: '放行', tone: 'ok' }, block: { label: '拦截', tone: 'danger' }, escalate: { label: '问主人', tone: 'warn' } }
const ACTOR: Record<string, string> = { reviewer: '审核模型', rule: '规则', owner: '主人', system: '系统' }

function Audit() {
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ entries: AuditEntry[] }>('/audit'), refetchInterval: 15_000 })
  const entries = audit.data?.entries ?? []
  return <Card className="overflow-x-auto">
    <div className="border-b border-line px-4 py-3 text-sm font-medium">审计记录 <span className="font-normal text-faint">（每一次审核与批准）</span></div>
    {!entries.length ? <div className="px-4 py-8 text-center text-sm text-faint">还没有需要审核的动作</div> :
      <table className="w-full text-sm"><tbody>{entries.map(e => <tr key={e.id} className="border-b border-line align-top last:border-0">
        <td className="px-4 py-2 text-xs whitespace-nowrap text-faint">{new Date(e.at).toLocaleString()}</td>
        <td className="px-2 py-2 whitespace-nowrap"><Badge tone={DECISION[e.decision]?.tone ?? 'neutral'}>{DECISION[e.decision]?.label ?? e.decision}</Badge></td>
        <td className="px-2 py-2 text-xs whitespace-nowrap text-muted">{ACTOR[e.actor] ?? e.actor}</td>
        <td className="px-2 py-2"><code className="font-mono text-xs break-all">{e.input}</code>{e.reason && <div className="mt-0.5 text-xs text-muted">{e.reason}</div>}</td>
        <td className="px-4 py-2 font-mono text-[11px] whitespace-nowrap text-faint">{e.ticketId}</td>
      </tr>)}</tbody></table>}
  </Card>
}
