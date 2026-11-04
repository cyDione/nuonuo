import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type UsageRow } from '../api'
import { Card, Empty, cx, fmtNum, fmtUsd } from '../ui'
import { useCatalog, useProviders } from './hooks'

export function Usage() {
  const [days, setDays] = useState(1)
  const usage = useQuery({ queryKey: ['usage', days], queryFn: () => api.get<{ rows: UsageRow[] }>(`/usage?days=${days}`) })
  const catalog = useCatalog()
  const providers = useProviders()
  const rows = usage.data?.rows ?? []
  const total = rows.reduce((t, r) => ({ calls: t.calls + r.calls, tokens: t.tokens + r.inputTokens + r.outputTokens, cache: t.cache + r.cacheReadTokens,
    cost: r.costUsd == null ? t.cost : (t.cost ?? 0) + r.costUsd }), { calls: 0, tokens: 0, cache: 0, cost: null as number | null })
  const roleLabel = (id: string) => catalog.data?.roles.find(r => r.id === id)?.label ?? id
  const providerName = (id: string) => providers.data?.providers.find(p => p.id === id)?.name ?? '（已删除）'
  return <>
    <div className="flex gap-1">
      {[1, 7, 30].map(d => <button key={d} onClick={() => setDays(d)} className={cx('rounded-lg px-3 py-1.5 text-sm', d === days ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-sunken')}>
        {d === 1 ? '今天' : `近 ${d} 天`}</button>)}
    </div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="调用" value={fmtNum(total.calls)} />
      <Stat label="Token（输入+输出）" value={fmtNum(total.tokens)} />
      <Stat label="缓存读" value={fmtNum(total.cache)} />
      <Stat label="估算费用" value={fmtUsd(total.cost)} />
    </div>
    <Card className="overflow-x-auto">
      {rows.length === 0 ? <Empty title="这段时间没有模型调用" /> :
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-faint"><tr className="border-b border-line">
            {['层', '模型', '调用', '失败', '输入', '输出', '缓存读', '推理', '费用'].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
          </tr></thead>
          <tbody>{rows.map(r => <tr key={`${r.role}-${r.providerId}-${r.model}`} className="border-b border-line last:border-0">
            <td className="px-3 py-2">{roleLabel(r.role)}</td>
            <td className="px-3 py-2"><div className="font-mono text-xs">{r.model}</div><div className="text-[11px] text-faint">{providerName(r.providerId)}</div></td>
            <td className="px-3 py-2 tabular-nums">{fmtNum(r.calls)}</td>
            <td className={cx('px-3 py-2 tabular-nums', r.failures > 0 && 'text-danger')}>{fmtNum(r.failures)}</td>
            <td className="px-3 py-2 tabular-nums">{fmtNum(r.inputTokens)}</td>
            <td className="px-3 py-2 tabular-nums">{fmtNum(r.outputTokens)}</td>
            <td className="px-3 py-2 tabular-nums">{fmtNum(r.cacheReadTokens)}</td>
            <td className="px-3 py-2 tabular-nums">{fmtNum(r.reasoningTokens)}</td>
            <td className="px-3 py-2 tabular-nums">{fmtUsd(r.costUsd)}</td>
          </tr>)}</tbody>
        </table>}
    </Card>
  </>
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card className="px-4 py-3"><div className="text-xs text-muted">{label}</div><div className="mt-1 text-xl font-semibold tabular-nums">{value}</div></Card>
}
