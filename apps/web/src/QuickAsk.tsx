/**
 * Quick ask (⌘⇧Space, Figma "v4 · 桌面端" → 快问): a small floating window over whatever you are doing. Type and press
 * ↵ to hand it to the assistant (it goes into the main conversation, and the reply shows here); or pick something to
 * pick up where you left off. ⌘↵ opens the main window, esc tucks it away.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, ArrowUp, CornerDownLeft, Inbox, MessageCircle, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Conversation, type Message, type Routine } from './api'
import { useLive } from './live'
import { Avatar, usePersona } from './persona'
import { MOD } from './prefs'
import { desktop } from './shell'
import { needsOwner, useTickets } from './tasks'
import { cx } from './ui'

interface Pick { key: string; icon: LucideIcon; title: string; detail: string; hash: string }

const open = (hash: string) => { if (desktop?.quick) desktop.quick('open', hash); else location.hash = hash }
const hide = () => desktop?.quick?.('hide')

export function QuickAsk() {
  const qc = useQueryClient()
  const persona = usePersona()
  const [text, setText] = useState('')
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { document.documentElement.classList.add('quick'); return () => document.documentElement.classList.remove('quick') }, [])

  const main = useQuery({ queryKey: ['main-conversation'], queryFn: () => api.get<{ id: string }>('/conversations/main'), staleTime: Infinity }).data?.id
  const thread = useQuery({ queryKey: ['messages', main], enabled: Boolean(main && sentAt), queryFn: () => api.get<{ messages: Message[] }>(`/conversations/${main}/messages`) }).data
  const draft = useLive(s => (main ? s.drafts[main] : undefined))
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') }).data?.conversations ?? []
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') }).data?.routines ?? []
  const waiting = (useTickets().data?.tickets ?? []).filter(needsOwner)
  const reply = sentAt ? thread?.messages.filter(m => m.role === 'assistant' && m.createdAt >= sentAt).at(-1) : undefined

  const picks: Pick[] = [
    ...conversations.filter(c => !c.meta.main && !c.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2)
      .map(c => ({ key: c.id, icon: MessageCircle, title: c.title, detail: c.lastMessage ?? '', hash: `#/c/${c.id}` })),
    ...(waiting.length ? [{ key: 'waiting', icon: Inbox, title: `${waiting.length} 件事等你`, detail: waiting.slice(0, 2).map(t => t.title).join(' · '), hash: '#/activity' }] : []),
    ...routines.filter(r => r.enabled && r.next).sort((a, b) => a.next! - b.next!).slice(0, 1)
      .map(r => ({ key: r.id, icon: AlarmClock, title: r.name, detail: new Date(r.next!).toLocaleString('zh-CN', { weekday: 'short', hour: '2-digit', minute: '2-digit' }), hash: r.conversationId ? `#/c/${r.conversationId}` : '#/settings/routines' })),
  ]

  // Each time the window comes back, start fresh with the cursor in the box.
  useEffect(() => {
    const onFocus = () => { input.current?.focus(); input.current?.select() }
    addEventListener('focus', onFocus)
    return () => removeEventListener('focus', onFocus)
  }, [])

  async function send() {
    const content = text.trim()
    if (!content || !main) return
    setText('')
    setSentAt(Date.now() - 1000)
    await api.post(`/conversations/${main}/messages`, { content }).catch(() => undefined)
    qc.invalidateQueries({ queryKey: ['messages', main] })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); hide() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); open(text.trim() ? '#/' : picks[sel]?.hash ?? '#/') }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (text.trim()) void send(); else if (picks[sel]) open(picks[sel].hash) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(i => Math.min(picks.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(i => Math.max(0, i - 1)) }
  }

  const answer = draft?.text ?? reply?.content
  return <div className="flex h-dvh items-start justify-center p-3">
    <div className="w-full max-w-[600px] overflow-hidden rounded-[22px] border border-line bg-panel/95 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.45)] backdrop-blur-xl" onKeyDown={onKey}>
      <div className="drag flex items-center gap-3 px-4 py-3.5">
        <Avatar persona={persona} size={30} mood={sentAt && !answer ? 'thinking' : text ? 'listening' : 'idle'} />
        <input ref={input} autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={`问${persona.name}，或者交给它一件事…`} aria-label="快问"
          className="no-drag min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-faint focus-visible:outline-none" />
        <button onClick={() => void send()} disabled={!text.trim()} aria-label="交给它"
          className={cx('press no-drag flex size-9 shrink-0 items-center justify-center rounded-full transition-colors', text.trim() ? 'bg-accent text-accent-fg' : 'bg-sunken text-faint')}><ArrowUp size={17} /></button>
      </div>
      {sentAt ? <div className="anim-rise max-h-[50vh] overflow-y-auto border-t border-line px-5 py-4 text-[14px]">
        {answer ? <div className="prose-chat selectable"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>{draft && <span className="caret" />}</div>
          : <span className="flex items-center gap-2 text-faint">已交给{persona.name}，它在想…</span>}
      </div> : picks.length > 0 && <div className="border-t border-line px-2 pt-2 pb-1.5">
        <div className="px-2.5 pb-1 text-[11px] font-medium text-faint">接着聊</div>
        {picks.map((p, i) => <button key={p.key} onMouseEnter={() => setSel(i)} onClick={() => open(p.hash)}
          className={cx('flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors', i === sel ? 'bg-accent-soft' : '')}>
          <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-lg', i === sel ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted')}><p.icon size={14} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{p.title}</span>{p.detail && <span className="block truncate text-[11px] text-faint">{p.detail}</span>}</span>
          {i === sel && <CornerDownLeft size={14} className="shrink-0 text-accent" />}
        </button>)}
      </div>}
      <div className="flex gap-4 border-t border-line bg-sunken/40 px-4 py-2 text-[11px] text-faint">
        <span>↵ 交给{persona.name}</span><span>{MOD}↵ 在主窗口打开</span><span>esc 收起</span>
      </div>
    </div>
  </div>
}
