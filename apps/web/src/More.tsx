/**
 * 更多 (Figma v6.4, section 22): the button at the bottom left of the sidebar. It opens upward into the pages that used to
 * be tabs across the top (动态 · 点子 · 目标 · 成果) and 设置. 聊天 is not here: the sidebar's 主聊 is the way back.
 * The page you are on is marked the same way as a selected chat in the sidebar.
 */
import { Root as Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@animate-ui/react/primitives/radix-ui/popover'
import { useQuery } from '@tanstack/react-query'
import { Lightbulb, LayoutGrid, Newspaper, Package, Settings, Target, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type UpdateStatus } from './api'
import { useFeed } from './Activity'
import { useIdeas } from './ideas'
import { getPrefs, keyLabel, matchesKey, MOD, usePrefs } from './prefs'
import { go, type Route } from './route'
import { cx } from './ui'
import { tx } from './i18n'

/** ⌘, opens the full settings from anywhere. */
export function useSettingsShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesKey(e, getPrefs().keys.settings)) { e.preventDefault(); go('/settings/persona') }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
}

type Page = 'activity' | 'ideas' | 'goals' | 'library'
const PAGES: { id: Page; label: string; icon: LucideIcon; path: string }[] = [
  { id: 'activity', label: tx('动态'), icon: Newspaper, path: '/activity' },
  { id: 'ideas', label: tx('点子'), icon: Lightbulb, path: '/ideas' },
  { id: 'goals', label: tx('目标'), icon: Target, path: '/goals' },
  { id: 'library', label: tx('成果'), icon: Package, path: '/library' },
]

export function More({ route }: { route: Route }) {
  const [open, setOpen] = useState(false)
  const prefs = usePrefs()
  // Only what is new on these pages. 等你点头 is not here: it lives in its chat's card and on top of the right pane's 活动.
  const fresh = useFeed().data?.unseen ?? 0
  const batch = useIdeas().data?.batch
  const freshIdeas = !!batch && !batch.seen && batch.cards.some(c => !c.dismissed && !c.done)
  const update = useQuery({ queryKey: ['update'], queryFn: () => api.get<UpdateStatus>('/update'), refetchInterval: 30 * 60_000, retry: false }).data
  const current = PAGES.find(p => p.id === route.page)?.id
  const news: Partial<Record<Page, string>> = {
    ...(fresh > 0 && current !== 'activity' ? { activity: tx('{0} 条新的', fresh) } : {}),
    ...(freshIdeas && current !== 'ideas' ? { ideas: tx('今天一批') } : {}),
  }
  const dot = Object.keys(news).length > 0 || !!update?.available
  const list = useRef<HTMLDivElement>(null)
  const pick = (path: string) => { setOpen(false); go(path) }
  // ↑ ↓ move between the rows; Enter opens one (they are buttons).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-row]') ?? [])]
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
  }
  const shortcut = prefs.keys.settings ? keyLabel(prefs.keys.settings).join(MOD === 'Ctrl' ? '+' : '') : ''
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger aria-label={tx('更多页面和设置')} className={cx('press flex h-8 items-center gap-1.5 rounded-[10px] pr-2.5 pl-2 text-[13px] transition-colors duration-150',
      current ? 'bg-accent-soft font-medium text-accent' : open ? 'bg-sunken text-fg' : 'text-fg hover:bg-sunken')}>
      <span className="relative">
        <LayoutGrid size={16} />
        {dot && !current && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent ring-[1.5px] ring-bg" aria-label={tx('有新的')} />}
      </span> {tx('更多')} </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={12} transition={{ type: 'spring', stiffness: 520, damping: 38 }}
        onOpenAutoFocus={e => { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>('[data-row]')?.focus() }}
        className="z-50 w-[216px] rounded-2xl border border-line bg-panel p-1.5 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.22)] outline-none">
        <div ref={list} onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
          {PAGES.map(p => <Row key={p.id} icon={p.icon} label={p.label} on={p.id === current} meta={news[p.id]} dot={!!news[p.id]} onClick={() => pick(p.path)} />)}
          <div className="mx-1 my-1 h-px bg-line" />
          <Row icon={Settings} label={tx('设置')} meta={update?.available ? tx('有新版本') : shortcut} dot={!!update?.available}
            onClick={() => pick(update?.available ? '/settings/system' : '/settings/persona')} />
        </div>
      </PopoverContent>
    </PopoverPortal>
  </Popover>
}

function Row({ icon: Icon, label, on, meta, dot, onClick }: { icon: LucideIcon; label: string; on?: boolean; meta?: string; dot?: boolean; onClick(): void }) {
  return <button type="button" data-row onClick={onClick} aria-current={on ? 'page' : undefined}
    className={cx('flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] outline-none transition-colors duration-150',
      on ? 'bg-accent-soft font-medium text-accent' : 'text-fg hover:bg-sunken focus-visible:bg-sunken')}>
    <Icon size={16} className={on ? '' : 'text-muted'} />
    <span className="flex-1">{label}</span>
    {meta && <span className="flex items-center gap-1.5 text-[11px] font-normal text-faint">{dot && <span className="size-1.5 rounded-full bg-accent" />}{meta}</span>}
  </button>
}
