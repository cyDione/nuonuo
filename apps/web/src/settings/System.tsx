import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from 'lucide-react'
import { api, type Check, type Health } from '../api'
import { Button, Card } from '../ui'

export function System() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health') })
  const doctor = useQuery({ queryKey: ['doctor'], queryFn: () => api.get<{ checks: Check[] }>('/doctor') })
  const h = health.data
  return <>
    {h && <Card className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
      <Info label="版本" value={h.version} />
      <Info label="进程" value={`pid ${h.pid} · 已运行 ${Math.round(h.uptimeMs / 60000)} 分钟`} />
      <Info label="数据目录" value={h.home} mono />
      <Info label="密钥存储" value={h.secrets === 'keychain' ? '系统钥匙串' : '加密文件'} />
    </Card>}
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-medium">环境检查</h2>
      <Button size="sm" variant="ghost" onClick={() => doctor.refetch()} disabled={doctor.isFetching}><RefreshCw size={13} className={doctor.isFetching ? 'animate-spin' : ''} />重新检查</Button>
    </div>
    <Card>
      {doctor.data?.checks.map(c => <div key={c.id} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-0">
        {c.status === 'ok' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" /> : c.status === 'warn' ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" /> : <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap justify-between gap-2 text-sm"><span>{c.label}</span><span className="text-muted">{c.detail}</span></div>
          {c.status !== 'ok' && c.fix && <div className="mt-0.5 text-xs text-faint">{c.fix}</div>}
        </div>
      </div>)}
    </Card>
  </>
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="flex gap-3"><span className="w-16 shrink-0 text-muted">{label}</span><span className={mono ? 'truncate font-mono text-xs leading-5' : ''}>{value}</span></div>
}
