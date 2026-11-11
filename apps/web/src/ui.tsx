/** Small shared controls built on the theme tokens in index.css. */
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { locale, tx } from './i18n'

const cx = (...parts: (string | false | undefined | null)[]) => parts.filter(Boolean).join(' ')
export { cx }

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ink'
export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return <button {...props} className={cx(
    'press inline-flex items-center justify-center gap-1.5 rounded-full font-medium disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
    size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
    variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
    variant === 'ink' && 'bg-ink text-ink-fg hover:opacity-90',
    variant === 'secondary' && 'border border-line bg-panel hover:border-faint',
    variant === 'ghost' && 'hover:bg-sunken text-muted hover:text-fg',
    variant === 'danger' && 'border border-line bg-panel text-danger hover:border-danger',
    className)} />
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('h-10 w-full rounded-xl border border-line bg-panel px-3 text-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15 focus-visible:outline-none placeholder:text-faint', className)} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx('h-10 w-full rounded-xl border border-line bg-panel px-2.5 text-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15 focus-visible:outline-none', className)}>{children}</select>
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="block space-y-1.5" title={typeof hint === 'string' ? hint : undefined}>
    <span className="text-xs font-medium text-muted">{label}</span>
    {children}
  </label>
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
    tone === 'neutral' && 'bg-sunken text-muted', tone === 'ok' && 'bg-ok/10 text-ok', tone === 'warn' && 'bg-warn-soft text-warn',
    tone === 'danger' && 'bg-danger/10 text-danger', tone === 'accent' && 'bg-accent-soft text-accent')}>
    {tone !== 'neutral' && <span className="size-1.5 rounded-full bg-current" />}{children}
  </span>
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-[20px] border border-line bg-card', className)}>{children}</div>
}

export function Modal({ title, onClose: done, children, footer }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode }) {
  // Dismissing (Esc, the backdrop, ✕) shrinks the dialog away before it unmounts.
  const [leaving, setLeaving] = useState(false)
  const latest = useRef(done)
  latest.current = done
  const onClose = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return latest.current()
    setLeaving(true)
    setTimeout(() => latest.current(), 150)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  return <div className={cx('anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4', leaving && 'out-fade')} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div role="dialog" aria-modal="true" aria-label={title} className={cx('anim-pop w-full max-w-lg rounded-3xl border border-line bg-panel shadow-2xl', leaving && 'out-pop')}>
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        <IconButton label={tx('关闭')} onClick={onClose}><X size={18} /></IconButton>
      </div>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 pb-5">{children}</div>
      {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-3.5">{footer}</div>}
    </div>
  </div>
}

/** A round icon-only button; the label doubles as its tooltip and accessible name. */
export function IconButton({ label, onClick, children, className }: { label: string; onClick(): void; children: ReactNode; className?: string }) {
  return <button onClick={onClick} aria-label={label} title={label} className={cx('press inline-flex size-8 shrink-0 items-center justify-center rounded-full text-faint hover:bg-sunken hover:text-fg', className)}>{children}</button>
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="anim-rise flex flex-col items-center justify-center gap-2 py-14 text-center">
    {icon && <div className="mb-1 flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">{icon}</div>}
    <div className="font-display text-base font-semibold">{title}</div>
    {action && <div className="mt-2">{action}</div>}
  </div>
}

export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString(locale)
export const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`)

/** A clickable row in a settings list that opens the item's own page. */
export function ListRow({ href, icon, title, badge, detail, aside }: { href: string; icon?: ReactNode; title: ReactNode; badge?: ReactNode; detail?: ReactNode; aside?: ReactNode }) {
  return <a href={href} className="group flex items-center gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-sunken/60">
    {icon && <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sunken text-muted transition-colors duration-150 group-hover:bg-accent-soft group-hover:text-accent">{icon}</div>}
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{title}</span>{badge}</div>
      {detail && <div className="mt-0.5 truncate text-xs text-muted">{detail}</div>}
    </div>
    {aside && <div className="shrink-0 text-right text-xs text-faint tabular-nums">{aside}</div>}
    <ChevronRight size={16} className="shrink-0 text-faint transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
  </a>
}

/** Header of a settings item page, with a link back to its list. */
export function DetailHeader({ back, backLabel, icon, title, badge, children }: { back: string; backLabel: string; icon?: ReactNode; title: ReactNode; badge?: ReactNode; children?: ReactNode }) {
  return <header className="anim-rise space-y-3">
    <a href={back} className="inline-flex items-center gap-0.5 rounded-full py-1 pr-2.5 text-sm text-muted hover:text-fg"><ChevronLeft size={16} />{backLabel}</a>
    <div className="flex items-center gap-3">
      {icon && <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">{icon}</span>}
      <h2 className="font-display text-2xl font-semibold text-balance">{title}</h2>{badge}
    </div>
  </header>
}

/** A segmented control: a grey track with a white block that slides to the chosen option (equal-width options). */
export function Seg<T extends string>({ value, options, onChange, label, className }: { value: T; options: { id: T; label: ReactNode; dot?: boolean }[]; onChange(v: T): void; label: string; className?: string }) {
  const i = Math.max(0, options.findIndex(o => o.id === value))
  return <div role="radiogroup" aria-label={label} className={cx('relative flex rounded-full bg-sunken p-[3px]', className)}>
    <span aria-hidden className="seg-thumb absolute top-[3px] bottom-[3px] left-[3px] rounded-full bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_0.5px_rgb(0_0_0/0.04)]"
      style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${i * 100}%)` }} />
    {options.map(o => <button key={o.id} role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)}
      className={cx('relative z-10 flex h-7 flex-1 items-center justify-center rounded-full px-3 text-[13px] transition-colors duration-150', o.id === value ? 'font-medium text-fg' : 'text-muted hover:text-fg')}>
      {o.label}{o.dot && <span className="absolute top-1 right-[calc(50%-18px)] size-1.5 rounded-full bg-accent" />}
    </button>)}
  </div>
}
