/**
 * A conversation, the way a chat app shows one: the owner's messages and the assistant's. The work behind it stays out of
 * sight — only a quiet "working on…" line, the assistant's own words about a result, and what needs the owner (a yes/no,
 * a question, the browser) appear here. Files, the full write-up and what was done step by step live in the activity
 * panel's task details, never in the timeline.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, AlertTriangle, ArrowDown, ArrowUp, ArrowUpRight, Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, ApiError, type Conversation, type Message, type RolesResponse } from './api'
import { useLive } from './live'
import { Avatar, greeting, statusLine, usePersona, type Mood } from './persona'
import { topicColor } from './Sidebar'
import { go } from './route'
import { NeedsYou, needsOwner, useTickets, WorkingLine } from './tasks'
import { SOURCE_LABEL, SourceIcon } from './icons'
import { cx } from './ui'
import { TopBar } from './shell'
import { TodayToggle } from './Today'

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
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
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

  // Follows new messages while you are at the bottom; if you scrolled up to read, a 新消息 button appears instead.
  const atBottom = useRef(true)
  const [behind, setBehind] = useState(false)
  const toBottom = (smooth?: boolean) => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); setBehind(false) }
  useLayoutEffect(() => { if (atBottom.current || last?.role === 'user') toBottom(); else setBehind(true) }, [messages.length, draft?.text, thinking, asks.length])
  useEffect(() => { atBottom.current = true; toBottom() }, [id])
  const onScroll = () => { const el = scrollRef.current; if (!el) return; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (atBottom.current) setBehind(false) }

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
    <TopBar className={cx('md:px-4', !main && thread.data ? 'border-b border-line' : 'max-md:hidden')} right={<TodayToggle className="max-md:hidden" />}>
      {!main && thread.data && <>
        {external ? <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sunken text-muted"><SourceIcon source={current!.source} size={14} /></span>
          : <span className="size-2.5 shrink-0 rounded-full" style={{ background: topicColor(id!) }} />}
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold">{title}</h1>
        {current?.meta.url && <a href={current.meta.url} target="_blank" rel="noreferrer" className="press flex shrink-0 items-center gap-1 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
          在 {SOURCE_LABEL[current.source] ?? current.source} 打开 <ExternalLink size={12} /></a>}
      </>}
    </TopBar>
    {noRouter && <div className="mx-auto mt-4 w-full max-w-3xl px-4 md:px-6"><div className="anim-rise flex items-center gap-3 rounded-2xl bg-warn-soft px-4 py-3 text-sm">
      <AlertTriangle size={16} className="shrink-0 text-warn" />
      <span className="flex-1">还没有配置模型</span>
      <a className="press shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-ink-fg" href="#/settings/providers">去设置</a>
    </div></div>}
    <div className="relative min-h-0 flex-1">
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
      {empty ? <Welcome onPick={t => { setText(t); requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length) } }) }} disabled={Boolean(noRouter)} main={Boolean(main)} mood={status.tone} /> :
        <div className="mx-auto max-w-3xl space-y-3.5 px-4 pt-6 pb-4 md:px-8 md:pt-8">
          {messages.map((m, i) => <Item key={m.id} m={m} fresh={m.createdAt > mountedAt} first={messages[i - 1]?.role !== m.role || Boolean(messages[i - 1]?.meta.source && messages[i - 1]!.meta.source !== 'webchat')} />)}
          {draft && <Bubble first={last?.role !== 'assistant'} fresh><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.text}</ReactMarkdown><span className="caret" /></div></Bubble>}
          {thinking && <Bubble first fresh mood="thinking"><Typing /></Bubble>}
          {asks.map(t => <div key={t.id} className="anim-rise pl-[42px]"><NeedsYou t={t} onAnswer={(text, ticketId) => send(text, ticketId)} /></div>)}
        </div>}
    </div>
    {behind && <button onClick={() => toBottom(true)} className="anim-pop press absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-ink-fg shadow-lg"><ArrowDown size={13} />新消息</button>}
    </div>
    {error && <div className="mx-auto w-full max-w-3xl px-4 md:px-6"><div className="anim-rise rounded-2xl bg-danger/10 px-4 py-2.5 text-sm text-danger">{error}</div></div>}
    <Composer text={text} setText={setText} inputRef={inputRef} onSend={value => send(value)} disabled={Boolean(noRouter)} status={<WorkingLine tickets={working} />}
      placeholder={`跟${persona.name}说点什么…`} />
  </div>
}

function Typing() {
  return <div className="flex h-6 items-center gap-1" aria-label="正在输入">
    {[0, 1, 2].map(i => <span key={i} className="size-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${i * 120}ms` }} />)}
  </div>
}

const SUGGESTIONS: [string, string][] = [['每天 9 点整理 HN 热门', '#13857a'], ['周五下午提醒我交周报', '#d2535a'], ['比较几款降噪耳机', '#f2b632'], ['起草一封请假邮件', '#7e8a6e'], ['总结今天的未读消息', '#d9772e']]
const TILT = [-3, 2, -1.5, 1.5, -2]

function Welcome({ onPick, disabled, main, mood }: { onPick(text: string): void; disabled: boolean; main: boolean; mood: 'idle' | 'working' | 'waiting' }) {
  const persona = usePersona()
  return <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-4 py-10 text-center md:px-6">
    <div className="glow pointer-events-none absolute top-[6%] left-1/2 -ml-[300px] h-[440px] w-[600px] rounded-full" aria-hidden />
    <Avatar persona={persona} size={128} mood={main ? mood : 'happy'} track className="anim-pop relative text-fg" />
    <p className="anim-rise relative mt-3 text-base font-medium text-faint">{main ? greeting() : '新话题'}</p>
    <h2 className="anim-rise relative mt-1 font-display text-[clamp(30px,6vw,44px)] leading-[1.28] font-semibold text-balance">
      {main ? <>今天想让我<br /><Mark>帮你做</Mark>点什么？</> : <>这次想<Mark>聊点</Mark>什么？</>}
    </h2>
    <div className="relative mt-8 flex max-w-xl flex-wrap justify-center gap-x-2.5 gap-y-3">
      {SUGGESTIONS.map(([t, c], i) => <button key={t} disabled={disabled} onClick={() => onPick(t)} style={{ background: c, ['--r' as string]: `${TILT[i]}deg`, ['--i' as string]: i }}
        className={cx('tag rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50', c === '#f2b632' ? 'text-[#121212]' : 'text-white')}>{t}</button>)}
    </div>
  </div>
}

/** The accented words of the greeting, underlined by a hand-drawn line that draws itself in. */
function Mark({ children }: { children: React.ReactNode }) {
  return <span className="relative inline-block text-accent">{children}
    <svg className="squiggle absolute -bottom-1.5 left-0 h-2.5 w-full" viewBox="0 0 132 10" preserveAspectRatio="none" aria-hidden>
      <path d="M2 7 C 13 1, 20 1, 24 5 S 35 9, 46 5 S 57 1, 68 5 S 79 9, 90 5 S 101 1, 112 5 S 123 9, 130 4" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  </span>
}

/** The assistant's messages are bubbles with its face on the first of a run; a fresh reply makes it hop. */
function Bubble({ first, fresh, mood = 'idle', children }: { first: boolean; fresh?: boolean; mood?: Mood; children: React.ReactNode }) {
  const persona = usePersona()
  return <div className={cx('flex items-start gap-2.5', first && 'pt-1.5', fresh && 'anim-rise')}>
    {first ? <span className={cx('mt-0.5 shrink-0', fresh && 'hop')}><Avatar persona={persona} size={32} mood={fresh && mood === 'idle' ? 'happy' : mood} /></span> : <span className="w-8 shrink-0" />}
    <div className="min-w-0 max-w-[85%] rounded-[22px] rounded-tl-md bg-bubble px-4 py-2.5">{children}</div>
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
    <div className="min-w-0 flex-1 rounded-[22px] rounded-tl-md border border-line bg-card px-4 py-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span className="font-medium text-fg">{m.meta.source === 'cron' ? '定时任务' : m.meta.actor}</span>
        {m.meta.human === false && <span className="rounded-full bg-sunken px-1.5 text-[10px]">bot</span>}
        <span className="text-faint tabular-nums">{new Date(m.createdAt).toLocaleString()}</span>
        {m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent" aria-label="打开原文"><ExternalLink size={12} /></a>}
      </div>
      <div className="prose-chat text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
    </div>
  </div>
  if (m.role === 'user') return <div className={cx('msg flex flex-col items-end', fresh && 'anim-send')}>
    <div className="selectable max-w-[85%] rounded-[22px] rounded-br-md bg-accent px-4 py-2.5 text-[15px] whitespace-pre-wrap text-accent-fg">{m.content}</div>
    <MsgActions m={m} />
  </div>
  return <div className="msg space-y-1.5">
    <Bubble first={first} fresh={fresh}><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div></Bubble>
    <div className="pl-[42px]"><MsgActions m={m} /></div>
    {m.meta.error && <div className="flex items-center gap-1 pl-[42px] text-xs text-danger"><AlertTriangle size={12} />{m.meta.error}</div>}
    {m.meta.via && <div className="flex items-center gap-1 pl-[42px] text-[11px] text-faint">
      <SourceIcon source={m.meta.via} size={11} />
      {m.meta.delivery === 'sent' ? <>已发到 {SOURCE_LABEL[m.meta.via] ?? m.meta.via}{m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent" aria-label="打开"><ArrowUpRight size={11} /></a>}</>
        : m.meta.delivery === 'pending' ? '发送中…'
        : <span className="text-danger">{m.meta.delivery === 'dropped' ? '没能发出去' : '发送失败，稍后重试'}{m.meta.deliveryError ? `：${m.meta.deliveryError}` : ''}</span>}
    </div>}
  </div>
}

/** Under a message on hover: copy it, and when it was sent. */
function MsgActions({ m }: { m: Message }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { void navigator.clipboard?.writeText(m.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) }
  return <div className="msg-actions -mb-2 flex h-6 items-center gap-1 text-[11px] text-faint">
    <button onClick={copy} aria-label="复制" title="复制" className="press flex size-6 items-center justify-center rounded-md hover:bg-sunken hover:text-fg">{copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}</button>
    <span className="tabular-nums">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
  </div>
}

/** Never blocks on a message in flight: each message is independent, and the owner may type several in a row. */
function Composer({ text, setText, inputRef, onSend, disabled, status, placeholder }: { text: string; setText(v: string): void; inputRef: React.RefObject<HTMLTextAreaElement | null>; onSend(text: string): void; disabled: boolean; status?: React.ReactNode; placeholder: string }) {
  const persona = usePersona()
  const [focused, setFocused] = useState(false)
  useLayoutEffect(() => {
    const el = inputRef.current
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
  const ready = Boolean(text.trim()) && !disabled
  return <div className="mx-auto w-full max-w-3xl px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] md:px-8 md:pb-6">
    {status && <div className="mb-2.5 empty:hidden">{status}</div>}
    <div className="relative">
      <div className="pointer-events-none absolute bottom-full left-7 h-10 w-12 overflow-hidden" aria-hidden>
        <div className="peek" data-show={focused && text.length > 0}><Avatar persona={persona} size={46} mood="listening" /></div>
      </div>
      <div className="relative flex items-end gap-2 rounded-[28px] border border-line bg-card p-2 pl-5 shadow-[var(--shadow-sheet)] transition-[border-color,box-shadow] duration-200 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/12">
        <textarea ref={inputRef} value={text} rows={1} autoFocus placeholder={disabled ? '请先在设置中配置模型' : placeholder}
          disabled={disabled} onChange={e => setText(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} aria-label="消息"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
          className="max-h-60 min-h-[24px] flex-1 resize-none bg-transparent py-2.5 text-[15px] outline-none placeholder:text-faint focus-visible:outline-none" />
        <button onClick={submit} aria-label="发送" disabled={!ready}
          className={cx('press flex size-11 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-200', ready ? 'bg-accent text-accent-fg' : 'bg-sunken text-faint')}>
          <ArrowUp size={19} className={cx('transition-transform duration-200 ease-out', ready && '-translate-y-px')} /></button>
      </div>
    </div>
  </div>
}
