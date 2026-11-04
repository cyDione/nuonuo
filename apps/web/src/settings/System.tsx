import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { api, type Check, type Health, type TranscriptItem } from '../api'
import { notificationsEnabled, setNotifications } from '../live'
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
    <NotifyToggle />
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
    <RouterLog />
  </>
}

function RouterLog() {
  const [open, setOpen] = useState(false)
  const log = useQuery({ queryKey: ['router-log'], enabled: open, refetchInterval: open ? 3000 : false,
    queryFn: () => api.get<{ state: string; transcript: TranscriptItem[] }>('/router') })
  return <Card className="p-4">
    <button onClick={() => setOpen(v => !v)} className="text-sm font-medium">{open ? '▾' : '▸'} 主 Agent 日志 <span className="font-normal text-faint">（路由决策与工具调用，用于排查）</span></button>
    {open && <div className="mt-3 max-h-[480px] space-y-1.5 overflow-y-auto font-mono text-[11px]">
      {log.data?.transcript.map(item => <div key={item.id} className="whitespace-pre-wrap text-muted">
        {item.kind === 'input' ? <span className="text-fg">▶ {item.text.slice(0, 1500)}</span>
          : item.kind === 'tool-call' ? <span className="text-accent">⚙ {item.tool} {JSON.stringify(item.input).slice(0, 400)}</span>
          : item.kind === 'tool-result' ? <span>  ↳ {item.output.slice(0, 300)}</span>
          : item.kind === 'text' || item.kind === 'reasoning' ? <span className="text-faint">{item.kind === 'reasoning' ? '💭 ' : ''}{item.text.slice(0, 600)}</span>
          : <span className="text-danger">{JSON.stringify(item)}</span>}
      </div>)}
      {log.data && !log.data.transcript.length && <div className="text-faint">还没有记录</div>}
    </div>}
  </Card>
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="flex gap-3"><span className="w-16 shrink-0 text-muted">{label}</span><span className={mono ? 'truncate font-mono text-xs leading-5' : ''}>{value}</span></div>
}

function NotifyToggle() {
  const [on, setOn] = useState(notificationsEnabled())
  const supported = typeof Notification !== 'undefined'
  return <Card className="flex items-center gap-3 p-4">
    <div className="flex-1">
      <div className="text-sm font-medium">桌面通知</div>
      <div className="text-xs text-muted">页面不在前台时，智能体发来消息（任务完成、需要你决定、定时任务结果）会弹出系统通知。</div>
    </div>
    <Button size="sm" disabled={!supported} onClick={async () => setOn(await setNotifications(!on))}>{!supported ? '浏览器不支持' : on ? '已开启' : '开启'}</Button>
  </Card>
}
