/**
 * A conversation, the way a chat app shows one: the owner's messages and the assistant's. The work behind it stays out of
 * sight — only a quiet "working on…" line, finished results as attachments, and what needs the owner (a yes/no, a
 * question, the browser) appear here. What was done step by step is one click away, never in the timeline.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowUp, ChevronDown, ChevronRight, ExternalLink, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, ApiError, type Conversation, type Delivery, type Message, type RolesResponse } from './api'
import { openActivity, openTask, useLive } from './live'
import { Avatar, statusLine, usePersona } from './persona'
import { go } from './route'
import { FileChip, NeedsYou, needsOwner, useTickets, WorkingLine } from './tasks'
import { SOURCE_LABEL, SourceIcon } from './icons'
import { cx } from './ui'

/** A message typed on the empty screen, sent once the new conversation's page mounts. */
let pendingSend: { id: string; content: string } | undefined

const SUGGESTIONS = ['帮我写个脚本统计当前目录的代码行数', '调研一下 SQLite WAL 模式的优缺点', '你能帮我做些什么？', '每天早上 9 点给我整理一下 Hacker News 热门']

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
    {main ? <header className="flex h-14 shrink-0 items-center border-b border-line px-5">
      {/* Muse: the assistant's face, with a line of what it is doing; tap for the activity log. */}
      <button onClick={() => openActivity(true)} className="flex min-w-0 items-center gap-2.5 rounded-xl py-1 pr-3 text-left hover:bg-sunken" title="看看我在做什么">
        <Avatar persona={persona} size={32} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{persona.name}</span>
          <span className={cx('flex items-center gap-1 truncate text-xs', status.tone === 'waiting' ? 'text-warn' : 'text-faint')}>
            {status.tone === 'working' && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}{status.text}
          </span>
        </span>
      </button>
    </header> : thread.data && <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-5">
      {external && <SourceIcon source={current!.source} className="shrink-0 text-muted" />}
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}{!external && <span className="ml-2 text-xs font-normal text-faint">侧聊</span>}</h1>
      {current?.meta.url && <a href={current.meta.url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-xs text-accent">
        在 {SOURCE_LABEL[current.source] ?? current.source} 打开 <ExternalLink size={12} /></a>}
    </header>}
    {noRouter && <div className="mx-auto mt-4 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
      <AlertTriangle size={16} className="shrink-0 text-warn" />
      <span className="flex-1">还没有可用的模型。添加供应商的 API key（或设置 OPENAI_API_KEY 等环境变量后重启），再为「主 Agent」选择模型。</span>
      <a className="font-medium text-accent" href="#/settings/providers">去设置</a>
    </div>}
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {empty ? <Welcome onPick={t => send(t)} disabled={Boolean(noRouter)} main={Boolean(main)} name={persona.name} /> :
        <div className="mx-auto max-w-3xl space-y-3 px-5 py-6">
          {messages.map((m, i) => <Item key={m.id} m={m} first={messages[i - 1]?.role !== m.role || Boolean(messages[i - 1]?.meta.source && messages[i - 1]!.meta.source !== 'webchat')} />)}
          {draft && <Bubble first={last?.role !== 'assistant'}><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.text}</ReactMarkdown><span className="caret" /></div></Bubble>}
          {thinking && <Bubble first><Typing /></Bubble>}
          {asks.map(t => <NeedsYou key={t.id} t={t} onAnswer={(text, ticketId) => send(text, ticketId)} />)}
        </div>}
    </div>
    {error && <div className="mx-auto w-full max-w-3xl px-5"><div className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-danger">{error}</div></div>}
    <Composer onSend={text => send(text)} disabled={Boolean(noRouter)} status={main ? undefined : <WorkingLine tickets={working} />}
      placeholder={main ? `跟${persona.name}说…（可以连着交代好几件事）` : '在这个侧聊里说…'} />
  </div>
}

function Typing() {
  return <div className="flex h-6 items-center gap-1" aria-label="正在输入">
    {[0, 1, 2].map(i => <span key={i} className="size-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${i * 120}ms` }} />)}
  </div>
}

function Welcome({ onPick, disabled, main, name }: { onPick(text: string): void; disabled: boolean; main: boolean; name: string }) {
  const persona = usePersona()
  return <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-5 text-center">
    {main ? <Avatar persona={persona} size={56} className="mb-4" /> : <Sparkles className="mb-4 text-accent" size={28} />}
    <h2 className="text-xl font-semibold">{main ? `嗨，我是${name}` : '新侧聊'}</h2>
    <p className="mt-2 text-sm text-muted">{main
      ? '有事直接跟我说，可以连着交代好几件。需要动手的我在后台做，做完或者要你拿主意时再来找你。'
      : '单独聊一个话题或项目。我会记住这个侧聊里定下的约定，只在这里用。'}</p>
    <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
      {SUGGESTIONS.map(s => <button key={s} disabled={disabled} onClick={() => onPick(s)}
        className="rounded-xl border border-line bg-panel px-4 py-3 text-left text-sm text-muted hover:border-accent hover:text-fg disabled:opacity-50">{s}</button>)}
    </div>
  </div>
}

/** The assistant's messages are bubbles with its avatar on the first of a run (Muse), so back-to-back messages stay readable. */
function Bubble({ first, children }: { first: boolean; children: React.ReactNode }) {
  const persona = usePersona()
  return <div className={cx('flex items-start gap-2.5', first && 'pt-2')}>
    {first ? <Avatar persona={persona} size={28} className="mt-0.5" /> : <span className="w-7 shrink-0" />}
    <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tl-md border border-line bg-panel px-4 py-2.5 shadow-sm">{children}</div>
  </div>
}

function Item({ m, first }: { m: Message; first: boolean }) {
  const external = m.role === 'user' && m.meta.source && m.meta.source !== 'webchat'
  // A routine firing is the owner's own standing request: a quiet line, not a message from someone.
  if (external && m.meta.source === 'cron') return <div className="flex items-center gap-2 py-1 text-xs text-faint">
    <span className="h-px flex-1 bg-line" /><span>⏰ {m.content.split('\n')[0]!.replace(/^⏰\s*/, '').replace(/（.*?）：?$/, '')}</span><span className="h-px flex-1 bg-line" />
  </div>
  if (external) return <div className="flex gap-2.5">
    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-sunken text-muted"><SourceIcon source={m.meta.source} size={14} /></div>
    <div className="min-w-0 flex-1">
      <div className="mb-0.5 flex items-center gap-1.5 text-xs text-muted">
        <span className="font-medium text-fg">{m.meta.source === 'cron' ? '定时任务' : m.meta.actor}</span>
        {m.meta.human === false && <span className="rounded bg-sunken px-1 text-[10px]">bot</span>}
        <span className="text-faint">{new Date(m.createdAt).toLocaleString()}</span>
        {m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent"><ExternalLink size={12} /></a>}
      </div>
      <div className="prose-chat text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
    </div>
  </div>
  if (m.role === 'user') return <div className="flex justify-end">
    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[15px] whitespace-pre-wrap">{m.content}</div>
  </div>
  const result = m.meta.result as Delivery | undefined
  return <div className="space-y-2">
    <Bubble first={first}><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div></Bubble>
    {result && <div className="pl-[38px]"><Result result={result} /></div>}
    {m.meta.error && <div className="pl-[38px] text-xs text-danger">⚠ {m.meta.error}</div>}
    {m.meta.via && <div className="flex items-center gap-1 pl-[38px] text-[11px] text-faint">
      <SourceIcon source={m.meta.via} size={11} />
      {m.meta.delivery === 'sent' ? <>已发到 {SOURCE_LABEL[m.meta.via] ?? m.meta.via}{m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent"> ↗</a>}</>
        : m.meta.delivery === 'pending' ? '发送中…'
        : <span className="text-danger">{m.meta.delivery === 'dropped' ? '没能发出去' : '发送失败，稍后重试'}{m.meta.deliveryError ? `：${m.meta.deliveryError}` : ''}</span>}
    </div>}
  </div>
}

/** A finished piece of work: its files, and the full write-up folded under the message. */
function Result({ result }: { result: Delivery }) {
  const [open, setOpen] = useState(false)
  const long = result.summary.length > 160
  return <div className="space-y-2">
    {result.files.length > 0 && <div className="flex flex-wrap items-start gap-2">{result.files.map(f => <FileChip key={f.id} {...f} />)}</div>}
    {long && <div className="rounded-xl border border-line bg-panel">
      <div className="flex items-center">
        <button onClick={() => setOpen(v => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 px-3.5 py-2.5 text-left text-sm">
          {open ? <ChevronDown size={14} className="shrink-0 text-faint" /> : <ChevronRight size={14} className="shrink-0 text-faint" />}
          <span className="truncate font-medium">{result.title}</span><span className="shrink-0 text-xs text-faint">· 完整结果</span>
        </button>
        <button onClick={() => openTask(result.ticketId)} className="shrink-0 px-3.5 text-xs text-faint hover:text-muted">我是怎么做的</button>
      </div>
      {open && <div className="prose-chat border-t border-line px-4 py-3 text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{result.summary}</ReactMarkdown></div>}
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
  return <div className="mx-auto w-full max-w-3xl px-5 pt-2 pb-5">
    {status && <div className="mb-2 px-1">{status}</div>}
    <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 pl-4 focus-within:border-accent">
      <textarea ref={ref} value={text} rows={1} autoFocus placeholder={disabled ? '请先在设置中配置模型' : placeholder}
        disabled={disabled} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        className="max-h-60 min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-faint" />
      <button onClick={submit} aria-label="发送" disabled={!text.trim() || disabled} className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-fg disabled:opacity-40"><ArrowUp size={18} /></button>
    </div>
  </div>
}
