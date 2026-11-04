/** Small shared controls built on the theme tokens in index.css. */
import { X } from 'lucide-react'
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'

const cx = (...parts: (string | false | undefined | null)[]) => parts.filter(Boolean).join(' ')
export { cx }

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return <button {...props} className={cx(
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
    variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
    variant === 'secondary' && 'border border-line bg-panel hover:bg-sunken',
    variant === 'ghost' && 'hover:bg-sunken text-muted hover:text-fg',
    variant === 'danger' && 'border border-line bg-panel text-danger hover:bg-sunken',
    className)} />
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('h-9 w-full rounded-lg border border-line bg-panel px-3 text-sm outline-none focus:border-accent placeholder:text-faint', className)} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx('h-9 w-full rounded-lg border border-line bg-panel px-2.5 text-sm outline-none focus:border-accent', className)}>{children}</select>
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="block space-y-1.5">
    <span className="text-xs font-medium text-muted">{label}</span>
    {children}
    {hint && <span className="block text-xs text-faint">{hint}</span>}
  </label>
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
    tone === 'neutral' && 'bg-sunken text-muted', tone === 'ok' && 'bg-sunken text-ok', tone === 'warn' && 'bg-sunken text-warn',
    tone === 'danger' && 'bg-sunken text-danger', tone === 'accent' && 'bg-accent-soft text-accent')}>{children}</span>
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-xl border border-line bg-panel', className)}>{children}</div>
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="w-full max-w-lg rounded-2xl border border-line bg-panel shadow-xl">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">{title}</h2>
        <button onClick={onClose} className="text-faint hover:text-fg" aria-label="关闭"><X size={18} /></button>
      </div>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
    </div>
  </div>
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
    {icon && <div className="text-faint">{icon}</div>}
    <div className="font-medium">{title}</div>
    {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
  </div>
}

export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString('zh-CN')
export const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`)
