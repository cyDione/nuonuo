import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw, Download } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type Check, type Health, type TranscriptItem, type UpdateStatus } from '../api'
import { notificationsEnabled, setNotifications } from '../live'
import { Badge, Button, Card } from '../ui'

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
    <UpdateCard />
    <NotifyToggle />
    <WatchdogCard />
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

function WatchdogCard() {
  const run = useMutation({ mutationFn: () => api.post<{ findings: { kind: string; detail: string }[] }>('/watchdog/run') })
  const open = async () => { const { conversationId } = await api.get<{ conversationId: string }>('/watchdog'); location.hash = `/c/${conversationId}` }
  return <Card className="flex flex-wrap items-center gap-3 p-4">
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">Watchdog</div>
      <div className="text-xs text-muted">每分钟巡检一次：卡住、空转、说「继续」却没人唤醒的任务，以及出错的队列和来源。发现问题会提醒任务或在自己的对话里告诉你。</div>
      {run.data && <div className="mt-1 text-xs text-faint">{run.data.findings.length ? run.data.findings.map(f => `${f.kind}：${f.detail}`).join('；') : '本次巡检没有发现问题'}</div>}
    </div>
    <Button size="sm" variant="ghost" onClick={() => run.mutate()} disabled={run.isPending}>立即巡检</Button>
    <Button size="sm" onClick={open}>和它对话</Button>
  </Card>
}

/** New releases: checked by the service twice a day; "立即更新" runs install.sh, then the service restarts on the new version. */
function UpdateCard() {
  const qc = useQueryClient()
  const [updating, setUpdating] = useState<{ from: string; target: string } | null>(null)
  const [lost, setLost] = useState(false)
  const status = useQuery({ queryKey: ['update'], queryFn: () => api.get<UpdateStatus>('/update'), refetchInterval: updating ? 2000 : false, retry: false })
  const check = useMutation({ mutationFn: () => api.post<UpdateStatus>('/update/check'), onSuccess: data => qc.setQueryData(['update'], data) })
  const start = useMutation({
    mutationFn: () => api.post<UpdateStatus>('/update'),
    onSuccess: data => { qc.setQueryData(['update'], data); setLost(false); setUpdating({ from: data.current, target: data.run?.target ?? '' }) },
  })
  const s = status.data
  // The service restarts mid-update: requests fail for a moment, then the new version answers.
  const reloaded = useRef(false)
  useEffect(() => {
    if (!updating) return
    if (status.isError) setLost(true)
    if (s && s.current !== updating.from && !reloaded.current) { reloaded.current = true; setTimeout(() => location.reload(), 800) }
    if (s?.run?.state === 'failed') setUpdating(null)
  }, [status.dataUpdatedAt, status.errorUpdatedAt])
  // Restarting is either quick or broken. After a while say what happened instead of showing 正在重启 forever.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!updating) { setSlow(false); return }
    const t = setTimeout(() => setSlow(true), 45_000)
    return () => clearTimeout(t)
  }, [updating])

  if (!s) return null
  const running = Boolean(updating) || s.run?.state === 'running'
  const done = s && updating && s.current !== updating.from
  const stuck = running && slow && Boolean(updating)
  const stuckText = lost
    ? '服务没有回来：在终端运行 super-assistant start，或用 systemctl --user status super-assistant 查看原因'
    : s.current === updating?.from ? `已安装 ${updating?.target}，但服务仍报告 ${s.current}：安装包与版本号不符，或重启没有生效`
    : '已安装更新，但没有检测到服务重启：请手动重启并查看服务日志'
  return <Card className="space-y-2 p-4">
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          版本更新
          {s.available && !running && <Badge tone="accent">新版本 {s.latest?.tag}</Badge>}
          {!s.available && s.latest && !s.checkError && <Badge tone="ok">已是最新</Badge>}
        </div>
        <div className="text-xs text-muted">
          {done ? `已更新到 ${s.current}，正在刷新页面…`
            : running ? (stuck ? stuckText : lost ? '正在重启服务…' : `正在安装 ${updating?.target || s.run?.target}…`)
            : s.checkError ? <span className="text-danger">检查失败：{s.checkError}</span>
            : s.available ? <>当前 {s.current}，最新 {s.latest?.tag}{s.latest?.url && <> · <a className="underline" href={s.latest.url} target="_blank" rel="noreferrer">更新说明</a></>}。{s.hint}。</>
            : s.checkedAt ? `当前 ${s.current} · 上次检查 ${new Date(s.checkedAt).toLocaleString()}`
            : `当前 ${s.current} · 还没有检查过`}
        </div>
        {!s.canUpdate && <div className="mt-0.5 text-xs text-faint">{s.hint}</div>}
        {s.run?.state === 'failed' && !running && <div className="mt-0.5 text-xs text-danger">更新失败：{s.run.error}</div>}
      </div>
      <Button size="sm" variant="ghost" onClick={() => check.mutate()} disabled={check.isPending || running}><RefreshCw size={13} className={check.isPending ? 'animate-spin' : ''} />检查更新</Button>
      {stuck && <Button size="sm" variant="ghost" onClick={() => setUpdating(null)}>知道了</Button>}
      {s.available && s.canUpdate && <Button size="sm" variant="primary" onClick={() => start.mutate()} disabled={start.isPending || running}><Download size={13} />立即更新</Button>}
    </div>
    {start.error && <div className="text-xs text-danger">{(start.error as Error).message}</div>}
    {(running || s.run?.state === 'failed') && s.run?.log && <pre className="max-h-48 overflow-y-auto rounded-lg bg-sunken p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{s.run.log}</pre>}
  </Card>
}
