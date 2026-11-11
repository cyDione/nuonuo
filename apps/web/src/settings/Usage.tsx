/** 用量 (Figma 21 · 10): calls, tokens and estimated cost, by layer and model, for today or the last 7 or 30 days. */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type UsageRow } from '../api'
import { cx, fmtUsd } from '../ui'
import { Choice, Foot, Page, Stat } from './kit'
import { useCatalog } from './hooks'
import { tx } from '../i18n'

/** 1240000 → 1.24M, 860000 → 860K. */
const short = (n: number) => n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n)

export function Usage() {
  const [days, setDays] = useState<'1' | '7' | '30'>('1')
  const usage = useQuery({ queryKey: ['usage', Number(days)], queryFn: () => api.get<{ rows: UsageRow[] }>(`/usage?days=${days}`) })
  const catalog = useCatalog()
  const rows = usage.data?.rows ?? []
  const total = rows.reduce((t, r) => ({ calls: t.calls + r.calls, tokens: t.tokens + r.inputTokens + r.outputTokens, cache: t.cache + r.cacheReadTokens,
    cost: r.costUsd == null ? t.cost : (t.cost ?? 0) + r.costUsd }), { calls: 0, tokens: 0, cache: 0, cost: null as number | null })
  const roleLabel = (id: string) => catalog.data?.roles.find(r => r.id === id)?.label ?? id
  const th = 'px-2 py-3 text-left text-xs font-normal text-muted'
  const td = 'px-2 py-3 tabular-nums'
  return <Page title={tx('用量')}>
    <Choice<'1' | '7' | '30'> label={tx('时间')} value={days} onChange={setDays} className="w-[250px]" options={[{ id: '1', label: tx('今天') }, { id: '7', label: tx('近 7 天') }, { id: '30', label: tx('近 30 天') }]} />
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label={tx('调用')} value={short(total.calls)} />
      <Stat label={tx('Token（输入+输出）')} value={short(total.tokens)} />
      <Stat label={tx('缓存读')} value={short(total.cache)} />
      <Stat label={tx('估算费用')} value={fmtUsd(total.cost)} />
    </div>
    <div className="overflow-x-auto rounded-2xl bg-sunken px-2">
      {!rows.length ? <p className="px-2 py-8 text-center text-[13px] text-faint">{tx('这段时间没有调用模型')}</p> :
        <table className="w-full min-w-[560px] text-[13px]">
          <thead><tr className="border-b border-line">{[tx('层'), tx('模型'), tx('调用'), tx('失败'), tx('输入'), tx('输出'), tx('缓存读'), tx('费用')].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody>{rows.map(r => <tr key={`${r.role}-${r.providerId}-${r.model}`} className="border-b border-line last:border-0">
            <td className="px-2 py-3 whitespace-nowrap">{roleLabel(r.role)}</td>
            <td className="px-2 py-3 font-mono text-xs">{r.model}</td>
            <td className={td}>{r.calls}</td>
            <td className={cx(td, r.failures > 0 && 'text-danger')}>{r.failures}</td>
            <td className={td}>{short(r.inputTokens)}</td>
            <td className={td}>{short(r.outputTokens)}</td>
            <td className={td}>{short(r.cacheReadTokens)}</td>
            <td className={td}>{fmtUsd(r.costUsd)}</td>
          </tr>)}</tbody>
        </table>}
    </div>
    {total.cost == null && rows.length > 0 && <Foot>{tx('在「模型供应商」里给模型填上价格，这里才算得出费用。')}</Foot>}
  </Page>
}
