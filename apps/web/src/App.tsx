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
import { Activity } from './Activity'
import { Library } from './library'
import { GoalsPage } from './goals'
import { IdeasPage } from './ideas'
import { PaneDrawer, RightPane, setPaneTab } from './RightPane'
import { openPane } from './Sidebar'
import { QuickAsk } from './QuickAsk'
import { Pane, Resizer, togglePane, TopBar, useDesktopChrome, usePanes, usePaneShortcuts, useScrollingClass } from './shell'
import { Avatar, BRAND, Mascot, statusLine, usePersona } from './persona'
import { cx, IconButton } from './ui'
import { useSettingsShortcut } from './More'
import { SearchButton, SearchDialog } from './search'
import { tx } from './i18n'

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
  useWaitingLink(route.page === 'waiting')

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
  // 设置 has the window to itself, with its own sidebar and 返回聊天 (Figma v6, 21).
  if (route.page === 'settings') return <><Settings tab={route.tab} {...(route.item ? { item: route.item } : {})} /><SearchDialog /></>
  const chat = route.page === 'chat'
  const tabbed = chat || route.page === 'activity' || route.page === 'library' || route.page === 'goals' || route.page === 'ideas'
  return <div className="flex h-dvh bg-bg">
    <Sidebar route={route} open={nav} onClose={() => setNav(false)} />
    <main className={cx('flex min-w-0 flex-1', leftOpen && 'md:border-l md:border-line')}>
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <MobileBar onMenu={() => setNav(true)} />
        {tabbed ? <TopBar className="max-md:hidden" right={<SearchButton className="no-drag mr-1" />} /> : !chat && <TopBar className="max-md:hidden" />}
        <div key={route.page === 'chat' ? `c${route.id ?? (route.main ? 'main' : 'new')}` : route.page} className="min-h-0 flex-1">
          {chat ? (route.main ? <MainChat /> : <Chat key={route.id ?? 'new'} id={route.id} />)
            : route.page === 'activity' ? <Activity /> : route.page === 'library' ? <Library /> : route.page === 'goals' ? <GoalsPage /> : route.page === 'ideas' ? <IdeasPage />
            : null}
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

/**
 * #/waiting (tray 「等你点头」, approval banners with no chat): lands on the thing itself. One that belongs to a chat opens
 * that chat, where its card is; otherwise the main chat with the right pane on 活动, where 等你点头 is on top.
 */
function useWaitingLink(active: boolean) {
  const tickets = useTickets()
  useEffect(() => {
    if (!active || !tickets.data) return
    const first = tickets.data.tickets.filter(needsOwner).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (first?.conversationId) { go(`/c/${first.conversationId}`); return }
    go('/'); setPaneTab('activity'); setTimeout(() => openPane(true), 60)
  }, [active, tickets.data])
}

/** Phones: the menu, the assistant's face and status, and what waits for you (opens the "today" sheet). */
function MobileBar({ onMenu }: { onMenu(): void }) {
  const persona = usePersona()
  const connected = useLive(s => s.connected)
  const tickets = (useTickets().data?.tickets ?? []).filter(t => t.stage !== 'ended')
  const status = statusLine(tickets)
  const waiting = tickets.filter(needsOwner).length
  return <div className="flex h-14 shrink-0 items-center gap-1 px-2 pt-[env(safe-area-inset-top)] md:hidden">
    <IconButton label={tx('打开菜单')} onClick={onMenu} className="size-10 text-fg"><Menu size={20} /></IconButton>
    <button onClick={() => openActivity(true)} className="press flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 text-left">
      <Avatar persona={persona} size={30} mood={connected ? status.tone : 'sleepy'} />
      <span className="min-w-0">
        <span className="block truncate font-display text-[15px] leading-tight font-semibold">{persona.name}</span>
        <span className="flex items-center gap-1.5 truncate text-[11px] text-faint"><StatusDot tone={connected ? status.tone : 'offline'} /><span className="truncate">{connected ? status.text : tx('重连中…')}</span></span>
      </span>
    </button>
    <SearchButton />
    <button onClick={() => openActivity(true)} aria-label={tx('今天')} className={cx('press mr-1 flex h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold tabular-nums', waiting ? 'bg-warn-soft text-warn' : 'text-muted')}>
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
    <span className="anim-fade">{tx('正在连接本机服务…')}</span>
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
    <h1 className="font-display text-2xl font-semibold text-balance">{tx('先打个招呼')}</h1>
    <p className="text-sm text-pretty text-muted">{tx('Super-assistant 只接受带访问令牌的请求。在终端运行下面的命令，打开它输出的链接：')}</p>
    <pre className="rounded-2xl bg-ink px-4 py-3 text-left font-mono text-sm text-ink-fg">super-assistant token</pre>
  </Centered>
}

function Offline({ message }: { message: string }) {
  return <Centered>
    <div className="flex justify-center"><Mascot color={BRAND} size={88} mood="sleepy" /></div>
    <h1 className="font-display text-2xl font-semibold text-balance">{tx('连不上本机服务')}</h1>
    <p className="text-sm text-pretty text-muted">{tx('请确认')} <code className="rounded bg-sunken px-1.5 py-0.5 font-mono">super-assistant start</code> {tx('正在运行。')}</p>
    <p className="text-xs break-words text-faint">{message}</p>
  </Centered>
}
