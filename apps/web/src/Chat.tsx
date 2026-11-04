import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowUp, CornerDownRight, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, ApiError, type Conversation, type Message, type RolesResponse } from './api'
import { useLive } from './live'
import { go } from './route'
import { TaskCard, TasksPanel, useTickets } from './tasks'

/** A message typed on the empty screen, sent once the new conversation's page mounts. */
let pendingSend: { id: string; content: string } | undefined

const SUGGESTIONS = ['帮我写一个统计当前目录代码行数的脚本，并运行一下', '调研一下 SQLite WAL 模式的优缺点，整理成要点', '你好，介绍一下你能做什么', '同时帮我做两件事：生成 10 个随机密码；查一下今天的日期']

export function Chat({ id }: { id?: string }) {
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') })
  const thread = useQuery({
    queryKey: ['messages', id], enabled: Boolean(id),
    queryFn: () => api.get<{ conversation: Conversation; messages: Message[] }>(`/conversations/${id}/messages`),
  })
  const list = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') })
  const tickets = useTickets()
  const title = list.data?.conversations.find(c => c.id === id)?.title ?? thread.data?.conversation.title
  const draft = useLive(s => (id ? s.drafts[id] : undefined))
  const routerBusy = useLive(s => s.routerState === 'running')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const noRouter = roles.data && !roles.data.resolved.router

  const messages = thread.data?.messages ?? []
  const openTasks = (tickets.data?.tickets ?? []).filter(t => t.conversationId === id && t.stage !== 'ended')
  const directTarget = openTasks.length === 1 ? openTasks[0] : undefined
  const last = messages.at(-1)
  const thinking = routerBusy && last?.role === 'user' && !draft

  useLayoutEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [messages.length, draft?.text, thinking])

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

  useEffect(() => {
    if (id && pendingSend?.id === id) { const { content } = pendingSend; pendingSend = undefined; void send(content) }
  }, [id])

  const empty = !id || (thread.isSuccess && messages.length === 0)

  return <div className="flex h-full">
    <div className="flex min-w-0 flex-1 flex-col">
      {thread.data && <header className="flex h-12 shrink-0 items-center border-b border-line px-5">
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </header>}
      {noRouter && <div className="mx-auto mt-4 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
        <AlertTriangle size={16} className="shrink-0 text-warn" />
        <span className="flex-1">主 Agent 还没有模型。添加供应商的 API key（或设置 DEEPSEEK_API_KEY 等环境变量后重启），再为「主 Agent」选择模型。</span>
        <a className="font-medium text-accent" href="#/settings/providers">去设置</a>
      </div>}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {empty ? <Welcome onPick={t => send(t)} disabled={Boolean(noRouter)} /> :
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            {messages.map(m => <Item key={m.id} m={m} onAnswer={(text, ticketId) => send(text, ticketId)} />)}
            {draft && <div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.text}</ReactMarkdown><span className="caret" /></div>}
            {thinking && <div className="flex items-center gap-2 text-sm text-faint"><span className="flex gap-1">
              {[0, 1, 2].map(i => <span key={i} className="size-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${i * 120}ms` }} />)}
            </span>主 Agent 正在处理</div>}
          </div>}
      </div>
      {error && <div className="mx-auto w-full max-w-3xl px-5"><div className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-danger">{error}</div></div>}
      <Composer onSend={text => send(text)} disabled={Boolean(noRouter)}
        hint={directTarget ? <><CornerDownRight size={12} />消息会直接交给进行中的任务「{directTarget.title}」；与它无关的内容会转回主 Agent</> : undefined} />
    </div>
    <TasksPanel currentConversation={id} />
  </div>
}

function Welcome({ onPick, disabled }: { onPick(text: string): void; disabled: boolean }) {
  return <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-5 text-center">
    <Sparkles className="mb-4 text-accent" size={28} />
    <h2 className="text-xl font-semibold">有什么要交给我的？</h2>
    <p className="mt-2 text-sm text-muted">简单的问题我直接回答；需要动手的事会开成任务，在后台并行完成，完成或需要你决定时我再回来找你。</p>
    <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
      {SUGGESTIONS.map(s => <button key={s} disabled={disabled} onClick={() => onPick(s)}
        className="rounded-xl border border-line bg-panel px-4 py-3 text-left text-sm text-muted hover:border-accent hover:text-fg disabled:opacity-50">{s}</button>)}
    </div>
  </div>
}

function Item({ m, onAnswer }: { m: Message; onAnswer(text: string, ticketId: string): void }) {
  if (m.role === 'event' && m.ticketId) return <TaskCard ticketId={m.ticketId} onAnswer={onAnswer} />
  if (m.role === 'user') return <div className="flex justify-end">
    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[15px] whitespace-pre-wrap">{m.content}</div>
  </div>
  return <div>
    <div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
    {m.meta.error && <div className="mt-1.5 text-xs text-danger">⚠ {m.meta.error}</div>}
  </div>
}

/** Never blocks on a message in flight: each message is independent, and the owner may type several in a row. */
function Composer({ onSend, disabled, hint }: { onSend(text: string): void; disabled: boolean; hint?: React.ReactNode }) {
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
  return <div className="mx-auto w-full max-w-3xl px-5 pt-3 pb-5">
    {hint && <div className="mb-1.5 flex items-center gap-1 px-1 text-xs text-faint">{hint}</div>}
    <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 pl-4 focus-within:border-accent">
      <textarea ref={ref} value={text} rows={1} autoFocus placeholder={disabled ? '请先在设置中为主 Agent 配置模型' : '给 Super-agent 发消息（Enter 发送，Shift+Enter 换行）'}
        disabled={disabled} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        className="max-h-60 min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-faint" />
      <button onClick={submit} aria-label="发送" disabled={!text.trim() || disabled} className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-fg disabled:opacity-40"><ArrowUp size={18} /></button>
    </div>
  </div>
}
