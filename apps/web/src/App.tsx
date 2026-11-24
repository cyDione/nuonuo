import { useQuery } from '@tanstack/react-query'
import { Inbox, Menu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError, type Health } from './api'
import { Chat } from './Chat'
import { Connect } from './Connect'
import { bootstrapConnection, isInsecureRemoteUrl, openConnectionCenter, useConnection } from './connection'
import { go, useRoute } from './route'
import { Settings } from './settings/Settings'
import { Sidebar, StatusDot, ThreadPanel } from './Sidebar'
import { openActivity, openTask, useLive, useLiveEvents } from './live'
import { needsOwner, TaskDrawer, useTickets } from './tasks'
import { Activity } from './Activity'
import { Library } from './library'
import { GoalsPage } from './goals'
import { IdeasPage } from './ideas'
import { PaneDrawer, RightPane, setPaneTab } from './RightPane'
import { openPane } from './Sidebar'
import { QuickAsk } from './QuickAsk'
import { Pane, Resizer, togglePane, TopBar, useDesktopChrome, usePaneShortcuts, useScrollingClass } from './shell'
import { Avatar, BRAND, Mascot, statusLine, usePersona } from './persona'
import { cx, IconButton } from './ui'
import { useSettingsShortcut } from './More'
import { SearchButton, SearchDialog } from './search'
import { tx } from './i18n'

export function App() {
  const route = useRoute()
  const conn = useConnection()
  useDesktopChrome()
  useEffect(() => { void bootstrapConnection() }, [])
  const health = useQuery({
    queryKey: ['health', conn.activeProfileId, conn.baseUrl],
    queryFn: () => api.get<Health>('/health'),
    enabled: conn.status === 'ready',
    refetchInterval: 30_000,
  })
  const [nav, setNav] = useState(false)
  // Going somewhere else closes the activity panel and any open task.
  useEffect(() => {
    openActivity(false); openTask(null)
    // Old links to 它 (#/me) open the right pane on 它是谁 over the main chat.
    if (route.page === 'me') { go('/'); setPaneTab('who'); setTimeout(() => openPane(true), 60) }
  }, [JSON.stringify(route)])
  useWaitingLink(route.page === 'waiting' && conn.status === 'ready')

  if (conn.status === 'booting') return <Splash />
  if (conn.status === 'unauthenticated' || (health.error instanceof ApiError && health.error.status === 401)) return <Connect />
  if (conn.status === 'offline') return <Offline message={conn.error || tx('服务端当前不可达')} />
  if (health.isPending) return <Splash />
  if (health.error) return <Offline message={health.error.message} />

  const authed = health.isSuccess
  const insecure = isInsecureRemoteUrl(conn.baseUrl)
  return <Shell authed={authed}>
    {insecure && <div className="flex items-center justify-center gap-2 bg-warn-soft px-3 py-1 text-[11px] text-warn">
      <span>{tx('当前通过非加密 HTTP 连接远程服务（{0}），生产环境请改用 HTTPS 或 Tailscale。', conn.baseUrl)}</span>
    </div>}
    {route.page === 'quick' ? <QuickAsk /> : <Layout route={route} nav={nav} setNav={setNav} />}
  </Shell>
}

function Layout({ route, nav, setNav }: { route: ReturnType<typeof useRoute>; nav: boolean; setNav(v: boolean): void }) {
  usePaneShortcuts()
  useScrollingClass()
  useSettingsShortcut()
  // 设置 has the window to itself, with its own sidebar and 返回聊天.
  if (route.page === 'settings') return <><Settings tab={route.tab} {...(route.item ? { item: route.item } : {})} /><SearchDialog /></>
  const chat = route.page === 'chat'
  return <div className="sky-stage relative flex h-dvh overflow-hidden">
    <Sidebar route={route} open={nav} onClose={() => setNav(false)} />
    <main className="flex min-w-0 flex-1 md:pl-[88px]">
      <div className="contents max-xl:hidden">
        <Pane side="left"><div className="h-full w-full py-3 pl-2"><ThreadPanel route={route} onClose={() => togglePane('left', false)} /></div></Pane>
        <Resizer side="left" />
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <MobileBar onMenu={() => setNav(true)} />
        <TopBar className="max-md:hidden" />
        <div key={route.page === 'chat' ? `c${route.id ?? (route.main ? 'main' : 'new')}` : route.page} className="min-h-0 flex-1">
          {chat ? (route.main ? <MainChat /> : <Chat key={route.id ?? 'new'} id={route.id} />)
            : route.page === 'activity' ? <Activity /> : route.page === 'library' ? <Library /> : route.page === 'goals' ? <GoalsPage /> : route.page === 'ideas' ? <IdeasPage />
            : null}
        </div>
      </div>
      <div className="contents max-xl:hidden">
        <Resizer side="right" />
        <Pane side="right"><div className="h-full w-full py-3 pr-3"><aside className="glass-strong h-full w-full overflow-hidden rounded-[26px] shadow-[var(--shadow-ceramic)]">
          <RightPane onClose={() => togglePane('right', false)} />
        </aside></div></Pane>
      </div>
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
  const tickets = useTickets(active)
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
  return <div className="glass-surface mx-2 mt-[max(8px,env(safe-area-inset-top))] flex h-13 shrink-0 items-center gap-1 rounded-2xl px-1.5 shadow-[var(--shadow-bubble)] md:hidden">
    <IconButton label={tx('打开菜单')} onClick={onMenu} className="size-9 text-fg"><Menu size={19} /></IconButton>
    <button onClick={() => openActivity(true)} className="press flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 text-left">
      <Avatar persona={persona} size={30} mood={connected ? status.tone : 'sleepy'} />
      <span className="min-w-0">
        <span className="block truncate font-display text-[15px] leading-tight font-semibold">{persona.name}</span>
        <span className="flex items-center gap-1.5 truncate text-[11px] text-muted"><StatusDot tone={connected ? status.tone : 'offline'} /><span className="truncate">{connected ? status.text : tx('重连中…')}</span></span>
      </span>
    </button>
    <SearchButton className="size-9" />
    <button onClick={() => openActivity(true)} aria-label={tx('今天')} className={cx('press flex shrink-0 items-center justify-center gap-1 rounded-full text-[12px] font-semibold tabular-nums', waiting ? 'h-9 bg-warn-soft px-3 text-warn' : 'size-9 text-muted hover:bg-sunken hover:text-fg')}>
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
  return <div className="sky-stage flex h-dvh flex-col items-center justify-center gap-4 text-sm text-muted">
    <Mascot color={BRAND} size={68} mood="thinking" />
    <span className="anim-fade">{tx('正在连接服务…')}</span>
  </div>
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="sky-stage relative flex h-dvh items-center justify-center p-6">
    <div className="dot-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
    <div className="anim-pop glass-strong relative w-full max-w-md space-y-4 rounded-[28px] p-8 text-center shadow-[var(--shadow-ceramic)]">{children}</div>
  </div>
}

function Offline({ message }: { message: string }) {
  return <Centered>
    <div className="flex justify-center"><Mascot color={BRAND} size={88} mood="sleepy" /></div>
    <h1 className="font-display text-2xl font-semibold text-balance">{tx('暂时连不上服务')}</h1>
    <p className="text-sm text-pretty text-muted">{tx('请确认目标 Nuonuo 服务端正在运行，或切换到其他服务地址。')}</p>
    <p className="text-xs break-words text-faint">{message}</p>
    <div className="flex justify-center gap-2 pt-2">
      <button type="button" onClick={() => location.reload()} className="press h-9 rounded-xl border border-line bg-sunken px-4 text-xs font-medium hover:border-faint">{tx('重试连接')}</button>
      <button type="button" onClick={openConnectionCenter} className="press h-9 rounded-xl bg-ink px-4 text-xs font-medium text-ink-fg">{tx('切换服务 / 重新认证')}</button>
    </div>
  </Centered>
}
