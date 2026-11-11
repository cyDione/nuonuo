/**
 * 灵魂 and 记忆 in the right pane's 它是谁 (Figma section 24, 166:1136): two liquid buttons side by side, each opening a
 * sheet that shows its Markdown rendered, with 编辑 to change it in place.
 *
 * Colours: every time 它是谁 opens, a start hue H is picked at random. 灵魂 flows H → H+28°, 记忆 H+28° → H+56°, so the
 * two buttons read as one band. Only neighbouring hues meet, so nothing clashes; hues 70°–110° (yellow, where white text
 * cannot be read) are never used. The sheet's header carries on the button's pair.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Brain, History, ScrollText, X } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type InstructionsState } from './api'
import { cx, Seg } from './ui'
import { tx } from './i18n'

export type Pair = [number, number]
const YELLOW = (h: number) => { const x = ((h % 360) + 360) % 360; return x >= 70 && x <= 110 }

/** A random start hue whose three stops all stay out of the yellow band. */
export function pickHues(rand = Math.random): { soul: Pair; memory: Pair } {
  let h = 0
  for (let i = 0; i < 50; i++) { h = Math.floor(rand() * 360); if (![h, h + 28, h + 56].some(YELLOW)) break }
  const n = (x: number) => x % 360
  return { soul: [n(h), n(h + 28)], memory: [n(h + 28), n(h + 56)] }
}

const liquid = ([a, b]: Pair): CSSProperties => ({ ['--l1' as string]: `oklch(0.66 0.135 ${a})`, ['--l2' as string]: `oklch(0.66 0.135 ${b})` })

export function LiquidButton({ hues, icon, title, sub, onClick }: { hues: Pair; icon: ReactNode; title: string; sub: string; onClick(): void }) {
  return <button type="button" onClick={onClick} style={liquid(hues)} aria-label={`${title}，${sub}`}
    className="liquid press flex h-28 flex-1 flex-col rounded-[18px] p-3.5 text-left">
    <span className="flex w-full items-start justify-between">{icon}<ArrowUpRight size={15} className="opacity-80" /></span>
    <span className="flex-1" />
    <span className="text-lg leading-tight font-semibold">{title}</span>
    <span className="mt-0.5 text-xs opacity-85 tabular-nums">{sub}</span>
  </button>
}

type Mode = 'preview' | 'edit'

/** The sheet both buttons open: a liquid header in the button's colours, 预览 / 编辑, the body, and 保存 while editing. */
function Sheet({ hues, icon, title, sub, mode, onMode, actions, onClose, dirty, footer, children }: {
  hues: Pair; icon: ReactNode; title: string; sub: string; mode: Mode; onMode(m: Mode): void; actions?: ReactNode; onClose(): void; dirty: boolean; footer?: ReactNode; children: ReactNode
}) {
  const [leaving, setLeaving] = useState(false)
  const latest = useRef({ onClose, dirty })
  latest.current = { onClose, dirty }
  const close = () => {
    if (latest.current.dirty && !confirm(tx('改的还没保存，确定关掉？'))) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return latest.current.onClose()
    setLeaving(true)
    setTimeout(() => latest.current.onClose(), 150)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  return <div className={cx('anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4', leaving && 'out-fade')} onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div role="dialog" aria-modal="true" aria-label={title} className={cx('anim-pop flex h-[min(720px,88dvh)] w-full max-w-[600px] flex-col overflow-hidden rounded-[20px] border border-line bg-panel shadow-2xl', leaving && 'out-pop')}>
      <header style={liquid(hues)} className="liquid relative shrink-0 px-6 pt-5 pb-4">
        {icon}
        <h2 className="mt-1.5 text-2xl leading-tight font-semibold">{title}</h2>
        <p className="mt-1 text-xs opacity-85">{sub}</p>
        <button type="button" onClick={close} aria-label={tx('关闭')} title={tx('关闭')} className="press absolute top-4 right-4 flex size-8 items-center justify-center rounded-full bg-white/20 hover:bg-white/30"><X size={16} /></button>
      </header>
      <div className="flex shrink-0 items-center gap-3 px-6 py-3.5">
        <Seg label={tx('预览或编辑')} value={mode} onChange={onMode} options={[{ id: 'preview', label: tx('预览') }, { id: 'edit', label: tx('编辑') }]} className="w-36" />
        <span className="flex-1" />{actions}
      </div>
      <div className={cx('min-h-0 flex-1 overflow-y-auto px-7 pb-5', mode === 'edit' && 'flex flex-col pt-1')}>{children}</div>
      {mode === 'edit' && footer && <div className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-3.5">{footer}</div>}
    </div>
  </div>
}

const Markdown = ({ text, empty }: { text: string; empty: string }) => text.trim()
  ? <div className="prose-doc"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
  : <p className="pt-2 text-sm text-faint">{empty}</p>

function Editor({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder: string }) {
  return <textarea autoFocus value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} spellCheck={false}
    className="min-h-60 w-full flex-1 resize-none rounded-[14px] border border-line bg-panel px-4 py-3 text-[13px] leading-[22px] outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15" />
}

function Footer({ hint, error, saving, disabled, onCancel, onSave }: { hint: string; error?: string | undefined; saving: boolean; disabled: boolean; onCancel(): void; onSave(): void }) {
  return <>
    <p className={cx('min-w-0 flex-1 text-xs text-pretty', error ? 'text-danger' : 'text-faint')}>{error ?? hint}</p>
    <button type="button" onClick={onCancel} className="press h-8 shrink-0 rounded-full px-3.5 text-[13px] text-muted hover:bg-sunken">{tx('取消')}</button>
    <button type="button" onClick={onSave} disabled={disabled || saving} className="press h-8 shrink-0 rounded-full bg-ink px-4 text-[13px] font-medium text-ink-fg disabled:opacity-50">{tx('保存')}</button>
  </>
}

const BY: Record<string, string> = { owner: tx('你改的'), router: tx('按你说的改的'), watchdog: tx('自己纠正的'), system: tx('系统') }
const day = (at: number) => { const d = new Date(at); return tx('{0} 月 {1} 日', d.getMonth() + 1, d.getDate()) }

export function SoulSheet({ hues, onClose }: { hues: Pair; onClose(): void }) {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['instructions'], queryFn: () => api.get<InstructionsState>('/instructions') }).data
  const [mode, setMode] = useState<Mode>('preview')
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState(false)
  const body = data?.current.body ?? ''
  const refresh = () => qc.invalidateQueries({ queryKey: ['instructions'] })
  const save = useMutation({ mutationFn: () => api.put('/instructions', { body: draft }), onSuccess: () => { refresh(); setMode('preview') } })
  const restore = useMutation({ mutationFn: (version: number) => api.post('/instructions/restore', { version }), onSuccess: () => { refresh(); setHistory(false) } })
  const toMode = (m: Mode) => { if (m === 'edit') { setDraft(body); setHistory(false) } else if (draft !== body && !confirm(tx('改的还没保存，不要了吗？'))) return; setMode(m) }
  const v = data?.current
  const sub = !v?.version ? tx('还没写过') : mode === 'edit' ? tx('第 {0} 版 · 正在改', v.version) : tx('第 {0} 版 · {1} · {2}', v.version, BY[v.by] ?? v.by, day(v.at))
  return <Sheet hues={hues} icon={<ScrollText size={20} />} title={tx('灵魂')} sub={sub} mode={mode} onMode={toMode} onClose={onClose} dirty={mode === 'edit' && draft !== body}
    actions={!!data?.history.length && mode === 'preview' && <button type="button" onClick={() => setHistory(h => !h)} aria-pressed={history}
      className={cx('flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] hover:text-fg', history ? 'text-fg' : 'text-muted')}><History size={13} />{tx('历史版本')}</button>}
    footer={<Footer hint={tx('用 Markdown 写，整段贴进来也行。保存后是第 {0} 版，旧版本随时能恢复。', (v?.version ?? 0) + 1)} error={save.error ? (save.error as Error).message : undefined}
      saving={save.isPending} disabled={draft.trim() === body.trim()} onCancel={() => toMode('preview')} onSave={() => save.mutate()} />}>
    {!data ? null : mode === 'edit'
      ? <Editor value={draft} onChange={setDraft} placeholder={tx('## 沟通方式\n- 结论先说，别客套\n\n## 做事边界\n- 花钱、发出去之前先问我\n\n也可以直接把一大段规矩贴进来。')} />
      : history
        ? <ol className="divide-y divide-line">{data.history.map(h => <li key={h.version} className="flex items-start gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm">{tx('第 {0} 版', h.version)} <span className="text-xs text-faint">· {BY[h.by] ?? h.by} · {day(h.at)}</span></div>
            {h.note && <div className="text-xs text-muted">{h.note}</div>}
            <p className="mt-1 line-clamp-2 text-xs whitespace-pre-line text-faint">{h.body || tx('（空）')}</p>
          </div>
          {h.version === data.current.version ? <span className="shrink-0 pt-0.5 text-xs text-faint">{tx('现在')}</span>
            : <button type="button" onClick={() => restore.mutate(h.version)} disabled={restore.isPending} className="press h-7 shrink-0 rounded-full border border-line px-3 text-xs hover:bg-sunken">{tx('恢复')}</button>}
        </li>)}</ol>
        : <Markdown text={body} empty={tx('还没写。点「编辑」，把你希望它一直遵守的规矩写进来：怎么跟你说话、什么能自己做、做完要交什么。')} />}
  </Sheet>
}

export function MemorySheet({ hues, count, onClose }: { hues: Pair; count: number; onClose(): void }) {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['memories', 'markdown'], queryFn: () => api.get<{ markdown: string }>('/memories/markdown') }).data
  const [mode, setMode] = useState<Mode>('preview')
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const md = data?.markdown ?? ''
  const refresh = () => qc.invalidateQueries({ queryKey: ['memories'] })
  const save = useMutation({ mutationFn: () => api.put<{ added: number; removed: number }>('/memories/markdown', { markdown: draft }),
    onSuccess: r => { refresh(); setMode('preview'); setNote(r.added || r.removed ? [r.added && tx('记住了 {0} 件', r.added), r.removed && tx('忘掉了 {0} 件', r.removed)].filter(Boolean).join('，') : '') } })
  const tidy = useMutation({ mutationFn: () => api.post<{ expired: number; merged: number }>('/memories/consolidate'),
    onSuccess: r => { refresh(); setNote(r.expired || r.merged ? tx('合并了 {0} 件，清掉过期的 {1} 件', r.merged, r.expired) : tx('已经很整齐了')) } })
  const toMode = (m: Mode) => { if (m === 'edit') { setDraft(md); setNote('') } else if (draft !== md && !confirm(tx('改的还没保存，不要了吗？'))) return; setMode(m) }
  // Empty sections are only scaffolding for editing; the preview leaves them out.
  const shown = md.split(/\n(?=## )/).filter(s => s.trim().split('\n').length > 1).join('\n')
  return <Sheet hues={hues} icon={<Brain size={20} />} title={tx('记忆')} sub={mode === 'edit' ? tx('{0} 件 · 正在改', count) : note || tx('{0} 件', count)} mode={mode} onMode={toMode} onClose={onClose} dirty={mode === 'edit' && draft !== md}
    actions={mode === 'preview' && <button type="button" onClick={() => tidy.mutate()} disabled={tidy.isPending} title={tx('合并重复的，清掉过期的')} className="rounded-full px-2 py-1 text-[13px] text-muted hover:text-fg disabled:opacity-50">{tx('整理')}</button>}
    footer={<Footer hint={tx('一行一条。删掉的它会忘掉，新写的它会记住；项目写在「## 项目 · 名字」下面。')} error={save.error ? (save.error as Error).message : undefined}
      saving={save.isPending} disabled={draft === md} onCancel={() => toMode('preview')} onSave={() => save.mutate()} />}>
    {!data ? null : mode === 'edit' ? <Editor value={draft} onChange={setDraft} placeholder={tx('## 关于你\n- 住在上海')} />
      : <Markdown text={shown} empty={tx('它还没记下关于你的事。点「编辑」写几条，比如你住哪、习惯什么。')} />}
  </Sheet>
}
