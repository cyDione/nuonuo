import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cx } from '../ui'
import { tx } from '../i18n'

/**
 * A model id field with a real list: the arrow opens every model the provider offers (not only those matching what is
 * already typed, as a native datalist does), typing filters it, and the refresh button asks the provider again.
 * Any id can still be typed by hand.
 */
export function ModelPicker({ value, onChange, models, loading, error, onRefresh, placeholder = tx('模型 id'), tag, className }: {
  value: string; onChange(v: string): void; models: string[]; loading?: boolean; error?: string; onRefresh(): void
  placeholder?: string; tag?(model: string): string | undefined; className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  // Opened from the arrow: everything. While typing: what matches.
  const shown = useMemo(() => {
    const q = query?.trim().toLowerCase()
    return q ? models.filter(m => m.toLowerCase().includes(q)) : models
  }, [models, query])
  useEffect(() => { listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' }) }, [active])
  const pick = (m: string) => { onChange(m); setQuery(null); setOpen(false) }
  const show = (all: boolean) => { if (all) setQuery(null); setActive(Math.max(0, models.indexOf(value))); setOpen(true) }

  return <div ref={box} className={cx('relative', className)}>
    <div className="flex h-8 items-center rounded-xl border border-line bg-panel transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15">
      <input value={value} placeholder={placeholder} spellCheck={false} autoComplete="off" role="combobox" aria-expanded={open}
        className="h-full min-w-0 flex-1 bg-transparent pl-3 font-mono text-xs outline-none placeholder:font-sans placeholder:text-faint"
        onChange={e => { onChange(e.target.value); setQuery(e.target.value); setActive(0); setOpen(true) }}
        onFocus={() => show(true)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(true); else setActive(i => Math.min(i + 1, shown.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter' && open && shown[active]) { e.preventDefault(); pick(shown[active]!) }
          else if (e.key === 'Escape') setOpen(false)
        }} />
      <button type="button" aria-label={tx('展开模型列表')} onClick={() => (open ? setOpen(false) : show(true))}
        className="grid h-full w-7 place-items-center text-faint hover:text-fg">
        <ChevronDown size={14} className={cx('transition-transform duration-200', open && 'rotate-180')} />
      </button>
      <button type="button" aria-label={tx('重新拉取模型列表')} title={error ? tx('读取失败：{0}\n点击重试', error) : tx('重新拉取模型列表')} onClick={onRefresh} disabled={loading}
        className={cx('grid h-full w-7 place-items-center border-l border-line hover:text-fg', error ? 'text-danger' : 'text-faint')}>
        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
    {open && <div className="anim-menu absolute left-0 top-9 z-30 w-max min-w-full max-w-[min(28rem,85vw)] overflow-hidden rounded-xl border border-line bg-panel shadow-lg" style={{ transformOrigin: 'top' }}>
      {shown.length > 0 && <ul ref={listRef} role="listbox" className="max-h-64 overflow-y-auto py-1">
        {shown.map((m, i) => { const t = tag?.(m); return <li key={m} role="option" aria-selected={m === value}
          onPointerDown={e => { e.preventDefault(); pick(m) }} onPointerEnter={() => setActive(i)}
          className={cx('flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-xs', i === active && 'bg-sunken')}>
          <span className="min-w-0 flex-1 truncate">{m}</span>
          {t && <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-px font-sans text-[10px] text-accent">{t}</span>}
          {m === value && <Check size={12} className="shrink-0 text-accent" />}
        </li> })}
      </ul>}
      <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-faint">
        {loading ? tx('正在读取模型列表…')
          : error ? <span className="truncate text-danger" title={error}>{tx('未能读取模型列表：{0}', error)}</span>
          : shown.length === 0 ? (models.length ? tx('没有匹配的模型，可直接使用输入的 id') : tx('供应商没有返回模型，可直接输入 id'))
          : tx('{0} / {1} 个模型', shown.length, models.length)}
        <button type="button" onPointerDown={e => e.preventDefault()} onClick={onRefresh} disabled={loading} className="ml-auto shrink-0 text-accent hover:underline disabled:opacity-50">{tx('重新拉取')}</button>
      </div>
    </div>}
  </div>
}
