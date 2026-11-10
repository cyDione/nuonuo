/**
 * ⌘K (Figma v6, 20d): one box over the conversations, what was made and what 糯糯 remembers. It comes out of the middle
 * of the screen (0.96 → 1 and a fade), the highlight slides with the arrow keys, and when nothing fits you ask 糯糯 instead.
 * ↑↓ choose · ↵ open · ⌘↵ ask 糯糯 · esc close.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Brain, CornerDownLeft, MessageCircle, Search, Sparkles, Table2, FileText, Image as ImageIcon, AppWindow } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { api } from './api'
import { prefillComposer } from './Chat'
import { usePersona } from './persona'
import { getPrefs, keyLabel, matchesKey } from './prefs'
import { ArtifactModal, previewKind } from './preview'
import { setPaneTab } from './RightPane'
import { go } from './route'
import { openPane } from './Sidebar'
import { cx, IconButton } from './ui'

interface Hit { id: string; text: string; at: number; conversationId?: string | null; conversation?: string; main?: boolean; ticketId?: string; kind?: string }
interface Results { messages: Hit[]; artifacts: Hit[]; memories: Hit[] }

let isOpen = false
const listeners = new Set<() => void>()
export function openSearch(open = true) { isOpen = open; listeners.forEach(l => l()) }
const useOpen = () => useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, () => isOpen)

/** ⌘K anywhere opens the box; the button sits at the top right of the tabbed pages. */
export function SearchButton({ className }: { className?: string }) {
  return <IconButton label={`搜索 (${keyLabel(getPrefs().keys.search).join('')})`} onClick={() => openSearch()} className={cx('size-8', className)}><Search size={17} /></IconButton>
}

export function SearchDialog() {
  const open = useOpen()
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (matchesKey(e, getPrefs().keys.search)) { e.preventDefault(); openSearch(!isOpen) } }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  return <>
    {open && <Box onFile={setFile} />}
    {file && <ArtifactModal id={file.id} name={file.name} onClose={() => setFile(null)} />}
  </>
}

const MEMORY_KIND: Record<string, string> = { profile: '关于你', project: '在做的事', episodic: '发生过的事', lesson: '学到的' }
const when = (at: number) => {
  const d = new Date(at), now = new Date()
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}`
}
function fileIcon(name: string) {
  const k = previewKind(name)
  return k === 'csv' ? Table2 : k === 'image' ? ImageIcon : k === 'html' ? AppWindow : FileText
}

type Row = { key: string; group: string; icon: ReactNode; text: string; sub: string; run(): void }

function Box({ onFile }: { onFile(f: { id: string; name: string }): void }) {
  const persona = usePersona()
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 120); return () => clearTimeout(t) }, [q])
  const results = useQuery({ queryKey: ['search', term], queryFn: () => api.get<Results>(`/search?q=${encodeURIComponent(term)}`), enabled: !!term, placeholderData: keepPreviousData })
  const close = () => openSearch(false)
  const ask = () => { close(); go('/'); prefillComposer(q.trim()) }

  const rows = useMemo<Row[]>(() => {
    const r = term ? results.data : undefined
    if (!r) return []
    return [
      ...r.messages.map(m => ({ key: m.id, group: '聊天', icon: <MessageCircle size={15} />, text: m.text, sub: [m.main ? '主聊' : m.conversation, when(m.at)].filter(Boolean).join(' · '),
        run: () => { close(); go(m.main || !m.conversationId ? '/' : `/c/${m.conversationId}`) } })),
      ...r.artifacts.map(a => { const Icon = fileIcon(a.text); return { key: a.id, group: '成果', icon: <Icon size={15} />, text: a.text, sub: when(a.at),
        run: () => { close(); onFile({ id: a.id, name: a.text }) } } }),
      ...r.memories.map(m => ({ key: m.id, group: '记忆', icon: <Brain size={15} />, text: m.text, sub: `${MEMORY_KIND[m.kind ?? ''] ?? '记忆'} · ${when(m.at)} 记住的`,
        run: () => { close(); go('/'); setPaneTab('who'); setTimeout(() => openPane(true), 60) } })),
    ]
  }, [results.data, term])
  useEffect(() => setActive(0), [rows])
  useEffect(() => { list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if ((e.metaKey || e.ctrlKey || !rows.length) && q.trim()) ask()
      else rows[active]?.run()
    }
  }

  const empty = !!term && results.isSuccess && !results.isPlaceholderData && !rows.length
  return createPortal(<div className="anim-fade fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-4 pt-[12vh]" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div role="dialog" aria-modal="true" aria-label="搜索" onKeyDown={onKey}
      className="anim-pop flex max-h-[70vh] w-full max-w-[600px] flex-col overflow-hidden rounded-[22px] bg-card shadow-[0_24px_60px_-20px_rgb(0_0_0/0.4),0_0_0_1px_var(--line)]">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <Search size={18} className="shrink-0 text-muted" />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="搜聊天、成果和记忆" aria-label="搜索"
          role="combobox" aria-expanded={rows.length > 0} aria-controls="search-list" aria-activedescendant={rows[active] ? `search-${active}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-faint" />
        <kbd className="shrink-0 rounded-md bg-sunken px-1.5 py-0.5 font-sans text-[11px] text-faint">esc</kbd>
      </div>

      <div ref={list} id="search-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!term && <p className="px-3 py-6 text-center text-sm text-faint">想找哪段聊天、哪个文件，或者它记得的哪件事？</p>}
        {empty && <p className="px-3 py-6 text-center text-sm text-faint">没搜到「{term}」。按 ↵ 直接问{persona.name}。</p>}
        {rows.map((r, i) => <div key={r.key}>
          {r.group !== rows[i - 1]?.group && <div className="px-3 pt-2.5 pb-1.5 text-xs text-faint">{r.group}</div>}
          <button id={`search-${i}`} data-i={i} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={r.run}
            className="relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left">
            {i === active && <motion.span layoutId="search-hl" aria-hidden transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }} className="absolute inset-0 rounded-xl bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]" />}
            <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted shadow-[0_0_0_1px_var(--line)]">{r.icon}</span>
            <span className="relative min-w-0 flex-1">
              <span className="block truncate text-[15px]"><Mark text={r.text} term={term} /></span>
              <span className="block truncate text-xs text-faint">{r.sub}</span>
            </span>
            {i === active && <CornerDownLeft size={15} className="relative shrink-0 text-faint" />}
          </button>
        </div>)}
      </div>

      <button onClick={() => q.trim() && ask()} disabled={!q.trim()}
        className="flex items-center gap-2.5 border-t border-line px-5 py-3 text-left text-sm text-muted enabled:hover:text-fg disabled:opacity-60">
        <Sparkles size={15} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">{q.trim() ? <>直接问{persona.name}「{q.trim()}」…</> : <>问{persona.name}点什么…</>}</span>
        <span className="shrink-0 text-xs text-faint">⌘ ↵</span>
      </button>
    </div>
  </div>, document.body)
}

/** The query, picked out in the accent colour wherever it appears. */
function Mark({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>
  const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return <>{parts.map((p, i) => i % 2 ? <span key={i} className="text-accent">{p}</span> : p)}</>
}
