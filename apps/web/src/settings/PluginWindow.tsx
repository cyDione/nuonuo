/**
 * 插件窗口 (Figma 30): what 「打开」 on a plugin's row opens. Up to two pages: the plugin's own page (package.json
 * `nuonuo.window`), shown in a sandboxed frame that can only reach the plugin through `nuonuo.call`, and 设置, generated
 * from the fields the plugin declares (`nuonuo.settings`). The plugin's settings are changed only here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Power, Puzzle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type FieldSpec, type PluginInfo, type PluginWindow as WindowInfo } from '../api'
import { tx } from '../i18n'
import { cx, Seg } from '../ui'
import { SaveBar } from './kit'
import { FieldRow } from './Sources'

type Tab = 'page' | 'settings'

/** Whether the app is showing its dark theme right now. */
const isDark = () => {
  const set = document.documentElement.dataset.theme
  return set === 'dark' || (set !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
}

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(isDark() ? 'dark' : 'light')
  useEffect(() => {
    const update = () => setTheme(isDark() ? 'dark' : 'light')
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    return () => { mo.disconnect(); mq.removeEventListener('change', update) }
  }, [])
  return theme
}

export function PluginWindow({ plugin, onClose, onEnable }: { plugin: PluginInfo; onClose(): void; onEnable(): void }) {
  const tabs: Tab[] = [...(plugin.window ? ['page' as const] : []), ...(plugin.settings?.length ? ['settings' as const] : [])]
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'settings')
  const [leaving, setLeaving] = useState(false)
  const dirty = useRef(false)
  const opener = useRef<Element | null>(document.activeElement)
  const box = useRef<HTMLDivElement>(null)
  const latest = useRef(onClose)
  latest.current = onClose
  const close = () => {
    if (dirty.current && !confirm(tx('改的还没保存，确定关掉？'))) return
    const done = () => { latest.current(); (opener.current as HTMLElement | null)?.focus?.() }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return done()
    setLeaving(true)
    setTimeout(done, 120)
  }
  useEffect(() => {
    box.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  const win = plugin.window
  const size = win
    ? { width: `min(${win.width}px, calc(100vw - 32px))`, height: `min(${win.height + 53}px, 88dvh)` }
    : { width: 'min(440px, calc(100vw - 32px))' }
  const pageLabel = win?.title ?? plugin.name
  return <div className={cx('anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4 max-sm:p-0', leaving && 'out-fade')}
    onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={plugin.name} style={size}
      className={cx('anim-pop flex max-h-[88dvh] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl outline-none max-sm:!h-dvh max-sm:max-h-none max-sm:!w-full max-sm:rounded-none max-sm:border-0', leaving && 'out-pop')}>
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pr-2.5 pl-4">
        <Puzzle size={16} className="shrink-0" />
        <h2 className="truncate text-sm font-medium">{plugin.name}</h2>
        {tabs.length > 1
          ? <Seg label={tx('窗口里的页')} value={tab} onChange={v => setTab(v as Tab)} options={[{ id: 'page', label: pageLabel }, { id: 'settings', label: tx('设置') }]} className="ml-1 [&_button]:h-7 [&_button]:px-3 [&_button]:text-xs" />
          : tab === 'settings' && <span className="text-sm text-muted">· {tx('设置')}</span>}
        <span className="flex-1" />
        <button type="button" onClick={close} aria-label={tx('关闭')} title={tx('关闭')}
          className="press flex size-8 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-fg"><X size={16} /></button>
      </header>
      {!plugin.enabled && <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-sunken py-2.5 pr-3 pl-4">
        <Power size={14} className="shrink-0 text-muted" />
        <p className="min-w-0 flex-1 text-xs text-muted">{tx('插件没开，页面能看，但里面的操作要打开后才能用')}</p>
        <button type="button" onClick={onEnable} className="press h-7 shrink-0 rounded-lg bg-ink px-2.5 text-xs font-medium text-ink-fg">{tx('打开插件')}</button>
      </div>}
      {win && <PluginPage plugin={plugin} win={win} hidden={tab !== 'page'} onClose={close} />}
      {tab === 'settings' && <PluginSettings id={plugin.id} onDirty={d => { dirty.current = d }} />}
    </div>
  </div>
}

/** The plugin's own page, kept mounted while 设置 is showing so it keeps its state. */
function PluginPage({ plugin, win, hidden, onClose }: { plugin: PluginInfo; win: WindowInfo; hidden: boolean; onClose(): void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const theme = useTheme()
  const url = useQuery({ queryKey: ['plugin-window', plugin.id], queryFn: () => api.get<{ window: WindowInfo & { url: string } }>(`/plugins/${plugin.id}/window`), staleTime: Infinity }).data?.window.url
  const [src, setSrc] = useState<string>()
  useEffect(() => { if (url && !src) setSrc(`${url}?theme=${theme}`) }, [url])
  useEffect(() => { frame.current?.contentWindow?.postMessage({ nuonuo: 'answer', type: 'theme', theme }, '*') }, [theme])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const target = frame.current?.contentWindow
      const m = e.data as { nuonuo?: string; type?: string; id?: number; name?: string; input?: unknown } | null
      if (!target || e.source !== target || m?.nuonuo !== 'ask') return
      if (m.type === 'close') { closeRef.current(); return }
      if (m.type !== 'call' || typeof m.id !== 'number' || typeof m.name !== 'string') return
      try {
        const { value } = await api.post<{ value: unknown }>(`/plugins/${plugin.id}/call`, { name: m.name, input: m.input ?? null })
        target.postMessage({ nuonuo: 'answer', id: m.id, value }, '*')
      } catch (error) {
        target.postMessage({ nuonuo: 'answer', id: m.id, error: (error as Error).message || tx('出错了') }, '*')
      }
    }
    addEventListener('message', onMessage)
    return () => removeEventListener('message', onMessage)
  }, [plugin.id])
  return <div className={cx('min-h-0 flex-1', hidden && 'hidden')}>
    {src && <iframe ref={frame} src={src} title={win.title ?? plugin.name} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer"
      className="block size-full border-0 bg-panel" />}
  </div>
}

function PluginSettings({ id, onDirty }: { id: string; onDirty(dirty: boolean): void }) {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['plugin-settings', id], queryFn: () => api.get<{ fields: FieldSpec[]; values: Record<string, unknown> }>(`/plugins/${id}/settings`) }).data
  const [values, setValues] = useState<Record<string, unknown>>()
  useEffect(() => { if (data) setValues(data.values) }, [JSON.stringify(data?.values)])
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.put<{ fields: FieldSpec[]; values: Record<string, unknown> }>(`/plugins/${id}/settings`, { values: v }),
    onSuccess: next => qc.setQueryData(['plugin-settings', id], next),
  })
  const changed = data && values ? data.fields.filter(f => JSON.stringify(values[f.key]) !== JSON.stringify(data.values[f.key])).length : 0
  useEffect(() => onDirty(changed > 0), [changed])
  if (!data || !values) return <div className="flex-1 p-4" />
  const fields = [...data.fields.filter(f => !f.advanced), ...data.fields.filter(f => f.advanced)]
  return <>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="divide-y divide-line rounded-xl bg-card px-4">
        {fields.map(f => <FieldRow key={f.key} f={f} value={values[f.key]} onChange={v => setValues(s => ({ ...s, [f.key]: v }))} />)}
      </div>
      <p className="mt-2 px-1 text-xs leading-5 text-faint">{tx('这些设置由插件声明，存在本机；密钥类的放进钥匙串。')}</p>
    </div>
    {(changed > 0 || save.error) && <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
      {changed > 0 && !save.error && <span className="mr-auto text-xs text-muted">{tx('改了 {0} 项', changed)}</span>}
      <div className="flex-1"><SaveBar dirty={changed > 0} pending={save.isPending} error={save.error} onReset={() => setValues(data.values)} onSave={() => save.mutate(values)} /></div>
    </div>}
  </>
}
