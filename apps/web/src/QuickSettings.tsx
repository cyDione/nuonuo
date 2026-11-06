/**
 * The quick-settings popover (Figma section 20, 106:1125): grows up from the sliders button at the bottom left of the
 * sidebar. It holds what people change often (look, theme colour, how proactive 糯糯 is, raw records); everything else is
 * one click away in 全部设置 (⌘,). Each of these lives only here, never again in the settings pages.
 */
import { Root as Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@animate-ui/react/primitives/radix-ui/popover'
import { Root as Switch, SwitchThumb } from '@animate-ui/react/primitives/radix-ui/switch'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ProactiveSettings, type UpdateStatus } from './api'
import { ACCENTS, setPrefs, usePrefs, type Theme } from './prefs'
import { go } from './route'
import { cx, Seg } from './ui'

const THEMES: { id: Theme; label: string }[] = [{ id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }, { id: 'system', label: '跟随系统' }]
const MODES: { id: ProactiveSettings['mode']; label: string }[] = [{ id: 'off', label: '关' }, { id: 'observe', label: '只留意' }, { id: 'auto', label: '主动去做' }]

/** ⌘, opens the full settings from anywhere. */
export function useSettingsShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ',') { e.preventDefault(); go('/settings/persona') }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
}

export function QuickSettings() {
  const [open, setOpen] = useState(false)
  const update = useQuery({ queryKey: ['update'], queryFn: () => api.get<UpdateStatus>('/update'), refetchInterval: 30 * 60_000, retry: false })
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger aria-label="设置" title="设置" className={cx('press relative flex size-8 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-fg', open && 'bg-sunken text-fg')}>
      <SlidersHorizontal size={16} />
      {update.data?.available && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" aria-label="有更新" />}
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent side="top" align="start" sideOffset={10} collisionPadding={12} transition={{ type: 'spring', stiffness: 520, damping: 38 }}
        className="z-50 w-[340px] max-w-[calc(100vw-24px)] rounded-[20px] border border-line bg-panel shadow-[0_18px_50px_-12px_rgb(0_0_0/0.22)] outline-none">
        <Body update={update.data?.available ? update.data.latest?.tag ?? '新版本' : null} onDone={() => setOpen(false)} />
      </PopoverContent>
    </PopoverPortal>
  </Popover>
}

function Body({ update, onDone }: { update: string | null; onDone(): void }) {
  const qc = useQueryClient()
  const prefs = usePrefs()
  const proactive = useQuery({ queryKey: ['proactive'], queryFn: () => api.get<{ settings: ProactiveSettings; defaults: ProactiveSettings }>('/settings/proactive') }).data?.settings
  const setMode = useMutation({
    mutationFn: (mode: ProactiveSettings['mode']) => api.put('/settings/proactive', { ...proactive!, mode }),
    onMutate: mode => { qc.setQueryData<{ settings: ProactiveSettings }>(['proactive'], old => old && { ...old, settings: { ...old.settings, mode } }) },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['proactive'] }); qc.invalidateQueries({ queryKey: ['activity'] }) },
  })
  const all = (path: string) => { onDone(); go(path) }
  return <div>
    <div className="space-y-4 px-5 pt-5 pb-4">
      <h2 className="text-[17px] font-semibold">设置</h2>
      <Section title="外观"><Seg label="外观" value={prefs.theme} options={THEMES} onChange={theme => setPrefs({ theme })} /></Section>
      <Section title="主题色">
        <div role="radiogroup" aria-label="主题色" className="flex justify-between">
          {ACCENTS.map(a => { const on = prefs.accent === a.id
            return <button key={a.id} role="radio" aria-checked={on} onClick={() => setPrefs({ accent: a.id })} className="group flex w-10 flex-col items-center gap-1.5">
              <span className={cx('press flex size-[30px] items-center justify-center rounded-full ring-offset-2 ring-offset-panel transition-[box-shadow] duration-150', on ? 'ring-2' : 'group-hover:ring-2 group-hover:ring-line')}
                style={{ background: a.color, ...(on ? { ['--tw-ring-color' as string]: a.color } : {}) }}>
                {on && <Check size={15} strokeWidth={2.6} className="text-white" />}
              </span>
              <span className={cx('text-[11px]', on ? 'font-medium text-fg' : 'text-muted')}>{a.label}</span>
            </button> })}
        </div>
      </Section>
      {proactive && <Section title="主动程度"><Seg label="主动程度" value={proactive.mode} options={MODES} onChange={m => setMode.mutate(m)} /></Section>}
      <label className="flex cursor-pointer items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm">显示原始记录</span>
          <span className="block text-xs text-muted">给技术用户，看它每一步调了什么</span>
        </span>
        <Switch checked={prefs.showRaw} onCheckedChange={showRaw => setPrefs({ showRaw })} aria-label="显示原始记录" className="toggle"><SwitchThumb /></Switch>
      </label>
    </div>
    {update && <button onClick={() => all('/settings/system')} className="flex w-full items-center gap-2 border-t border-line px-5 py-3 text-left text-sm hover:bg-sunken/60">
      <span className="size-1.5 shrink-0 rounded-full bg-accent" /><span className="flex-1">{update} 可以更新了</span><ChevronRight size={15} className="text-faint" />
    </button>}
    <button onClick={() => all('/settings/persona')} className="group flex w-full items-center gap-2 rounded-b-[20px] border-t border-line px-5 py-3.5 text-left hover:bg-sunken/60">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">全部设置…</span>
        <span className="mt-0.5 block text-xs text-muted">主动、来源、模型、审核都在这里 · ⌘,</span>
      </span>
      <ChevronRight size={15} className="text-faint transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
    </button>
  </div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="space-y-2"><div className="text-xs text-muted">{title}</div>{children}</div>
}
