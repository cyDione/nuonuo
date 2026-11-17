/**
 * 右侧栏「浏览器」与 60fps 实时交互流窗口 (Figma section 34 v3, 219:3084):
 * - Board A: default 16:10 concentric browser card (idle unactivated state & in-place activating loader), live 16:10 page preview
 *   when active, open pages switcher, URL input bar, and one-tap cloud desktop stream entry.
 * - Board B: single-header 780px takeover window with 60fps WebSocket live stream (<iframe>) for cloud desktop browsers,
 *   automatic fallback to LiveScreenshot canvas for local headless pages, and unified editable address bar.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Globe, LoaderCircle, Lock, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  api,
  type BrowserHandoffResult,
  type BrowserInputAction,
  type BrowserInputResult,
  type BrowserOpenResult,
  type BrowsersOverview,
  type OpenPageItem,
} from './api'
import { tx } from './i18n'
import { cx } from './ui'

const VIEWPORT_W = 1280
const VIEWPORT_H = 800

const checkDark = () => {
  if (typeof document === 'undefined') return false
  const set = document.documentElement.dataset.theme
  return set === 'dark' || (set !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(checkDark)
  useEffect(() => {
    const update = () => setDark(checkDark())
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    return () => { mo.disconnect(); mq.removeEventListener('change', update) }
  }, [])
  return dark
}

export const domainOf = (u: string) => {
  if (!u || u === 'about:blank') return ''
  try {
    const h = new URL(u).hostname.replace(/^www\./, '')
    return h || u
  } catch {
    return u
  }
}

const cleanTitle = (p: Pick<OpenPageItem, 'title' | 'url'>) =>
  p.title.trim() || domainOf(p.url) || tx('新标签页')

function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(s) || s.startsWith('about:')) return s
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/.test(s)) return `http://${s}`
  return `https://${s}`
}

function displayUrl(u: string): string {
  if (!u || u === 'about:blank') return ''
  return u.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export function useBrowsers(fast = false) {
  return useQuery({
    queryKey: ['browsers'],
    queryFn: () => api.get<BrowsersOverview>('/browsers'),
    refetchInterval: fast ? 3_000 : 15_000,
  })
}

export async function requestCloudDesktop(computerId: string, viewOnly = false) {
  return api.post<{ ok: boolean; url: string | null; expiresAt?: string }>(
    `/computers/${encodeURIComponent(computerId)}/desktop`,
    { viewOnly },
  )
}

/**
 * Sequential preloaded screenshot viewer: never cancels an in-flight frame on high-latency cloud links,
 * never flashes white between ticks, and pauses automatically while the document is hidden.
 */
function LiveScreenshot({
  srcBase,
  intervalMs,
  refreshKey = 0,
  alt,
  className,
  emptyLabel,
}: {
  srcBase: string
  intervalMs: number
  refreshKey?: number
  alt: string
  className?: string
  emptyLabel?: string
}) {
  const [shownSrc, setShownSrc] = useState<string | null>(null)
  const kickRef = useRef<() => void>(() => {})

  useEffect(() => {
    let cancelled = false
    setShownSrc(null)
    const st = { busy: false, wantImmediate: false, seq: 0, timer: 0 as ReturnType<typeof setTimeout> | 0 }

    const loadNext = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (st.busy) { st.wantImmediate = true; return }
      st.busy = true
      st.wantImmediate = false
      const sep = srcBase.includes('?') ? '&' : '?'
      const url = `${srcBase}${sep}t=${Date.now()}_${++st.seq}`
      const pre = new window.Image()
      const done = (ok: boolean) => {
        if (cancelled) return
        st.busy = false
        if (ok) setShownSrc(url)
        clearTimeout(st.timer)
        st.timer = setTimeout(loadNext, st.wantImmediate ? 40 : intervalMs)
      }
      pre.onload = () => done(true)
      pre.onerror = () => done(false)
      pre.src = url
    }

    kickRef.current = () => {
      clearTimeout(st.timer)
      if (st.busy) st.wantImmediate = true
      else loadNext()
    }

    loadNext()
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(st.timer)
        loadNext()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      clearTimeout(st.timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [srcBase, intervalMs])

  useEffect(() => {
    if (refreshKey > 0) kickRef.current()
  }, [refreshKey])

  if (!shownSrc) {
    return (
      <div className="flex size-full items-center justify-center text-xs text-faint">
        {emptyLabel ?? <Globe size={18} className="opacity-45" />}
      </div>
    )
  }
  return <img src={shownSrc} alt={alt} draggable={false} className={className} />
}

// ── Board A: RightPane 浏览器 Tab ────────────────────────────────────────────

export function BrowserPaneTab() {
  const qc = useQueryClient()
  const dark = useIsDark()
  const browsers = useBrowsers(true)
  const pages = browsers.data?.pages ?? []
  const computer = browsers.data?.computer ?? null

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [takeover, setTakeover] = useState<{
    key: string
    initialUrl?: string
    initialHasDesktop?: boolean
    initialComputerId?: string
    initialDesktopUrl?: string | null
  } | null>(null)
  const [desktopError, setDesktopError] = useState<string | null>(null)

  const active = pages.find(p => p.key === selectedKey) ?? pages[0] ?? null

  const openPage = useMutation({
    mutationFn: (url: string) => api.post<BrowserOpenResult>('/browsers/open', { url }),
    onSuccess: res => {
      setDesktopError(null)
      setUrlInput('')
      setSelectedKey(res.key)
      setTakeover({
        key: res.key,
        initialUrl: res.url,
        initialHasDesktop: res.hasDesktop,
        initialComputerId: res.computerId,
      })
      void qc.invalidateQueries({ queryKey: ['browsers'] })
    },
  })

  const closePage = useMutation({
    mutationFn: (key: string) => api.post<{ ok: true }>('/browsers/close', { key }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['browsers'] }),
  })

  const activateDefaultBrowser = () => {
    if (openPage.isPending) return
    openPage.mutate('')
  }

  const openCloudDesktopModal = (computerId: string) => {
    setDesktopError(null)
    setTakeover({
      key: `cloud:${computerId}:desktop:root`,
      initialHasDesktop: true,
      initialComputerId: computerId,
    })
  }

  const submitUrl = (e: React.FormEvent) => {
    e.preventDefault()
    const target = normalizeUrl(urlInput)
    if (!target || openPage.isPending) return
    openPage.mutate(target)
  }

  const inlineError = (openPage.error as Error | null)?.message ?? desktopError

  if (!active) {
    // Board A0 & A0-Activating: Default Concentric Browser Card (16 = 8 + 8)
    return (
      <div>
        <div className="rounded-2xl bg-sunken p-2">
          <button
            type="button"
            onClick={activateDefaultBrowser}
            disabled={openPage.isPending}
            aria-label={tx('点击激活浏览器')}
            className={cx(
              'relative flex aspect-[16/10] w-full cursor-pointer flex-col overflow-hidden rounded-lg bg-card text-center transition-colors duration-150 disabled:cursor-default',
              'ring-1 ring-inset',
              dark ? 'ring-white/[0.10]' : 'ring-black/[0.08] dark:ring-white/[0.10]',
            )}
          >
            {/* Minimal quiet browser top bar indicator */}
            <div className="flex h-6 w-full shrink-0 items-center border-b border-line/60 bg-sunken/50 px-2.5">
              <span className="h-2.5 w-20 rounded-full bg-line/70" />
            </div>

            {/* Viewport body */}
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4">
              {openPage.isPending ? (
                <>
                  <LoaderCircle size={18} className="animate-spin text-muted" />
                  <span className="mt-2.5 text-[13px] font-medium text-fg">
                    {computer ? tx('正在唤醒云电脑并打开浏览器…') : tx('正在打开浏览器…')}
                  </span>
                  <span className="mt-1 text-[11px] text-faint">
                    {tx('就绪后直接进入实时交互画面并聚焦地址栏')}
                  </span>
                </>
              ) : (
                <>
                  <span className="flex size-8 items-center justify-center rounded-lg bg-sunken">
                    <Globe size={15} className="text-muted" />
                  </span>
                  <span className="mt-2 text-[13px] font-medium text-fg">
                    {tx('点击激活浏览器')}
                  </span>
                  <span className="mt-0.5 text-[11px] text-faint">
                    {computer ? tx('在云电脑中打开，登录状态自动留存') : tx('在本机打开，登录状态自动留存')}
                  </span>
                </>
              )}
            </div>
          </button>

          <div className="mt-2 flex items-center gap-3 px-1.5 pb-0.5">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-fg">{tx('浏览器')}</span>
              <span className="block truncate text-[11px] text-muted">
                {openPage.isPending ? tx('正在启动…') : tx('未激活 · 点击打开')}
              </span>
            </div>
            <button
              type="button"
              onClick={activateDefaultBrowser}
              disabled={openPage.isPending}
              className={cx(
                'h-[30px] shrink-0 rounded-lg px-3 text-xs font-medium transition-transform duration-150',
                openPage.isPending
                  ? 'cursor-default bg-card text-muted'
                  : 'press bg-ink text-ink-fg active:scale-[0.96]',
              )}
            >
              {openPage.isPending ? tx('打开中…') : tx('打开')}
            </button>
          </div>
        </div>

        <form onSubmit={submitUrl} className="mt-3 flex h-9 items-center gap-2 rounded-xl bg-sunken px-3 focus-within:ring-1 focus-within:ring-line">
          <Globe size={14} className="shrink-0 text-faint" />
          <input
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            disabled={openPage.isPending}
            aria-label={tx('打开网页')}
            placeholder={tx('输入网址直接打开…')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint disabled:opacity-60"
          />
          {openPage.isPending
            ? <LoaderCircle size={13} className="shrink-0 animate-spin text-faint" />
            : <span aria-hidden className="shrink-0 text-xs text-faint">↵</span>}
        </form>
        {inlineError && <p className="mt-1.5 px-1 text-xs text-danger">{inlineError}</p>}
        {computer?.hasDesktop && (
          <button
            type="button"
            onClick={() => openCloudDesktopModal(computer.id)}
            disabled={openPage.isPending}
            className="mx-auto mt-3 flex items-center gap-1 text-xs text-muted transition-colors duration-150 hover:text-fg disabled:opacity-50"
          >
            {tx('打开云电脑桌面')}
            <ArrowUpRight size={12} />
          </button>
        )}
        {takeover && (
          <BrowserTakeoverModal
            targetKey={takeover.key}
            initialUrl={takeover.initialUrl}
            initialHasDesktop={takeover.initialHasDesktop}
            initialComputerId={takeover.initialComputerId}
            initialDesktopUrl={takeover.initialDesktopUrl}
            onClose={() => setTakeover(null)}
          />
        )}
      </div>
    )
  }

  // Board A1 & A2: Active state
  const activeTitle = cleanTitle(active)
  const activeDomain = domainOf(active.url)
  const showPagesList = pages.length > 1 || Boolean(computer?.hasDesktop)

  const openActiveTakeover = () => {
    setTakeover({
      key: active.key,
      initialUrl: active.url,
      initialHasDesktop: active.hasDesktop,
      initialComputerId: active.computerId,
    })
  }

  return (
    <div>
      {/* Concentric card: outer rounded-2xl (16px) = inner rounded-lg (8px) + p-2 (8px) */}
      <div className="rounded-2xl bg-sunken p-2">
        <button
          type="button"
          onClick={openActiveTakeover}
          aria-label={tx('接管 {0}', activeTitle)}
          className={cx(
            'relative block aspect-[16/10] w-full cursor-pointer overflow-hidden rounded-lg bg-card text-left',
            'after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:ring-1 after:ring-inset',
            dark ? 'after:ring-white/[0.10]' : 'after:ring-black/[0.08] dark:after:ring-white/[0.10]',
          )}
        >
          <LiveScreenshot
            srcBase={`/api/browsers/screenshot?key=${encodeURIComponent(active.key)}`}
            intervalMs={2_000}
            alt={activeTitle}
            className="block size-full object-cover object-top select-none"
          />
        </button>
        <div className="mt-2 flex items-center gap-3 px-1.5 pb-0.5">
          <div className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-fg">{activeTitle}</span>
            {activeDomain && <span className="block truncate text-[11px] text-muted">{activeDomain}</span>}
          </div>
          <button
            type="button"
            onClick={openActiveTakeover}
            className="press h-[30px] shrink-0 rounded-lg bg-ink px-3 text-xs font-medium text-ink-fg transition-transform duration-150 active:scale-[0.96]"
          >
            {tx('接管')}
          </button>
        </div>
      </div>

      {showPagesList && (
        <section className="mt-5">
          <div className="mb-2 flex items-baseline gap-1.5 text-xs">
            <span className="text-muted">{tx('打开的页面')}</span>
            <span className="text-faint tabular-nums">{pages.length}</span>
            <span className="flex-1" />
            {computer?.hasDesktop && (
              <button
                type="button"
                onClick={() => openCloudDesktopModal(computer.id)}
                className="text-xs text-muted transition-colors duration-150 hover:text-fg"
              >
                {tx('打开桌面')}
              </button>
            )}
          </div>
          <div className="space-y-0.5 rounded-2xl bg-sunken p-1.5">
            {pages.map(p => {
              const isCurrent = p.key === active.key
              return (
                <div
                  key={p.key}
                  className={cx(
                    'flex h-9 items-center rounded-[10px] pr-1.5 transition-colors duration-150',
                    isCurrent ? 'bg-card font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.06)]' : 'text-fg hover:bg-card/60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedKey(p.key)}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[10px] pr-1 pl-2.5 text-left"
                  >
                    <span className={cx('size-1.5 shrink-0 rounded-full', isCurrent && 'bg-fg')} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{cleanTitle(p)}</span>
                    <span className="shrink-0 text-xs font-normal text-faint">{domainOf(p.url)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); closePage.mutate(p.key) }}
                    disabled={closePage.isPending && closePage.variables === p.key}
                    aria-label={tx('关闭页面')}
                    title={tx('关闭页面')}
                    className="relative flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors duration-150 after:absolute after:-inset-1.5 hover:text-fg disabled:opacity-40"
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <form onSubmit={submitUrl} className="mt-3 flex h-9 items-center gap-2 rounded-xl bg-sunken px-3 focus-within:ring-1 focus-within:ring-line">
        <Globe size={14} className="shrink-0 text-faint" />
        <input
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          disabled={openPage.isPending}
          aria-label={tx('打开网页')}
          placeholder={tx('打开网页或提前登录账号…')}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint disabled:opacity-60"
        />
        {openPage.isPending
          ? <LoaderCircle size={13} className="shrink-0 animate-spin text-faint" />
          : <span aria-hidden className="shrink-0 text-xs text-faint">↵</span>}
      </form>
      {inlineError && <p className="mt-1.5 px-1 text-xs text-danger">{inlineError}</p>}

      {takeover && (
        <BrowserTakeoverModal
          targetKey={takeover.key}
          initialUrl={takeover.initialUrl}
          initialHasDesktop={takeover.initialHasDesktop}
          initialComputerId={takeover.initialComputerId}
          initialDesktopUrl={takeover.initialDesktopUrl}
          onClose={() => setTakeover(null)}
        />
      )}
    </div>
  )
}

// ── Board B: 60fps Live Interactive Stream Takeover Modal ────────────────────

export interface BrowserTakeoverModalProps {
  targetKey: string
  reason?: string
  initialUrl?: string
  initialHasDesktop?: boolean
  initialComputerId?: string
  initialMode?: 'page' | 'desktop'
  initialDesktopUrl?: string | null
  onClose(): void
}

export function BrowserTakeoverModal({
  targetKey,
  reason,
  initialUrl,
  initialHasDesktop,
  initialComputerId,
  initialMode,
  initialDesktopUrl,
  onClose,
}: BrowserTakeoverModalProps) {
  const qc = useQueryClient()
  const cached = qc.getQueryData<BrowsersOverview>(['browsers'])

  const [activeKey, setActiveKey] = useState(targetKey)
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey

  useEffect(() => {
    setActiveKey(targetKey)
    updateDraftDirty(false)
  }, [targetKey])

  const cachedPage = cached?.pages.find(p => p.key === activeKey) ?? cached?.pages.find(p => p.key === targetKey)
  const isDesktopRoot = activeKey.endsWith(':desktop:root')
  const isCloudKey = activeKey.startsWith('cloud:')
  const parsedComputerId = isCloudKey ? activeKey.split(':')[1] : undefined

  const initialPageUrl = initialUrl ?? cachedPage?.url ?? ''
  const isBlankInitial = !initialPageUrl || initialPageUrl === 'about:blank' || targetKey.endsWith(':desktop:root')

  const [leaving, setLeaving] = useState(false)
  const [currentUrl, setCurrentUrl] = useState(initialPageUrl)
  const currentUrlRef = useRef(currentUrl)
  currentUrlRef.current = currentUrl

  const [urlDraft, setUrlDraft] = useState(initialPageUrl === 'about:blank' ? '' : initialPageUrl)
  const [urlFocused, setUrlFocused] = useState(false)
  const urlFocusedRef = useRef(false)
  const [draftDirty, setDraftDirty] = useState(false)
  const draftDirtyRef = useRef(false)

  const updateUrlFocused = (v: boolean) => {
    urlFocusedRef.current = v
    setUrlFocused(v)
  }

  const updateDraftDirty = (v: boolean) => {
    draftDirtyRef.current = v
    setDraftDirty(v)
  }

  const [hasDesktop, setHasDesktop] = useState<boolean>(() =>
    Boolean(
      initialHasDesktop ??
      cachedPage?.hasDesktop ??
      (isCloudKey ? cached?.computer?.hasDesktop : false) ??
      (initialMode === 'desktop' || targetKey.endsWith(':desktop:root')),
    ),
  )
  const [computerId, setComputerId] = useState<string | undefined>(() =>
    initialComputerId ?? cachedPage?.computerId ?? parsedComputerId ?? (isCloudKey ? cached?.computer?.id : undefined),
  )
  const [desktopStreamUrl, setDesktopStreamUrl] = useState<string | null | undefined>(initialDesktopUrl)
  const [iframeKey, setIframeKey] = useState(0)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [ready, setReady] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [returning, setReturning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openerRef = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const returnedRef = useRef(false)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const viewportInputRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; button: number; detail: number } | null>(null)
  const wheelRef = useRef<{ dx: number; dy: number; timer: ReturnType<typeof setTimeout> | 0; lastAt: number }>({
    dx: 0,
    dy: 0,
    timer: 0,
    lastAt: 0,
  })

  // Auto-focus top address bar when opening a blank browser or desktop:root (Board B0).
  useEffect(() => {
    if (isBlankInitial) {
      urlInputRef.current?.focus({ preventScroll: true })
    }
  }, [])

  // Start handoff on open so 糯糯 pauses acting on this page (runs in parallel with requestCloudDesktop).
  useEffect(() => {
    let cancelled = false
    setError(null)
    api.post<BrowserHandoffResult>(
      '/browsers/handoff',
      { key: activeKey },
    ).then(res => {
      if (cancelled) return
      if (res.url) {
        setCurrentUrl(res.url)
        currentUrlRef.current = res.url
        if (!urlFocusedRef.current && !draftDirtyRef.current && document.activeElement !== urlInputRef.current) {
          setUrlDraft(res.url === 'about:blank' ? '' : res.url)
        }
      }
      if (res.hasDesktop !== undefined) setHasDesktop(Boolean(res.hasDesktop))
      if (res.computerId) setComputerId(res.computerId)
      setReady(true)
      setRefreshSeq(n => n + 1)
      void qc.invalidateQueries({ queryKey: ['browsers'] })
    }).catch(e => {
      if (cancelled) return
      if (activeKey.endsWith(':desktop:root')) {
        setReady(true)
      } else {
        setError((e as Error).message)
      }
    })
    return () => { cancelled = true }
  }, [activeKey, qc])

  // Request live 60fps WebSocket desktop stream URL in parallel whenever hasDesktop && computerId.
  useEffect(() => {
    if (!hasDesktop || !computerId || desktopStreamUrl !== undefined) return
    let cancelled = false
    requestCloudDesktop(computerId, false)
      .then(res => {
        if (cancelled) return
        setDesktopStreamUrl(res.url ?? null)
        void qc.invalidateQueries({ queryKey: ['computers'] })
      })
      .catch(() => {
        if (!cancelled) setDesktopStreamUrl(null)
      })
    return () => { cancelled = true }
  }, [hasDesktop, computerId, desktopStreamUrl, qc])

  const useStreamIframe = hasDesktop && Boolean(desktopStreamUrl)
  const connectingStream = hasDesktop && desktopStreamUrl === undefined

  // In fallback canvas mode only: focus hidden textarea when a non-blank URL is open and focus is not in urlInputRef.
  useEffect(() => {
    const hasRealUrl = Boolean(currentUrl && currentUrl !== 'about:blank')
    if (
      !useStreamIframe &&
      !hasDesktop &&
      hasRealUrl &&
      !urlFocusedRef.current &&
      !draftDirtyRef.current &&
      document.activeElement !== urlInputRef.current
    ) {
      viewportInputRef.current?.focus({ preventScroll: true })
    }
  }, [useStreamIframe, hasDesktop, ready, currentUrl])

  const finishClose = () => {
    const done = () => {
      onCloseRef.current()
      ;(openerRef.current as HTMLElement | null)?.focus?.()
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done()
      return
    }
    setLeaving(true)
    setTimeout(done, 150)
  }

  // Closing via × or backdrop: if opened ad-hoc from 浏览器 tab (no task NeedsYou reason), release handoff automatically.
  const dismissModal = () => {
    if (!returnedRef.current && !reason) {
      returnedRef.current = true
      void api.post('/browsers/return', { key: activeKeyRef.current })
        .catch(() => {})
        .finally(() => { void qc.invalidateQueries({ queryKey: ['browsers'] }) })
    }
    finishClose()
  }

  const handleReturn = async () => {
    if (returning) return
    setReturning(true)
    setError(null)
    try {
      returnedRef.current = true
      await api.post('/browsers/return', { key: activeKeyRef.current })
      void qc.invalidateQueries({ queryKey: ['browsers'] })
      void qc.invalidateQueries({ queryKey: ['tickets'] })
      finishClose()
    } catch (e) {
      returnedRef.current = false
      setError((e as Error).message)
      setReturning(false)
    }
  }

  // Escape closes the modal only when focus is outside the interactive page surface and URL bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.activeElement === viewportInputRef.current || document.activeElement === urlInputRef.current) return
      e.preventDefault()
      dismissModal()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [reason])

  // Cleanup pending wheel timer on unmount, and release ad-hoc handoff if unmounted abruptly.
  useEffect(() => {
    return () => {
      clearTimeout(wheelRef.current.timer)
      if (!returnedRef.current && !reason) {
        returnedRef.current = true
        void api.post('/browsers/return', { key: activeKeyRef.current }).catch(() => {})
      }
    }
  }, [reason])

  const sendAction = async (action: BrowserInputAction) => {
    try {
      setError(null)
      const res = await api.post<BrowserInputResult>(
        '/browsers/input',
        { key: activeKeyRef.current, mode: 'page', action },
      )
      if (res.key && res.key !== activeKeyRef.current) {
        activeKeyRef.current = res.key
        setActiveKey(res.key)
        updateDraftDirty(false)
      }
      if (res.url) {
        setCurrentUrl(res.url)
        currentUrlRef.current = res.url
        if (!urlFocusedRef.current && !draftDirtyRef.current && document.activeElement !== urlInputRef.current) {
          setUrlDraft(res.url === 'about:blank' ? '' : res.url)
        }
      }
      setRefreshSeq(n => n + 1)
      if (action.type === 'goto' || action.type === 'reload') {
        void qc.invalidateQueries({ queryKey: ['browsers'] })
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleReload = async () => {
    if (activeKeyRef.current.endsWith(':desktop:root')) {
      if (desktopStreamUrl) setIframeKey(k => k + 1)
      else setRefreshSeq(n => n + 1)
      return
    }
    setReloading(true)
    await sendAction({ type: 'reload' })
    setReloading(false)
    if (!useStreamIframe && !hasDesktop && document.activeElement !== urlInputRef.current) {
      viewportInputRef.current?.focus({ preventScroll: true })
    }
  }

  const handleGoto = (e: React.FormEvent) => {
    e.preventDefault()
    const next = normalizeUrl(urlDraft)
    if (!next) return
    setCurrentUrl(next)
    currentUrlRef.current = next
    setUrlDraft(next)
    updateDraftDirty(false)
    updateUrlFocused(false)
    urlInputRef.current?.blur()
    void sendAction({ type: 'goto', url: next })
    if (!useStreamIframe && !hasDesktop) {
      viewportInputRef.current?.focus({ preventScroll: true })
    }
  }

  const toCoords = (el: HTMLElement, clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(VIEWPORT_W, Math.round(((clientX - rect.left) / Math.max(1, rect.width)) * VIEWPORT_W)))
    const y = Math.max(0, Math.min(VIEWPORT_H, Math.round(((clientY - rect.top) / Math.max(1, rect.height)) * VIEWPORT_H)))
    return { x, y }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const { x, y } = toCoords(e.currentTarget, e.clientX, e.clientY)
    dragRef.current = { pointerId: e.pointerId, startX: x, startY: y, button: e.button, detail: e.detail }
    viewportInputRef.current?.focus({ preventScroll: true })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current
    if (!start || start.pointerId !== e.pointerId) return
    dragRef.current = null
    const { x, y } = toCoords(e.currentTarget, e.clientX, e.clientY)
    const moved = Math.hypot(x - start.startX, y - start.startY)
    if (moved > 8) {
      void sendAction({ type: 'drag', fromX: start.startX, fromY: start.startY, toX: x, toY: y })
    } else {
      const button = start.button === 2 ? 'right' : start.button === 1 ? 'middle' : 'left'
      void sendAction({
        type: 'click',
        x,
        y,
        button,
        ...(start.detail >= 2 ? { double: true } : {}),
      })
    }
    viewportInputRef.current?.focus({ preventScroll: true })
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }

  const flushWheel = () => {
    const w = wheelRef.current
    w.timer = 0
    const dy = Math.round(w.dy)
    const dx = Math.round(w.dx)
    w.dx = 0
    w.dy = 0
    w.lastAt = Date.now()
    if (dy !== 0 || dx !== 0) {
      void sendAction({ type: 'scroll', dy, ...(dx !== 0 ? { dx } : {}) })
    }
  }

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const w = wheelRef.current
    w.dx += e.deltaX
    w.dy += e.deltaY
    const elapsed = Date.now() - w.lastAt
    if (elapsed >= 120 && !w.timer) {
      flushWheel()
    } else if (!w.timer) {
      w.timer = setTimeout(flushWheel, Math.max(16, 120 - elapsed))
    }
  }

  const onViewportKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return

    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.altKey) {
      const lower = e.key.toLowerCase()
      // Let native paste fire onPaste cleanly without clipboard permission prompts.
      if (lower === 'v') return
      if (lower === 'a' || lower === 'z' || lower === 'x' || lower === 'c') {
        e.preventDefault()
        e.stopPropagation()
        const prefix = activeKeyRef.current.startsWith('cloud:') || !/Mac|iPhone|iPad/.test(navigator.platform) ? 'Control' : 'Meta'
        const chord = e.shiftKey ? `${prefix}+Shift+${lower.toUpperCase()}` : `${prefix}+${lower}`
        void sendAction({ type: 'key', key: chord })
        return
      }
    }

    const special = new Set([
      'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown',
    ])
    if (special.has(e.key)) {
      e.preventDefault()
      e.stopPropagation()
      const key = e.key === 'Tab' && e.shiftKey ? 'Shift+Tab' : e.key
      void sendAction({ type: 'key', key })
    }
  }

  const screenshotBase = isDesktopRoot && computerId
    ? `/api/computers/${encodeURIComponent(computerId)}/desktop/screenshot`
    : `/api/browsers/screenshot?key=${encodeURIComponent(activeKey)}`

  return (
    <div
      className={cx(
        'anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4 max-sm:p-0',
        leaving && 'out-fade',
      )}
      onMouseDown={e => { if (e.target === e.currentTarget) dismissModal() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tx('接管浏览器')}
        className={cx(
          'anim-pop flex max-h-[calc(100dvh-32px)] w-[min(780px,calc(100vw-32px))] flex-col overflow-hidden rounded-[20px] border border-line bg-panel shadow-2xl outline-none !duration-[180ms]',
          'max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]',
          leaving && 'out-pop',
        )}
      >
        {/* Single Unified 52px Header Bar */}
        <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-3.5">
          <button
            type="button"
            onClick={() => void handleReload()}
            aria-label={tx('刷新')}
            title={tx('刷新')}
            className="press flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-fg"
          >
            <RotateCw size={15} className={cx(reloading && 'animate-spin')} />
          </button>

          <form
            onSubmit={handleGoto}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-sunken px-3 focus-within:ring-1 focus-within:ring-line"
          >
            {currentUrl.startsWith('https://') && !urlFocused && !draftDirty
              ? <Lock size={13} className="shrink-0 text-faint" />
              : <Globe size={13} className="shrink-0 text-faint" />}
            <input
              ref={urlInputRef}
              autoFocus={isBlankInitial}
              value={(urlFocused || draftDirty) ? urlDraft : displayUrl(currentUrl)}
              onFocus={e => {
                if (!draftDirtyRef.current) {
                  setUrlDraft(currentUrlRef.current === 'about:blank' ? '' : currentUrlRef.current)
                }
                updateUrlFocused(true)
                const el = e.currentTarget
                if (!draftDirtyRef.current && el.value) {
                  requestAnimationFrame(() => {
                    if (!draftDirtyRef.current && document.activeElement === el) el.select()
                  })
                }
              }}
              onBlur={() => updateUrlFocused(false)}
              onChange={e => {
                updateDraftDirty(true)
                setUrlDraft(e.target.value)
              }}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  updateDraftDirty(false)
                  setUrlDraft(currentUrlRef.current === 'about:blank' ? '' : currentUrlRef.current)
                  e.currentTarget.blur()
                }
              }}
              placeholder={isDesktopRoot ? tx('输入网址在云电脑浏览器中打开…') : tx('输入网址或粘贴链接回车打开…')}
              aria-label={tx('网页地址')}
              className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
            />
            <span aria-hidden className="shrink-0 text-xs text-faint">↵</span>
            {desktopStreamUrl && (
              <>
                <span aria-hidden className="h-3 w-px shrink-0 bg-line" />
                <a
                  href={desktopStreamUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted transition-colors duration-150 hover:text-fg"
                >
                  {tx('新窗口')}
                  <ArrowUpRight size={11} />
                </a>
              </>
            )}
          </form>

          <button
            type="button"
            onClick={() => void handleReturn()}
            disabled={returning}
            className="press h-[30px] shrink-0 rounded-lg bg-ink px-3 text-xs font-medium text-ink-fg transition-transform duration-150 active:scale-[0.96] disabled:opacity-50"
          >
            {tx('交还给糯糯')}
          </button>

          <button
            type="button"
            onClick={dismissModal}
            aria-label={tx('关闭')}
            title={tx('关闭')}
            className="press flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-fg"
          >
            <X size={16} />
          </button>
        </header>

        {/* Direct-Manipulation 16:10 Viewport */}
        <div className="relative flex aspect-[16/10] min-h-0 w-full items-center justify-center overflow-hidden bg-sunken max-sm:flex-1 max-sm:aspect-auto">
          {useStreamIframe ? (
            <iframe
              key={iframeKey}
              src={desktopStreamUrl!}
              title={tx('云电脑桌面')}
              className="block size-full border-0"
              allow="clipboard-read; clipboard-write"
            />
          ) : connectingStream ? (
            <div className="flex size-full items-center justify-center gap-2 text-xs text-faint">
              <LoaderCircle size={15} className="animate-spin text-muted" />
              <span>{tx('正在连接实时画面…')}</span>
            </div>
          ) : (
            <div
              onContextMenu={e => e.preventDefault()}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onWheel={onWheel}
              className="relative aspect-[16/10] max-h-full w-full touch-none overflow-hidden bg-sunken outline-none select-none"
            >
              <textarea
                ref={viewportInputRef}
                aria-label={tx('网页键盘输入')}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                onCompositionStart={() => { composingRef.current = true }}
                onCompositionEnd={e => {
                  composingRef.current = false
                  const text = e.data || e.currentTarget.value
                  e.currentTarget.value = ''
                  if (text) void sendAction({ type: 'type', text })
                }}
                onChange={e => {
                  if (composingRef.current) return
                  const text = e.currentTarget.value
                  e.currentTarget.value = ''
                  if (text) void sendAction({ type: 'type', text })
                }}
                onPaste={e => {
                  e.preventDefault()
                  const text = e.clipboardData.getData('text/plain')
                  e.currentTarget.value = ''
                  if (text) void sendAction({ type: 'paste', text })
                }}
                onKeyDown={onViewportKeyDown}
                className="pointer-events-none absolute top-0 left-0 size-px text-base opacity-0"
              />
              {ready || isDesktopRoot ? (
                <LiveScreenshot
                  srcBase={screenshotBase}
                  intervalMs={800}
                  refreshKey={refreshSeq}
                  alt={isDesktopRoot ? tx('云电脑桌面') : tx('浏览器画面')}
                  emptyLabel={isDesktopRoot ? tx('正在连接桌面…') : tx('正在连接浏览器…')}
                  className="pointer-events-none block size-full object-fill select-none"
                />
              ) : (
                <div className="flex size-full items-center justify-center text-xs text-faint">
                  {error ?? tx('正在连接浏览器…')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Quiet 32px Bottom Status Strip */}
        <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-sunken/50 px-4 text-[11px] text-muted">
          <span
            aria-hidden
            className={cx('size-1.5 shrink-0 rounded-full', useStreamIframe ? 'bg-emerald-500' : 'bg-faint')}
          />
          <span className="min-w-0 flex-1 truncate">
            {reason || (useStreamIframe
              ? tx('实时交互连接 · 糯糯已暂停操作这一页，登录状态会自动留存')
              : tx('糯糯已暂停操作这一页 · 登录状态会自动留存'))}
          </span>
          {error && <span className="max-w-[45%] shrink-0 truncate text-danger">{error}</span>}
        </footer>
      </div>
    </div>
  )
}
