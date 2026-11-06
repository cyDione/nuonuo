import { useQuery } from '@tanstack/react-query'
import { Inbox, Menu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError, type Health } from './api'
import { Chat } from './Chat'
import { go, useRoute } from './route'
import { Settings } from './settings/Settings'
import { Sidebar, StatusDot } from './Sidebar'
import { openActivity, openTask, useLive, useLiveEvents } from './live'
import { needsOwner, TaskDrawer, useTickets } from './tasks'
import { Activity, useFeed } from './Activity'
import { Library } from './library'
import { GoalsPage } from './goals'
import { IdeasPage, useIdeas } from './ideas'
import { PaneDrawer, RightPane, setPaneTab } from './RightPane'
import { openPane } from './Sidebar'
import { QuickAsk } from './QuickAsk'
import { Pane, Resizer, togglePane, TopBar, useDesktopChrome, usePanes, usePaneShortcuts, useScrollingClass } from './shell'
import { Avatar, BRAND, Mascot, statusLine, usePersona } from './persona'
import { cx, IconButton, Seg } from './ui'
import { useSettingsShortcut } from './QuickSettings'
import { SearchButton, SearchDialog } from './search'

export function App() {
  const route = useRoute()
  useDesktopChrome()
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health'), refetchInterval: 30_000 })
  const [nav, setNav] = useState(false)
  // Going somewhere else closes the activity panel and any open task.
  useEffect(() => {
    openActivity(false); openTask(null)
    // Old links to 它 (#/me) open the right pane on 它是谁 over the main chat.
    if (route.page === 'me') { go('/'); setPaneTab('who'); setTimeout(() => openPane(true), 60) }
  }, [JSON.stringify(route)])

  const authed = health.isSuccess
  if (health.error instanceof ApiError && health.error.status === 401) return <Login />
  if (health.isPending) return <Splash />
  if (health.error) return <Offline message={health.error.message} />

  return <Shell authed={authed}>{route.page === 'quick' ? <QuickAsk /> : <Layout route={route} nav={nav} setNav={setNav} />}</Shell>
}

function Layout({ route, nav, setNav }: { route: ReturnType<typeof useRoute>; nav: boolean; setNav(v: boolean): void }) {
  usePaneShortcuts()
  useScrollingClass()
  useSettingsShortcut()
  const { leftOpen } = usePanes()
  const chat = route.page === 'chat'
  const tabbed = (chat && route.main) || route.page === 'activity' || route.page === 'library' || route.page === 'goals' || route.page === 'ideas'
  return <div className="flex h-dvh bg-bg">
    <Sidebar route={route} open={nav} onClose={() => setNav(false)} />
    <main className={cx('flex min-w-0 flex-1', leftOpen && 'md:border-l md:border-line')}>
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <MobileBar onMenu={() => setNav(true)} />
        {tabbed ? <Tabs route={route} /> : !chat && <TopBar className="max-md:hidden" />}
        <div key={route.page === 'chat' ? `c${route.id ?? (route.main ? 'main' : 'new')}` : route.page} className="min-h-0 flex-1">
          {chat ? (route.main ? <MainChat /> : <Chat key={route.id ?? 'new'} id={route.id} />)
            : route.page === 'activity' ? <Activity /> : route.page === 'library' ? <Library /> : route.page === 'goals' ? <GoalsPage /> : route.page === 'ideas' ? <IdeasPage />
            : route.page === 'settings' ? <Settings tab={route.tab} {...(route.item ? { item: route.item } : {})} /> : null}
        </div>
      </div>
      {chat && <div className="contents max-xl:hidden">
        <Resizer side="right" />
        <Pane side="right"><aside className="h-full w-full overflow-hidden border-l border-line bg-panel">
          <RightPane onClose={() => togglePane('right', false)} />
        </aside></Pane>
      </div>}
    </main>
    <TaskDrawer />
    <PaneDrawer />
    <SearchDialog />
  </div>
}

type Tab = 'chat' | 'activity' | 'ideas' | 'goals' | 'library'
const TAB_PATHS: Record<Tab, string> = { chat: '/', activity: '/activity', ideas: '/ideas', goals: '/goals', library: '/library' }

/** 聊天 / 动态 / 成果 across the top of the main area (Figma v6). The page you're on sits on the white block. */
function Tabs({ route }: { route: ReturnType<typeof useRoute> }) {
  const waiting = (useTickets().data?.tickets ?? []).filter(needsOwner).length + (useFeed().data?.unseen ?? 0)
  const ideas = useIdeas().data?.batch
  const freshIdeas = !!ideas && !ideas.seen && ideas.cards.some(c => !c.dismissed && !c.done)
  const value: Tab = route.page === 'activity' ? 'activity' : route.page === 'library' ? 'library' : route.page === 'goals' ? 'goals' : route.page === 'ideas' ? 'ideas' : 'chat'
  return <div className="relative">
    <TopBar right={<SearchButton className="no-drag relative z-10 mr-1" />} />
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <Seg label="页面" value={value} onChange={t => go(TAB_PATHS[t])} className="no-drag pointer-events-auto w-[352px]"
        options={[{ id: 'chat', label: '聊天' }, { id: 'activity', label: '动态', dot: waiting > 0 && value !== 'activity' }, { id: 'ideas', label: '点子', dot: freshIdeas && value !== 'ideas' }, { id: 'goals', label: '目标' }, { id: 'library', label: '成果' }]} />
    </div>
  </div>
}

/** Phones: the menu, the assistant's face and status, and what waits for you (opens the "today" sheet). */
function MobileBar({ onMenu }: { onMenu(): void }) {
  const persona = usePersona()
  const connected = useLive(s => s.connected)
  const tickets = (useTickets().data?.tickets ?? []).filter(t => t.stage !== 'ended')
  const status = statusLine(tickets)
  const waiting = tickets.filter(needsOwner).length
  return <div className="flex h-14 shrink-0 items-center gap-1 px-2 pt-[env(safe-area-inset-top)] md:hidden">
    <IconButton label="打开菜单" onClick={onMenu} className="size-10 text-fg"><Menu size={20} /></IconButton>
    <button onClick={() => openActivity(true)} className="press flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 text-left">
      <Avatar persona={persona} size={30} mood={connected ? status.tone : 'sleepy'} />
      <span className="min-w-0">
        <span className="block truncate font-display text-[15px] leading-tight font-semibold">{persona.name}</span>
        <span className="flex items-center gap-1.5 truncate text-[11px] text-faint"><StatusDot tone={connected ? status.tone : 'offline'} /><span className="truncate">{connected ? status.text : '重连中…'}</span></span>
      </span>
    </button>
    <button onClick={() => openActivity(true)} aria-label="今天" className={cx('press mr-1 flex h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold tabular-nums', waiting ? 'bg-warn-soft text-warn' : 'text-muted')}>
      <Inbox size={16} />{waiting > 0 && <span key={waiting} className="bump">{waiting}</span>}
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
