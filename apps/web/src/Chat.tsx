/**
 * A conversation, the way a chat app shows one: the owner's messages and the assistant's. The work behind it stays out of
 * sight — only a quiet "working on…" line, the assistant's own words about a result, and what needs the owner (a yes/no,
 * a question, the browser) appear here. Files, the full write-up and what was done step by step live in the activity
 * panel's task details, never in the timeline.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, AlertTriangle, ArrowUp, ArrowUpRight, ExternalLink, Hash } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, ApiError, type Conversation, type Message, type RolesResponse } from './api'
import { useLive } from './live'
import { Avatar, greeting, statusLine, usePersona, type Mood } from './persona'
import { go } from './route'
import { NeedsYou, needsOwner, useTickets, WorkingLine } from './tasks'
import { SOURCE_LABEL, SourceIcon } from './icons'
import { cx } from './ui'

/** A message typed on the empty screen, sent once the new conversation's page mounts. */
let pendingSend: { id: string; content: string } | undefined

export function Chat({ id, main }: { id?: string; main?: boolean }) {
  const qc = useQueryClient()
  const persona = usePersona()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') })
  const thread = useQuery({
    queryKey: ['messages', id], enabled: Boolean(id),
    queryFn: () => api.get<{ conversation: Conversation; messages: Message[] }>(`/conversations/${id}/messages`),
  })
  const list = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') })
  const tickets = useTickets()
  const current = list.data?.conversations.find(c => c.id === id)
  const title = current?.title ?? thread.data?.conversation.title
  const draft = useLive(s => (id ? s.drafts[id] : undefined))
  const routerBusy = useLive(s => s.routerState === 'running')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Only messages that arrive while the page is open animate in; history appears at once.
  const [mountedAt] = useState(() => Date.now() - 1500)
  const noRouter = roles.data && !roles.data.resolved.router

  const messages = (thread.data?.messages ?? []).filter(m => m.role === 'user' || m.role === 'assistant')
  const mine = (tickets.data?.tickets ?? []).filter(t => t.conversationId === id && t.stage !== 'ended')
  const asks = mine.filter(needsOwner)
  const working = mine.filter(t => t.stage === 'working' || t.stage === 'queued')
  const last = messages.at(-1)
  const thinking = routerBusy && last?.role === 'user' && !draft

  useLayoutEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [messages.length, draft?.text, thinking, asks.length])

  async function send(content: string, replyTo?: string) {
    setError(null)
    if (!id) {
      try {
        const { conversation } = await api.post<{ conversation: Conversation }>('/conversations')
        pendingSend = { id: conversation.id, content }
        qc.invalidateQueries({ queryKey: ['conversations'] })
        go(`/c/${conversation.id}`)
      } catch (e) { setError((e as Error).message) }
      return
    }
    try {
      const { message } = await api.post<{ message: Message }>(`/conversations/${id}/messages`, { content, ...(replyTo ? { replyTo } : {}) })
      qc.setQueryData<{ conversation: Conversation; messages: Message[] }>(['messages', id], old =>
        old && !old.messages.some(m => m.id === message.id) ? { ...old, messages: [...old.messages, message] } : old)
      qc.invalidateQueries({ queryKey: ['conversations'] })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `发送失败：${(e as Error).message}`)
    }
  }

  // Seen: mark the conversation read while it is on screen.
  useEffect(() => {
    if (!id || document.visibilityState !== 'visible') return
    if ((current?.unread ?? 0) > 0 || messages.length) void api.post(`/conversations/${id}/read`).then(() => qc.invalidateQueries({ queryKey: ['conversations'] }))
  }, [id, messages.length])

  useEffect(() => {
    if (id && pendingSend?.id === id) { const { content } = pendingSend; pendingSend = undefined; void send(content) }
  }, [id])

  const empty = !id || (thread.isSuccess && messages.length === 0)
  const status = statusLine((tickets.data?.tickets ?? []).filter(t => t.stage !== 'ended'))
  const external = current && current.source !== 'webchat'

  return <div className="flex h-full flex-col">
    {!main && thread.data && <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-5 md:px-6">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-sunken text-muted">{external ? <SourceIcon source={current!.source} size={15} /> : <Hash size={15} />}</span>
      <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold">{title}</h1>
      {current?.meta.url && <a href={current.meta.url} target="_blank" rel="noreferrer" className="press flex shrink-0 items-center gap-1 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
        在 {SOURCE_LABEL[current.source] ?? current.source} 打开 <ExternalLink size={12} /></a>}
    </header>}
    {noRouter && <div className="mx-auto mt-4 w-full max-w-3xl px-4 md:px-6"><div className="anim-rise flex items-center gap-3 rounded-2xl bg-warn-soft px-4 py-3 text-sm">
      <AlertTriangle size={16} className="shrink-0 text-warn" />
      <span className="flex-1">还没有配置模型</span>
      <a className="press shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-ink-fg" href="#/settings/providers">去设置</a>
    </div></div>}
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {empty ? <Welcome onPick={t => send(t)} disabled={Boolean(noRouter)} main={Boolean(main)} name={persona.name} mood={status.tone} /> :
        <div className="mx-auto max-w-3xl space-y-3 px-4 py-6 md:px-6">
          {messages.map((m, i) => <Item key={m.id} m={m} fresh={m.createdAt > mountedAt} first={messages[i - 1]?.role !== m.role || Boolean(messages[i - 1]?.meta.source && messages[i - 1]!.meta.source !== 'webchat')} />)}
          {draft && <Bubble first={last?.role !== 'assistant'} fresh><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.text}</ReactMarkdown><span className="caret" /></div></Bubble>}
          {thinking && <Bubble first fresh mood="thinking"><Typing /></Bubble>}
          {asks.map(t => <div key={t.id} className="anim-rise pl-10"><NeedsYou t={t} onAnswer={(text, ticketId) => send(text, ticketId)} /></div>)}
        </div>}
    </div>
    {error && <div className="mx-auto w-full max-w-3xl px-4 md:px-6"><div className="anim-rise rounded-2xl bg-danger/10 px-4 py-2.5 text-sm text-danger">{error}</div></div>}
    <Composer onSend={text => send(text)} disabled={Boolean(noRouter)} status={main ? undefined : <WorkingLine tickets={working} />}
      placeholder={main ? `跟${persona.name}说…（可以连着交代好几件事）` : '在这个侧聊里说…'} />
  </div>
}

function Typing() {
  return <div className="flex h-6 items-center gap-1" aria-label="正在输入">
    {[0, 1, 2].map(i => <span key={i} className="size-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${i * 120}ms` }} />)}
  </div>
}

const SUGGESTIONS = ['每天早上 9 点给我整理 Hacker News 热门', '周五下午 4 点提醒我交周报', '帮我比较几款降噪耳机']

function Welcome({ onPick, disabled, main, name, mood }: { onPick(text: string): void; disabled: boolean; main: boolean; name: string; mood: 'idle' | 'working' | 'waiting' }) {
  const persona = usePersona()
  return <div className="flex min-h-full flex-col items-center justify-center px-4 py-10 text-center md:px-6">
    <Avatar persona={persona} size={96} mood={main ? mood : 'happy'} track className="anim-pop mb-5 text-fg" />
    <h2 className="anim-rise font-display text-3xl leading-tight font-semibold text-balance">
      {main ? <>{greeting()}，我是{name}</> : '新侧聊'}
    </h2>
    <div className="stagger mt-6 flex max-w-xl flex-wrap justify-center gap-2">
      {SUGGESTIONS.map(t => <button key={t} disabled={disabled} onClick={() => onPick(t)}
        className="press rounded-full border border-line bg-panel px-4 py-2 text-sm text-muted hover:border-fg/30 hover:text-fg disabled:opacity-50">{t}</button>)}
    </div>
  </div>
}

/** The assistant's messages are bubbles with its face on the first of a run (Muse), so back-to-back messages stay readable. */
function Bubble({ first, fresh, mood = 'idle', children }: { first: boolean; fresh?: boolean; mood?: Mood; children: React.ReactNode }) {
  const persona = usePersona()
  return <div className={cx('flex items-start gap-2.5', first && 'pt-2', fresh && 'anim-rise')}>
    {first ? <Avatar persona={persona} size={30} mood={mood} className="mt-0.5" /> : <span className="w-[30px] shrink-0" />}
    <div className="min-w-0 max-w-[85%] rounded-[22px] rounded-tl-md bg-sunken px-4 py-2.5">{children}</div>
  </div>
}

function Item({ m, first, fresh }: { m: Message; first: boolean; fresh: boolean }) {
  const external = m.role === 'user' && m.meta.source && m.meta.source !== 'webchat'
  // A routine firing is the owner's own standing request: a quiet line, not a message from someone.
  if (external && m.meta.source === 'cron') return <div className={cx('flex items-center gap-3 py-2 text-xs text-faint', fresh && 'anim-fade')}>
    <span className="h-px flex-1 bg-line" /><span className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1"><AlarmClock size={12} />{m.content.split('\n')[0]!.replace(/^⏰\s*/, '').replace(/（.*?）：?$/, '')}</span><span className="h-px flex-1 bg-line" />
  </div>
  if (external) return <div className={cx('flex gap-2.5', fresh && 'anim-rise')}>
    <div className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-xl bg-sunken text-muted"><SourceIcon source={m.meta.source} size={14} /></div>
    <div className="min-w-0 flex-1 rounded-[22px] rounded-tl-md border border-line px-4 py-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span className="font-medium text-fg">{m.meta.source === 'cron' ? '定时任务' : m.meta.actor}</span>
        {m.meta.human === false && <span className="rounded-full bg-sunken px-1.5 text-[10px]">bot</span>}
        <span className="text-faint tabular-nums">{new Date(m.createdAt).toLocaleString()}</span>
        {m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent" aria-label="打开原文"><ExternalLink size={12} /></a>}
      </div>
      <div className="prose-chat text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
    </div>
  </div>
  if (m.role === 'user') return <div className={cx('flex justify-end', fresh && 'anim-rise')}>
    <div className="max-w-[85%] rounded-[22px] rounded-br-md bg-accent px-4 py-2.5 text-[15px] whitespace-pre-wrap text-accent-fg">{m.content}</div>
  </div>
  return <div className="space-y-1.5">
    <Bubble first={first} fresh={fresh}><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div></Bubble>
    {m.meta.error && <div className="flex items-center gap-1 pl-10 text-xs text-danger"><AlertTriangle size={12} />{m.meta.error}</div>}
    {m.meta.via && <div className="flex items-center gap-1 pl-10 text-[11px] text-faint">
      <SourceIcon source={m.meta.via} size={11} />
      {m.meta.delivery === 'sent' ? <>已发到 {SOURCE_LABEL[m.meta.via] ?? m.meta.via}{m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent" aria-label="打开"><ArrowUpRight size={11} /></a>}</>
        : m.meta.delivery === 'pending' ? '发送中…'
        : <span className="text-danger">{m.meta.delivery === 'dropped' ? '没能发出去' : '发送失败，稍后重试'}{m.meta.deliveryError ? `：${m.meta.deliveryError}` : ''}</span>}
    </div>}
  </div>
}

/** Never blocks on a message in flight: each message is independent, and the owner may type several in a row. */
function Composer({ onSend, disabled, status, placeholder }: { onSend(text: string): void; disabled: boolean; status?: React.ReactNode; placeholder: string }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  const submit = () => {
    const value = text.trim()
    if (!value || disabled) return
    onSend(value)
    setText('')
  }
  return <div className="mx-auto w-full max-w-3xl px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6 md:pb-5">
    {status && <div className="mb-2 px-2">{status}</div>}
    <div className="flex items-end gap-2 rounded-[26px] border border-line bg-panel p-2 pl-4 shadow-[var(--shadow-sheet)] transition-[border-color,box-shadow] duration-200 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/12">
      <textarea ref={ref} value={text} rows={1} autoFocus placeholder={disabled ? '请先在设置中配置模型' : placeholder}
        disabled={disabled} onChange={e => setText(e.target.value)} aria-label="消息"
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        className="max-h-60 min-h-[24px] flex-1 resize-none bg-transparent py-2 text-[15px] outline-none placeholder:text-faint focus-visible:outline-none" />
      <button onClick={submit} aria-label="发送" disabled={!text.trim() || disabled}
        className={cx('press flex size-10 shrink-0 items-center justify-center rounded-full', text.trim() && !disabled ? 'bg-accent text-accent-fg' : 'bg-sunken text-faint')}><ArrowUp size={18} /></button>
    </div>
  </div>
}
