/**
 * A conversation, the way you message a person (Figma v6): the owner's messages in the theme colour, 糯糯's replies in grey
 * bubbles, several short ones in a row. It answers a message with a tapback first (👌 收到, 👀 在看); while it works, only
 * a typing bubble shows. No status or process lines ever appear here: what it is doing lives in the right pane. What
 * needs the owner (a yes/no, a question, the browser) arrives as a card.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MotionGrid, MotionGridCells } from '@animate-ui/react/primitives/motion-grid'
import { AlarmClock, AlertTriangle, ArrowDown, ArrowUp, ArrowUpRight, Check, Copy, ExternalLink, Mic, Plus, SquarePen } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, ApiError, type Conversation, type Message, type RolesResponse } from './api'
import { useLive } from './live'
import { Avatar, greeting, statusLine, usePersona } from './persona'
import { topicColor } from './Sidebar'
import { go } from './route'
import { NeedsYou, needsOwner, useTickets } from './tasks'
import { SOURCE_LABEL, SourceIcon } from './icons'
import { cx } from './ui'
import { TopBar } from './shell'

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
  // While it works, only the typing bubble shows (never a status line).
  const busy = !draft && (thinking || working.length > 0)
  const lastUser = messages.findLastIndex(m => m.role === 'user')
  const lastReply = messages.findLastIndex(m => m.role === 'assistant')

  // Follows new messages while you are at the bottom; if you scrolled up to read, a 新消息 button appears instead.
  const atBottom = useRef(true)
  const [behind, setBehind] = useState(false)
  const toBottom = (smooth?: boolean) => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); setBehind(false) }
  useLayoutEffect(() => { if (atBottom.current || last?.role === 'user') toBottom(); else setBehind(true) }, [messages.length, draft?.text, busy, asks.length])
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
    {!main && <TopBar className={cx('md:px-4', thread.data ? 'border-b border-line' : 'max-md:hidden')}>
      {thread.data && <>
        {external ? <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sunken text-muted"><SourceIcon source={current!.source} size={14} /></span>
          : <span className="size-2.5 shrink-0 rounded-full" style={{ background: topicColor(id!) }} />}
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold">{title}</h1>
        {current?.meta.url && <a href={current.meta.url} target="_blank" rel="noreferrer" className="press flex shrink-0 items-center gap-1 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
          在 {SOURCE_LABEL[current.source] ?? current.source} 打开 <ExternalLink size={12} /></a>}
      </>}
    </TopBar>}
    {noRouter && <div className="mx-auto mt-4 w-full max-w-3xl px-4 md:px-6"><div className="anim-rise flex items-center gap-3 rounded-2xl bg-sunken px-4 py-3 text-sm">
      <AlertTriangle size={16} className="shrink-0 text-warn" />
      <span className="flex-1">还没有配置模型</span>
      <a className="press shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-ink-fg" href="#/settings/providers">去设置</a>
    </div></div>}
    <div className="relative min-h-0 flex-1">
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
      {empty ? <Welcome onPick={t => { setText(t); requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length) } }) }} disabled={Boolean(noRouter)} main={Boolean(main)} mood={status.tone} /> :
        <div className="mx-auto max-w-[680px] px-4 pt-4 pb-4 md:px-8">
          {messages.map((m, i) => <div key={m.id} className={cx(i > 0 && (messages[i - 1]!.role === m.role ? 'mt-1.5' : 'mt-4'))}>
            <When m={m} prev={messages[i - 1]} name={persona.name} />
            <Item m={m} fresh={m.createdAt > mountedAt}
              tapback={m.role !== 'user' || m.meta.source && m.meta.source !== 'webchat' ? undefined : i === lastUser && i > lastReply && busy ? '👀' : m.ticketId ? '👌' : undefined} />
          </div>)}
          {draft && <div className="mt-1.5"><Bubble fresh><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.text}</ReactMarkdown><span className="caret" /></div></Bubble></div>}
          {busy && <div className="mt-4"><Bubble fresh><Typing /></Bubble></div>}
          {asks.map(t => <div key={t.id} className="anim-rise mt-2 max-w-[440px]"><NeedsYou t={t} onAnswer={(text, ticketId) => send(text, ticketId)} /></div>)}
        </div>}
    </div>
    {behind && <button onClick={() => toBottom(true)} className="anim-pop press absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-ink-fg shadow-lg"><ArrowDown size={13} />新消息</button>}
    </div>
    {error && <div className="mx-auto w-full max-w-3xl px-4 md:px-6"><div className="anim-rise rounded-2xl bg-danger/10 px-4 py-2.5 text-sm text-danger">{error}</div></div>}
    <Composer text={text} setText={setText} inputRef={inputRef} onSend={value => send(value)} disabled={Boolean(noRouter)} placeholder={`跟${persona.name}说…`} />
  </div>
}

const TYPING: [number, number][][] = [[[0, 0]], [[1, 0]], [[2, 0]], []]
/** The typing bubble's three dots light up in turn. */
function Typing() {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  return <div role="status" aria-label="正在输入" className="flex h-6 items-center">
    <MotionGrid gridSize={[3, 1]} frames={TYPING} duration={220} animate={!still} className="gap-1"><MotionGridCells className="typing-cell" /></MotionGrid>
  </div>
}

/** "今天 14:02" over a message that follows a pause; "· 糯糯先开口" when it spoke first. */
function When({ m, prev, name }: { m: Message; prev?: Message; name: string }) {
  if (prev && m.createdAt - prev.createdAt < 15 * 60_000) return null
  const d = new Date(m.createdAt), now = new Date()
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  const date = days === 0 ? '今天' : days === 1 ? '昨天' : d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : d.toLocaleDateString('zh-CN')
  const first = Boolean(prev) && m.role === 'assistant' && !m.meta.source
  return <div className="pt-2 pb-3 text-center text-[11px] text-faint tabular-nums">{date} {time}{first && ` · ${name}先开口`}</div>
}

const SUGGESTIONS: [string, string][] = [['每天 9 点整理 HN 热门', '#13857a'], ['周五下午提醒我交周报', '#d2535a'], ['比较几款降噪耳机', '#8a7fc0'], ['起草一封请假邮件', '#3d86e0'], ['总结今天的未读消息', '#e9845a']]
const TILT = [-3, 2, -1.5, 1.5, -2]

function Welcome({ onPick, disabled, main, mood }: { onPick(text: string): void; disabled: boolean; main: boolean; mood: 'idle' | 'working' | 'waiting' }) {
  const persona = usePersona()
  return <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-4 py-10 text-center md:px-6">
    <div className="glow pointer-events-none absolute top-[6%] left-1/2 -ml-[300px] h-[440px] w-[600px] rounded-full" aria-hidden />
    <Avatar persona={persona} size={128} mood={main ? mood : 'happy'} track className="anim-pop relative text-fg" />
    <p className="anim-rise relative mt-3 text-base font-medium text-faint">{main ? greeting() : '新侧聊'}</p>
    <h2 className="anim-rise relative mt-1 font-display text-[clamp(30px,6vw,44px)] leading-[1.28] font-semibold text-balance">
      {main ? <>今天想让我<br /><Mark>帮你做</Mark>点什么？</> : <>这次想<Mark>聊点</Mark>什么？</>}
    </h2>
    <div className="relative mt-8 flex max-w-xl flex-wrap justify-center gap-x-2.5 gap-y-3">
      {SUGGESTIONS.map(([t, c], i) => <button key={t} disabled={disabled} onClick={() => onPick(t)} style={{ background: c, ['--r' as string]: `${TILT[i]}deg`, ['--i' as string]: i }}
        className={cx('tag rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50', 'text-white')}>{t}</button>)}
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

/** 糯糯's messages: grey bubbles, no face beside them. */
function Bubble({ fresh, aside, children }: { fresh?: boolean; aside?: React.ReactNode; children: React.ReactNode }) {
  return <div className={cx('flex items-center gap-2', fresh && 'anim-rise')}>
    <div className="selectable min-w-0 max-w-[85%] rounded-[20px] bg-bubble px-4 py-2.5">{children}</div>
    {aside}
  </div>
}

function Item({ m, fresh, tapback }: { m: Message; fresh: boolean; tapback?: string | undefined }) {
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
  if (m.role === 'user') return <div className={cx('msg flex items-center justify-end gap-2', fresh && 'anim-send')}>
    <MsgActions m={m} />
    <div className="relative max-w-[85%]">
      <div className="selectable rounded-[20px] bg-accent px-4 py-2.5 text-[15px] whitespace-pre-wrap text-accent-fg">{m.content}</div>
      {tapback && <Tapback emoji={tapback} />}
    </div>
  </div>
  return <div className="msg space-y-1.5">
    <Bubble fresh={fresh} aside={<MsgActions m={m} />}><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div></Bubble>
    {m.meta.error && <div className="flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} />{m.meta.error}</div>}
    {m.meta.via && <div className="flex items-center gap-1 text-[11px] text-faint">
      <SourceIcon source={m.meta.via} size={11} />
      {m.meta.delivery === 'sent' ? <>已发到 {SOURCE_LABEL[m.meta.via] ?? m.meta.via}{m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent" aria-label="打开"><ArrowUpRight size={11} /></a>}</>
        : m.meta.delivery === 'pending' ? '发送中…'
        : <span className="text-danger">{m.meta.delivery === 'dropped' ? '没能发出去' : '发送失败，稍后重试'}{m.meta.deliveryError ? `：${m.meta.deliveryError}` : ''}</span>}
    </div>}
  </div>
}

const TAPBACK_LABEL: Record<string, string> = { '👌': '收到', '👀': '在看', '😂': '哈哈' }
/** 糯糯's reaction, sitting on the bottom-left corner of the owner's bubble. */
function Tapback({ emoji }: { emoji: string }) {
  return <span key={emoji} title={TAPBACK_LABEL[emoji]} aria-label={TAPBACK_LABEL[emoji]}
    className="tapback absolute -bottom-3.5 -left-2 flex h-7 min-w-9 items-center justify-center rounded-full border-2 border-bg bg-bubble px-1.5 text-[14px] leading-none select-none">{emoji}</span>
}

/** Beside a message on hover: copy it, and when it was sent. */
function MsgActions({ m }: { m: Message }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { void navigator.clipboard?.writeText(m.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) }
  return <div className="msg-actions flex h-6 shrink-0 items-center gap-1 text-[11px] text-faint">
    <button onClick={copy} aria-label="复制" title="复制" className="press flex size-6 items-center justify-center rounded-md hover:bg-sunken hover:text-fg">{copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}</button>
    <span className="tabular-nums">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
  </div>
}

/**
 * The input bar (Figma v6): one rounded line with + on the left and the mic on the right; once there is text, the mic
 * becomes the send button. Never blocks on a message in flight: the owner may type several in a row.
 */
function Composer({ text, setText, inputRef, onSend, disabled, placeholder }: { text: string; setText(v: string): void; inputRef: React.RefObject<HTMLTextAreaElement | null>; onSend(text: string): void; disabled: boolean; placeholder: string }) {
  const voice = useVoice(heard => setText(heard))
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])
  const submit = () => {
    const value = text.trim()
    if (!value || disabled) return
    voice.stop()
    onSend(value)
    setText('')
  }
  const ready = Boolean(text.trim()) && !disabled
  const prefill = (t: string) => { setText(t); requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length) } }) }
  return <div className="mx-auto w-full max-w-[680px] px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] md:px-8 md:pb-5">
    <div className={cx('flex items-end gap-1 rounded-[26px] border bg-panel p-1.5 shadow-[0_6px_24px_-12px_rgb(0_0_0/0.14)] transition-[border-color] duration-200',
      voice.listening ? 'border-accent' : 'border-line focus-within:border-faint')}>
      <PlusMenu onPick={prefill} />
      <textarea ref={inputRef} value={text} rows={1} autoFocus placeholder={disabled ? '请先在设置中配置模型' : voice.listening ? '在听…' : placeholder}
        disabled={disabled} onChange={e => setText(e.target.value)} aria-label="消息"
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-1 py-2 text-[15px] outline-none placeholder:text-faint focus-visible:outline-none" />
      {ready ? <button onClick={submit} aria-label="发送" className="anim-pop press flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg"><ArrowUp size={18} /></button>
        : <button onClick={voice.toggle} disabled={disabled || !voice.supported} aria-label={voice.listening ? '停止' : '说话'} aria-pressed={voice.listening}
          title={voice.supported ? (voice.listening ? '停止' : '说话') : '这里用不了语音输入'}
          className={cx('press relative flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-40', voice.listening ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg')}>
          {voice.listening && <span className="ping-soft absolute inset-0 rounded-full bg-accent" aria-hidden />}
          <Mic size={18} className="relative" /></button>}
    </div>
  </div>
}

/** + in the input bar: start a side chat, or begin a reminder or a watch in your own words. */
function PlusMenu({ onPick }: { onPick(text: string): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('mousedown', close); addEventListener('keydown', esc)
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc) }
  }, [open])
  const item = (icon: React.ReactNode, label: string, run: () => void) => <button role="menuitem" onClick={() => { setOpen(false); run() }}
    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-sunken">{icon}{label}</button>
  return <div ref={ref} className="relative">
    <button onClick={() => setOpen(v => !v)} aria-label="更多" aria-expanded={open}
      className={cx('press flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg', open && 'bg-sunken text-fg')}>
      <Plus size={19} className={cx('transition-transform duration-200 ease-out', open && 'rotate-45')} /></button>
    {open && <div role="menu" className="anim-menu absolute bottom-11 left-0 z-20 w-48 rounded-2xl border border-line bg-panel p-1 shadow-xl [transform-origin:bottom_left]">
      {item(<SquarePen size={15} className="text-muted" />, '开个侧聊', () => go('/new'))}
      {item(<AlarmClock size={15} className="text-muted" />, '定时提醒我…', () => onPick('每天早上 9 点提醒我'))}
      {item(<ArrowUpRight size={15} className="text-muted" />, '帮我盯着…', () => onPick('帮我盯着'))}
    </div>}
  </div>
}

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: (() => void) | null }
/** Voice input through the browser's speech recognition, where there is one. */
function useVoice(onText: (text: string) => void) {
  const Impl = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition as (new () => Recognition) | undefined
  const rec = useRef<Recognition | null>(null)
  const [listening, setListening] = useState(false)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => rec.current?.stop(), [])
  const stop = () => { rec.current?.stop() }
  const toggle = () => {
    if (!Impl) return
    if (listening) return stop()
    const r: Recognition = new Impl()
    r.lang = 'zh-CN'; r.interimResults = true; r.continuous = true
    r.onresult = e => latest.current(Array.from(e.results as ArrayLike<any>).map(x => x[0].transcript).join(''))
    r.onend = () => { setListening(false); rec.current = null }
    r.onerror = () => { setListening(false); rec.current = null }
    rec.current = r
    try { r.start(); setListening(true) } catch { setListening(false) }
  }
  return { supported: Boolean(Impl), listening, toggle, stop }
}
