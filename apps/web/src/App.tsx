import { useQuery } from '@tanstack/react-query'
import { Menu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError, type Health } from './api'
import { Chat } from './Chat'
import { useRoute } from './route'
import { Settings } from './settings/Settings'
import { Sidebar, StatusDot } from './Sidebar'
import { openActivity, openTask, useLive, useLiveEvents } from './live'
import { TaskDrawer, useTickets } from './tasks'
import { Activity, ActivityPanel, Library } from './Activity'
import { Avatar, Mascot, statusLine, usePersona } from './persona'
import { IconButton } from './ui'

export function App() {
  const route = useRoute()
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health'), refetchInterval: 30_000 })
  const [nav, setNav] = useState(false)
  // Going somewhere else closes the activity panel and any open task.
  useEffect(() => { openActivity(false); openTask(null) }, [JSON.stringify(route)])

  const authed = health.isSuccess
  if (health.error instanceof ApiError && health.error.status === 401) return <Login />
  if (health.isPending) return <Splash />
  if (health.error) return <Offline message={health.error.message} />

  return <Shell authed={authed}><div className="flex h-dvh">
    <Sidebar route={route} open={nav} onClose={() => setNav(false)} />
    <main className="min-w-0 flex-1 md:py-2 md:pr-2">
      <div className="sheet flex h-full flex-col overflow-hidden md:rounded-[24px]">
        <MobileBar onMenu={() => setNav(true)} />
        <div className="min-h-0 flex-1">
          {route.page === 'chat' ? (route.main ? <MainChat /> : <Chat key={route.id ?? 'new'} id={route.id} />)
            : route.page === 'activity' ? <Activity /> : route.page === 'library' ? <Library /> : <Settings tab={route.tab} {...(route.item ? { item: route.item } : {})} />}
        </div>
      </div>
    </main>
    <TaskDrawer />
    <ActivityPanel />
  </div></Shell>
}

/** Phones: the menu button and the assistant's face, since the sidebar is folded away. */
function MobileBar({ onMenu }: { onMenu(): void }) {
  const persona = usePersona()
  const connected = useLive(s => s.connected)
  const status = statusLine((useTickets().data?.tickets ?? []).filter(t => t.stage !== 'ended'))
  return <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2 pt-[env(safe-area-inset-top)] md:hidden">
    <IconButton label="打开菜单" onClick={onMenu} className="size-10"><Menu size={20} /></IconButton>
    <button onClick={() => openActivity(true)} className="press flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 py-1 text-left">
      <Avatar persona={persona} size={30} mood={connected ? status.tone : 'sleepy'} />
      <span className="min-w-0">
        <span className="block truncate font-display text-sm font-semibold">{persona.name}</span>
        <span className="flex items-center gap-1.5 truncate text-[11px] text-muted"><StatusDot tone={connected ? status.tone : 'offline'} /><span className="truncate">{connected ? status.text : '重连中…'}</span></span>
      </span>
    </button>
  </div>
}

/** The main conversation (Muse): where the app opens, one long chat with the assistant. */
function MainChat() {
  const main = useQuery({ queryKey: ['main-conversation'], queryFn: () => api.get<{ id: string }>('/conversations/main'), staleTime: Infinity })
  return main.data ? <Chat key={main.data.id} id={main.data.id} main /> : null
}

/** Mounted only once logged in, so the event stream never opens without the session cookie. */
function Shell({ authed, children }: { authed: boolean; children: React.ReactNode }) {
  useLiveEvents()
  return <>{authed && children}</>
}

const BRAND = '#2b3cff'

function Splash() {
  return <div className="flex h-dvh flex-col items-center justify-center gap-4 text-sm text-muted">
    <Mascot color={BRAND} size={72} mood="thinking" />
    <span className="anim-fade">正在连接本机服务…</span>
  </div>
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="relative flex h-dvh items-center justify-center p-6">
    <div className="dot-grid pointer-events-none absolute inset-0" aria-hidden />
    <div className="anim-pop relative w-full max-w-md space-y-4 rounded-[28px] border border-line bg-panel p-8 text-center shadow-[var(--shadow-sheet)]">{children}</div>
  </div>
}

function Login() {
  return <Centered>
    <div className="flex justify-center"><Mascot color={BRAND} size={88} mood="waiting" track /></div>
    <h1 className="font-display text-2xl font-semibold text-balance">先打个招呼</h1>
    <p className="text-sm text-pretty text-muted">Super-assistant 只接受带访问令牌的请求。在终端运行下面的命令，打开它输出的链接：</p>
    <pre className="rounded-2xl bg-ink px-4 py-3 text-left font-mono text-sm text-ink-fg">super-assistant token</pre>
  </Centered>
}

function Offline({ message }: { message: string }) {
  return <Centered>
    <div className="flex justify-center"><Mascot color={BRAND} size={88} mood="sleepy" /></div>
    <h1 className="font-display text-2xl font-semibold text-balance">连不上本机服务</h1>
    <p className="text-sm text-pretty text-muted">请确认 <code className="rounded bg-sunken px-1.5 py-0.5 font-mono">super-assistant start</code> 正在运行。</p>
    <p className="text-xs break-words text-faint">{message}</p>
  </Centered>
}
