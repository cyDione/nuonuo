import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowUp, Square, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, ApiError, sendMessage, type Conversation, type Message, type RolesResponse } from './api'
import { go } from './route'
import { cx } from './ui'

/** A message typed on the empty screen, sent once the new conversation's page mounts. */
let pendingSend: { id: string; content: string } | undefined

const SUGGESTIONS = ['帮我梳理一下这周要做的事', '解释一下 Router / Worker 双层架构', '给我写一个周报模板', '你现在能做什么，不能做什么？']

export function Chat({ id }: { id?: string }) {
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') })
  const thread = useQuery({
    queryKey: ['messages', id], enabled: Boolean(id),
    queryFn: () => api.get<{ conversation: Conversation; messages: Message[] }>(`/conversations/${id}/messages`),
  })
  const list = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') })
  const title = list.data?.conversations.find(c => c.id === id)?.title ?? thread.data?.conversation.title
  const [local, setLocal] = useState<Message[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const noRouter = roles.data && !roles.data.resolved.router

  const messages = [...(thread.data?.messages ?? []), ...local.filter(m => !thread.data?.messages.some(s => s.id === m.id))]

  useLayoutEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [messages.length, streaming])

  async function send(content: string) {
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
    const abort = new AbortController()
    abortRef.current = abort
    setStreaming('')
    try {
      await sendMessage(id, content, {
        onMessage: m => setLocal(prev => [...prev, m]),
        onDelta: t => setStreaming(prev => (prev ?? '') + t),
        onDone: m => setLocal(prev => [...prev, m]),
        onError: (message, saved) => { setError(message); if (saved) setLocal(prev => [...prev, saved]) },
      }, abort.signal)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e instanceof ApiError ? e.message : `发送失败：${(e as Error).message}`)
    } finally {
      setStreaming(null)
      abortRef.current = null
      await qc.invalidateQueries({ queryKey: ['messages', id] })
      setLocal([])
      qc.invalidateQueries({ queryKey: ['conversations'] })
      // The title is named in the background after the first exchange.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['conversations'] }), 4000)
    }
  }

  useEffect(() => {
    if (id && pendingSend?.id === id) { const { content } = pendingSend; pendingSend = undefined; void send(content) }
  }, [id])

  const empty = !id || (thread.isSuccess && messages.length === 0 && streaming === null)

  return <div className="flex h-full flex-col">
    {thread.data && <header className="flex h-12 shrink-0 items-center border-b border-line px-5">
      <h1 className="truncate text-sm font-medium">{title}</h1>
    </header>}
    {noRouter && <div className="mx-auto mt-4 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
      <AlertTriangle size={16} className="shrink-0 text-warn" />
      <span className="flex-1">主 Agent 还没有模型。先添加供应商的 API key，再为「主 Agent」选择模型。</span>
      <a className="font-medium text-accent" href="#/settings/providers">去设置</a>
    </div>}
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {empty ? <Welcome onPick={send} disabled={Boolean(noRouter)} /> :
        <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
          {messages.map(m => <Bubble key={m.id} m={m} />)}
          {streaming !== null && <div className="prose-chat text-[15px]">
            {streaming ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming}</ReactMarkdown> : null}
            <span className="caret" />
          </div>}
        </div>}
    </div>
    {error && <div className="mx-auto w-full max-w-3xl px-5"><div className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-danger">{error}</div></div>}
    <Composer onSend={send} busy={streaming !== null} onStop={() => abortRef.current?.abort()} disabled={Boolean(noRouter)} />
  </div>
}

function Welcome({ onPick, disabled }: { onPick(text: string): void; disabled: boolean }) {
  return <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-5 text-center">
    <Sparkles className="mb-4 text-accent" size={28} />
    <h2 className="text-xl font-semibold">有什么要交给我的？</h2>
    <p className="mt-2 text-sm text-muted">当前是 M0 直连预览：可以对话，还不能执行任务。任务执行、GitHub 和后台推进将在后续版本加入。</p>
    <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
      {SUGGESTIONS.map(s => <button key={s} disabled={disabled} onClick={() => onPick(s)}
        className="rounded-xl border border-line bg-panel px-4 py-3 text-left text-sm text-muted hover:border-accent hover:text-fg disabled:opacity-50">{s}</button>)}
    </div>
  </div>
}

function Bubble({ m }: { m: Message }) {
  if (m.role === 'user') return <div className="flex justify-end">
    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[15px] whitespace-pre-wrap">{m.content}</div>
  </div>
  return <div>
    <div className={cx('prose-chat text-[15px]', m.meta.error && !m.meta.partial && 'text-muted')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
    </div>
    {m.meta.error && <div className="mt-1.5 text-xs text-danger">⚠ {m.meta.error}</div>}
    {m.meta.model && <div className="mt-1 text-[11px] text-faint">{m.meta.model}{m.meta.usage ? ` · ${m.meta.usage.input ?? 0}→${m.meta.usage.output ?? 0} tokens` : ''}</div>}
  </div>
}

function Composer({ onSend, busy, onStop, disabled }: { onSend(text: string): void; busy: boolean; onStop(): void; disabled: boolean }) {
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
    if (!value || busy || disabled) return
    onSend(value)
    setText('')
  }
  return <div className="mx-auto w-full max-w-3xl px-5 pt-3 pb-5">
    <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 pl-4 focus-within:border-accent">
      <textarea ref={ref} value={text} rows={1} autoFocus placeholder={disabled ? '请先在设置中为主 Agent 配置模型' : '给 Super-agent 发消息（Enter 发送，Shift+Enter 换行）'}
        disabled={disabled} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        className="max-h-60 min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-faint" />
      {busy
        ? <button onClick={onStop} aria-label="停止" className="flex size-9 items-center justify-center rounded-xl bg-fg text-bg"><Square size={14} fill="currentColor" /></button>
        : <button onClick={submit} aria-label="发送" disabled={!text.trim() || disabled} className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-fg disabled:opacity-40"><ArrowUp size={18} /></button>}
    </div>
  </div>
}
