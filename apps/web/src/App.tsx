import { useQuery } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { api, ApiError, type Health } from './api'
import { Chat } from './Chat'
import { useRoute } from './route'
import { Settings } from './settings/Settings'
import { Sidebar } from './Sidebar'
import { useLiveEvents } from './live'
import { TaskDrawer } from './tasks'

export function App() {
  const route = useRoute()
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health'), refetchInterval: 30_000 })

  const authed = health.isSuccess
  if (health.error instanceof ApiError && health.error.status === 401) return <Login />
  if (health.isPending) return <div className="flex h-full items-center justify-center text-sm text-faint">连接本机服务…</div>
  if (health.error) return <Offline message={health.error.message} />

  return <Shell authed={authed}><div className="flex h-full">
    <Sidebar route={route} />
    <main className="min-w-0 flex-1">
      {route.page === 'chat' ? <Chat key={route.id ?? 'new'} id={route.id} /> : <Settings tab={route.tab} />}
    </main>
    <TaskDrawer />
  </div></Shell>
}

/** Mounted only once logged in, so the event stream never opens without the session cookie. */
function Shell({ authed, children }: { authed: boolean; children: React.ReactNode }) {
  useLiveEvents()
  return <>{authed && children}</>
}

function Login() {
  return <div className="flex h-full items-center justify-center p-6">
    <div className="max-w-md space-y-4 rounded-2xl border border-line bg-panel p-8 text-center">
      <KeyRound className="mx-auto text-accent" size={32} />
      <h1 className="text-lg font-semibold">需要登录</h1>
      <p className="text-sm text-muted">Super-agent 只接受带访问令牌的请求。在终端运行下面的命令，打开它输出的链接：</p>
      <pre className="rounded-lg bg-sunken px-4 py-3 text-left font-mono text-sm">superagent token</pre>
    </div>
  </div>
}

function Offline({ message }: { message: string }) {
  return <div className="flex h-full items-center justify-center p-6">
    <div className="max-w-md space-y-3 rounded-2xl border border-line bg-panel p-8 text-center">
      <h1 className="text-lg font-semibold">连不上本机服务</h1>
      <p className="text-sm text-muted">请确认 <code className="font-mono">superagent start</code> 正在运行。</p>
      <p className="text-xs text-faint">{message}</p>
    </div>
  </div>
}
