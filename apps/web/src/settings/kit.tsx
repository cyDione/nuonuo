/**
 * The settings pages' controls (Figma v6, section 21): a page title, captions over grey groups of rows (label and note on
 * the left, the control on the right), small white inputs and buttons, and faint footnotes. Nothing here moves: the whole
 * settings window sits in `.settings-static`.
 */
import { ChevronRight } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cx } from '../ui'
import { tx } from '../i18n'

export function Page({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <div className="space-y-6">
    <div className="flex min-h-9 items-center gap-3">
      <h1 className="min-w-0 flex-1 text-[26px] leading-tight font-semibold">{title}</h1>
      {action}
    </div>
    {children}
  </div>
}

/** A caption, a grey group of rows, and an optional footnote under it. */
export function Section({ title, foot, children, className }: { title?: ReactNode; foot?: ReactNode; children: ReactNode; className?: string }) {
  return <section>
    {title && <h2 className="mb-2 text-[13px] text-muted">{title}</h2>}
    <div className={cx('rounded-2xl bg-sunken px-4 [&>*+*]:border-t [&>*+*]:border-line', className)}>{children}</div>
    {foot && <Foot>{foot}</Foot>}
  </section>
}

export const Foot = ({ children }: { children: ReactNode }) => <p className="mt-2 px-1 text-xs leading-5 text-faint">{children}</p>

/** One row: what it is (and a line on what it does) on the left, the control on the right. With `href`/`onClick` it opens something. */
export function Row({ label, sub, children, href, onClick, icon, top, className }: {
  label: ReactNode; sub?: ReactNode; children?: ReactNode; href?: string; onClick?(): void; icon?: ReactNode; top?: boolean; className?: string
}) {
  const body = <>
    {icon && <span className="flex size-5 shrink-0 items-center justify-center text-fg">{icon}</span>}
    <span className="min-w-0 flex-1">
      <span className="block text-sm">{label}</span>
      {sub && <span className="mt-0.5 block text-xs text-muted">{sub}</span>}
    </span>
    {children != null && <span className="flex shrink-0 items-center gap-2">{children}</span>}
    {(href || onClick) && <ChevronRight size={16} className="shrink-0 text-faint" />}
  </>
  const cls = cx('flex min-h-[52px] w-full gap-3 py-2.5 text-left', top ? 'items-start' : 'items-center', className)
  if (href) return <a href={href} className={cx(cls, 'hover:opacity-80')}>{body}</a>
  if (onClick) return <button type="button" onClick={onClick} className={cx(cls, 'hover:opacity-80')}>{body}</button>
  return <div className={cls}>{body}</div>
}

/** A block inside a group that is not a row: a textarea with its label, a list, an editor. */
export const Block = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cx('py-3', className)}>{children}</div>

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
    data-state={checked ? 'checked' : 'unchecked'} className="toggle disabled:opacity-50"><span /></button>
}

/** Two or three choices side by side: a grey track, the chosen one white. */
export function Choice<T extends string>({ value, options, onChange, label, className }: { value: T; options: { id: T; label: ReactNode }[]; onChange(v: T): void; label: string; className?: string }) {
  return <div role="radiogroup" aria-label={label} className={cx('flex rounded-[10px] bg-hero-2 p-[3px]', className)}>
    {options.map(o => <button key={o.id} type="button" role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)}
      className={cx('h-[26px] min-w-[72px] flex-1 rounded-[8px] px-3 text-[13px] whitespace-nowrap', o.id === value ? 'bg-card font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-muted hover:text-fg')}>{o.label}</button>)}
  </div>
}

const field = 'rounded-[8px] border border-line bg-card px-2.5 text-[13px] outline-none focus:border-accent placeholder:text-faint disabled:opacity-60'
export const TextInput = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(field, 'h-[30px] w-[220px] max-w-full', className)} />
export const NumberInput = ({ className, suffix, ...p }: InputHTMLAttributes<HTMLInputElement> & { suffix?: string }) =>
  <span className={cx('flex h-[30px] w-[80px] items-center', field, 'px-0', className)}>
    <input type="number" {...p} className="h-full w-full min-w-0 bg-transparent px-2.5 text-[13px] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
    {suffix && <span className="shrink-0 pr-2.5 text-[13px] text-muted">{suffix}</span>}
  </span>
export const SelectInput = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) =>
  <select {...p} className={cx(field, 'h-[30px] w-[140px] pr-7', className)}>{children}</select>
export const Area = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) =>
  <textarea {...p} className={cx(field, 'block min-h-[72px] w-full px-3 py-2 text-[13px] leading-6', className)} />

export function Btn({ tone = 'plain', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'plain' | 'ink' | 'danger' }) {
  return <button type="button" {...p} className={cx('inline-flex h-[28px] shrink-0 items-center justify-center gap-1 rounded-[8px] px-3 text-[13px] font-medium whitespace-nowrap disabled:opacity-50',
    tone === 'ink' ? 'bg-ink text-ink-fg hover:opacity-90' : 'border border-line bg-card hover:border-faint', tone === 'danger' && 'text-danger', className)} />
}

/** A status: 运行中 / 已连接 (green), 出错 / 加载失败 (red), or neutral. */
export function Pill({ tone = 'neutral', children }: { tone?: 'ok' | 'danger' | 'neutral' | 'warn'; children: ReactNode }) {
  return <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-2 text-xs whitespace-nowrap">
    {tone !== 'neutral' && <span className={cx('size-1.5 rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : 'bg-danger')} />}
    <span className={cx(tone === 'danger' ? 'text-danger' : tone === 'neutral' ? 'text-muted' : 'text-fg')}>{children}</span>
  </span>
}

/** Keys shown as small boxes: ⌘ K. */
export const Keys = ({ keys, onClick, active, label }: { keys: string[]; onClick?(): void; active?: boolean; label?: string }) =>
  <button type="button" onClick={onClick} aria-label={label} disabled={!onClick}
    className={cx('flex min-h-[26px] items-center gap-1 rounded-[8px] px-1 disabled:cursor-default', active && 'ring-2 ring-accent')}>
    {active ? <span className="px-2 text-xs text-muted">{tx('按下新的组合键…')}</span>
      : keys.length ? keys.map((k, i) => <kbd key={i} className="flex h-[24px] min-w-[24px] items-center justify-center rounded-[6px] border border-line bg-card px-1.5 font-sans text-xs">{k}</kbd>)
      : <span className="px-2 text-xs text-faint">{tx('未设置')}</span>}
  </button>

/** Unsaved changes: 还原 and 保存 at the end of a page, with the error if saving failed. */
export function SaveBar({ dirty, pending, error, onReset, onSave, label = tx('保存'), extra }: { dirty: boolean; pending?: boolean; error?: unknown; onReset(): void; onSave(): void; label?: string; extra?: ReactNode }) {
  if (!dirty && !error && !extra) return null
  return <div className="flex flex-wrap items-center justify-end gap-2">
    {Boolean(error) && <span className="mr-auto text-xs text-danger">{(error as Error).message}</span>}
    {extra}
    {dirty && <><Btn onClick={onReset}>{tx('还原')}</Btn><Btn tone="ink" onClick={onSave} disabled={pending}>{label}</Btn></>}
  </div>
}

export function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl bg-sunken px-4 py-3.5"><div className="text-xs text-muted">{label}</div><div className="mt-1.5 text-[26px] leading-none font-semibold tabular-nums">{value}</div></div>
}
