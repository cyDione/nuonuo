/**
 * A conversation, the way you message a person (Figma v6): the owner's messages in the theme colour, 糯糯's replies in grey
 * bubbles, several short ones in a row. 糯糯 may put a tapback on a message when it fits (👍 认同, 😂 好笑), its own choice; while it works, only
 * a typing bubble shows. No status or process lines ever appear here: what it is doing lives in the right pane. What
 * needs the owner (a yes/no, a question, the browser) arrives as a card.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MotionGrid, MotionGridCells } from '@animate-ui/react/primitives/motion-grid'
import { Particles, ParticlesEffect } from '@animate-ui/react/primitives/effects/particles'
import { SplittingText } from '@animate-ui/react/primitives/texts/splitting'
import { AlarmClock, AlertTriangle, ArrowDown, ArrowUp, ArrowUpRight, Bell, Check, ChevronLeft, Copy, ExternalLink, FileText, Layers, Mic, Paperclip, Pencil, Plane, Plus, Reply, RotateCcw, Scale, Square, Tag, Undo2, Upload as UploadIcon, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getPrefs, usePrefs } from './prefs'
import { api, ApiError, upload, type Artifact, type Conversation, type Message, type RolesResponse } from './api'
import { ChatCard, Compacted, FindBar, OpenChip, PendingFiles, QuoteBar, QuoteInBubble, SentFiles, type Pending } from './chatparts'
import { useLive } from './live'
import { Avatar, usePersona } from './persona'
import { go } from './route'
import { Onboarding, useOnboarding } from './onboarding'
import { LearnedNote, NeedsYou, needsOwner, useTickets, type Learned } from './tasks'
import { SOURCE_LABEL, SourceIcon } from './icons'
import { cx } from './ui'
import { locale, tx } from './i18n'

/** A message typed on the empty screen, sent once the new conversation's page mounts. */
let pendingSend: { id: string; content: string } | undefined
/** Text to put in the main conversation's input bar (a new goal starts as 「我想」), taken once the main chat shows. */
let pendingPrefill: string | undefined
/** ⌘K's 「在当前对话里找」 opens the find bar of whichever conversation is on screen. */
export const FIND_EVENT = 'sa-find'

export function prefillComposer(text: string) { pendingPrefill = text; dispatchEvent(new Event('sa-prefill')) }

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
  const [learned, setLearned] = useState<Learned[]>([])
  const [files, setFiles] = useState<Pending[]>([])
  const [quote, setQuote] = useState<Message | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [finding, setFinding] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Only messages that arrive while the page is open animate in; history appears at once.
  const [mountedAt] = useState(() => Date.now() - 1500)
  const noRouter = roles.data && !roles.data.resolved.router
  const onboarding = useOnboarding()

  // Edited messages give way to the corrected one; answers asked again give way to the new answer.
  const messages = (thread.data?.messages ?? []).filter(m => (m.role === 'user' && !m.meta.edited) || (m.role === 'assistant' && !m.meta.superseded) || (m.role === 'system' && m.meta.kind === 'compacted'))
  const said = messages.filter(m => m.role !== 'system')
  const mine = (tickets.data?.tickets ?? []).filter(t => t.conversationId === id && t.stage !== 'ended')
  const asks = mine.filter(needsOwner)
  const working = mine.filter(t => t.stage === 'working' || t.stage === 'queued')
  const last = said.at(-1)
  const thinking = routerBusy && last?.role === 'user' && !draft
  // While it works, only the typing bubble shows (never a status line).
  const busy = !draft && (thinking || working.length > 0)

  // Follows new messages while you are at the bottom; if you scrolled up to read, a 新消息 button appears instead.
  const atBottom = useRef(true)
  const [behind, setBehind] = useState(false)
  const toBottom = (smooth?: boolean) => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); setBehind(false) }
  useLayoutEffect(() => { if (atBottom.current || last?.role === 'user') toBottom(); else setBehind(true) }, [messages.length, draft?.text, busy, asks.length])
  useEffect(() => { atBottom.current = true; toBottom() }, [id])
  const onScroll = () => { const el = scrollRef.current; if (!el) return; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (atBottom.current) setBehind(false) }

  async function send(content: string, replyTo?: string) {
    setError(null)
    if (files.some(f => !f.upload && !f.error)) { setError(tx('附件还在传，等一下再发')); return }
    const attachments = files.filter(f => f.upload).map(f => f.upload!.id)
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
      const { message } = await api.post<{ message: Message }>(`/conversations/${id}/messages`, { content, ...(replyTo ? { replyTo } : {}),
        ...(attachments.length ? { attachments } : {}), ...(quote ? { quote: quote.id } : {}) })
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview)
      setFiles([]); setQuote(null)
      qc.setQueryData<{ conversation: Conversation; messages: Message[] }>(['messages', id], old =>
        old && !old.messages.some(m => m.id === message.id) ? { ...old, messages: [...old.messages, message] } : old)
      qc.invalidateQueries({ queryKey: ['conversations'] })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : tx('发送失败：{0}', (e as Error).message))
    }
  }

  /** + 添加文件, a drop on the chat or a paste: each file uploads at once and waits in the input bar as a chip. */
  function addFiles(list: FileList | File[]) {
    for (const file of Array.from(list).slice(0, 20)) {
      const key = `${file.name}-${file.size}-${Math.random()}`
      const preview = /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined
      setFiles(v => [...v, { key, name: file.name, mime: file.type, size: file.size, ...(preview ? { preview } : {}) }])
      if (file.size > 50 * 1024 * 1024) { setFiles(v => v.map(f => f.key === key ? { ...f, error: tx('超过 50MB') } : f)); continue }
      upload(file, id).then(u => setFiles(v => v.map(f => f.key === key ? { ...f, upload: u } : f)), e => setFiles(v => v.map(f => f.key === key ? { ...f, error: (e as Error).message } : f)))
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  function removeFile(key: string) {
    const f = files.find(x => x.key === key)
    if (f?.preview) URL.revokeObjectURL(f.preview)
    if (f?.upload) void api.del(`/uploads/${f.upload.id}`).catch(() => {})
    setFiles(v => v.filter(x => x.key !== key))
  }
  const refresh = () => qc.invalidateQueries({ queryKey: ['messages', id] })
  async function act(path: string, body?: unknown) {
    setError(null)
    try { await api.post(path, body); await refresh() } catch (e) { setError((e as Error).message) }
  }
  async function compact() {
    if (!id) return
    setError(null)
    try {
      const r = await api.post<{ compacted: boolean; note?: string }>(`/conversations/${id}/compact`)
      if (!r.compacted) { setNote(r.note ?? tx('前面的还不多，不用整理')); setTimeout(() => setNote(null), 2_500) }
      await refresh()
    } catch (e) { setError((e as Error).message) }
  }
  const startEdit = (m: Message) => setEditing(m.id)
  const recalled = useRef(new Map<string, string>())

  // ⌘F finds in this conversation. Keyboard-opened, so it appears without animation.
  useEffect(() => {
    if (!id) return
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setFinding(true) } }
    const onFind = () => setFinding(true)
    addEventListener('keydown', onKey)
    addEventListener(FIND_EVENT, onFind)
    return () => { removeEventListener('keydown', onKey); removeEventListener(FIND_EVENT, onFind) }
  }, [id])

  // Seen: mark the conversation read while it is on screen.
  useEffect(() => {
    if (!id || document.visibilityState !== 'visible') return
    if ((current?.unread ?? 0) > 0 || messages.length) void api.post(`/conversations/${id}/read`).then(() => qc.invalidateQueries({ queryKey: ['conversations'] }))
  }, [id, messages.length])

  useEffect(() => {
    if (!main) return
    const take = () => {
      if (pendingPrefill == null) return
      const t = pendingPrefill
      pendingPrefill = undefined
      setText(t)
      requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length) } })
    }
    take()
    addEventListener('sa-prefill', take)
    return () => removeEventListener('sa-prefill', take)
  }, [main])

  useEffect(() => {
    if (id && pendingSend?.id === id) { const { content } = pendingSend; pendingSend = undefined; void send(content) }
  }, [id])

  const empty = !id || (thread.isSuccess && said.length === 0)
  const all = (tickets.data?.tickets ?? []).filter(t => t.conversationId === id)
  const ended = all.filter(t => t.stage === 'ended').sort((a, b) => (b.ended?.at ?? 0) - (a.ended?.at ?? 0))[0]
  const sideStatus = asks.length ? tx('等你点头') : working.length ? tx('在做') : ended?.ended ? tx('{0}.{1} 做完', new Date(ended.ended.at).getMonth() + 1, new Date(ended.ended.at).getDate()) : ''
  const artifacts = useQuery({ queryKey: ['artifacts'], queryFn: () => api.get<{ artifacts: Artifact[] }>('/artifacts'), enabled: Boolean(id) && !main }).data?.artifacts ?? []
  const made = artifacts.filter(a => a.conversationId === id).length
  const external = current && current.source !== 'webchat'

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  return <div className="relative flex h-full flex-col"
    onDragEnter={e => { if (hasFiles(e) && !noRouter) { e.preventDefault(); setDragging(true) } }}
    onDragOver={e => { if (hasFiles(e) && !noRouter) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
    onDragLeave={e => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
    onDrop={e => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); if (!noRouter) addFiles(e.dataTransfer.files) }}>
    {dragging && <div className="anim-fade pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-[28px] border-2 border-dashed border-accent bg-accent-soft/80 text-sm font-medium text-accent">
      <UploadIcon size={22} />{tx('松手就发给{0}看', persona.name)}</div>}
    {!main && thread.data && <div className="border-b border-line">
      <div className="mx-auto flex h-11 w-full max-w-[680px] items-center gap-2 px-3 md:px-8">
        <button onClick={() => go('/')} aria-label={tx('回主聊')} title={tx('回主聊')} className="press -ml-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"><ChevronLeft size={18} /></button>
        {external && <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sunken text-muted"><SourceIcon source={current!.source} size={13} /></span>}
        <h1 className="min-w-0 shrink truncate font-display text-[15px] font-semibold">{title}</h1>
        <span className="min-w-0 flex-1 truncate text-xs text-faint">{external ? SOURCE_LABEL[current!.source] ?? current!.source : [tx('侧聊'), sideStatus].filter(Boolean).join(' · ')}</span>
        {current?.meta.url ? <a href={current.meta.url} target="_blank" rel="noreferrer" className="press flex shrink-0 items-center gap-1 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg"> {tx('在')} {SOURCE_LABEL[current.source] ?? current.source} {tx('打开')} <ExternalLink size={12} /></a>
          : !external && (made ? <a href="#/library" className="shrink-0 text-xs text-muted hover:text-fg">{tx('{0} 个成果 ›', made)}</a> : <span className="shrink-0 text-xs text-faint max-sm:hidden">{tx('做完了就收进成果')}</span>)}
      </div>
    </div>}
    {noRouter && !(main && empty && onboarding.step) && <div className="mx-auto mt-4 w-full max-w-3xl px-4 md:px-6"><div className="anim-rise flex items-center gap-3 rounded-2xl bg-sunken px-4 py-3 text-sm">
      <AlertTriangle size={16} className="shrink-0 text-warn" />
      <span className="flex-1">{tx('还没有配置模型')}</span>
      <a className="press shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-ink-fg" href="#/settings/providers">{tx('去设置')}</a>
    </div></div>}
    <div className="relative min-h-0 flex-1">
    {finding && <FindBar root={scrollRef} deps={messages.length} onClose={() => setFinding(false)} />}
    <div ref={scrollRef} data-chat-scroll onScroll={onScroll} className="h-full overflow-y-auto">
      {main && empty && onboarding.step ? <Onboarding step={onboarding.step} next={onboarding.next} /> : empty ? <Welcome onSend={t => void send(t)} disabled={Boolean(noRouter)} main={Boolean(main)} /> :
        <div className="mx-auto max-w-[680px] px-4 pt-4 pb-4 md:px-8">
          {messages.map((m, i) => m.role === 'system' ? <Compacted key={m.id} m={m} /> : <div key={m.id} className={cx(i > 0 && (messages[i - 1]!.role === m.role ? 'mt-1.5' : 'mt-4'))}>
            <When m={m} prev={messages[i - 1]} name={persona.name} />
            {editing === m.id ? <EditBox m={m} onCancel={() => setEditing(null)} onSave={content => { setEditing(null); void act(`/messages/${m.id}/edit`, { content }) }} />
              : <Item m={m} fresh={m.createdAt > mountedAt} name={persona.name}
              tapback={m.role !== 'user' || m.meta.source && m.meta.source !== 'webchat' ? undefined : m.meta.tapback}
              actions={{
                quote: () => { setQuote(m); inputRef.current?.focus() },
                edit: () => startEdit(m),
                recall: () => { recalled.current.set(m.id, m.content); void act(`/messages/${m.id}/recall`) },
                regenerate: () => void act(`/messages/${m.id}/regenerate`),
                reedit: () => { const t = recalled.current.get(m.id); if (t) { setText(t); inputRef.current?.focus() } },
                canReedit: recalled.current.has(m.id),
              }} />}
          </div>)}
          {draft && <div className="mt-1.5"><Bubble fresh><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.text}</ReactMarkdown><span className="caret" /></div></Bubble></div>}
          {busy && <div className="mt-4"><Bubble fresh><Typing /></Bubble></div>}
          {learned.map(l => <div key={l.id} className="anim-rise mt-2"><LearnedNote l={l} name={persona.name} onUndone={() => setLearned(v => v.filter(x => x.id !== l.id))} /></div>)}
          {asks.map(t => <div key={t.id} className="anim-rise mt-2 max-w-[440px]"><NeedsYou t={t} onLearned={l => setLearned(v => [...v, l])} onAnswer={(text, ticketId) => send(text, ticketId)} onEdit={v => { setText(v); requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(v.length, v.length) } }) }} /></div>)}
        </div>}
    </div>
    {behind && <button onClick={() => toBottom(true)} className="anim-pop press absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-ink-fg shadow-lg"><ArrowDown size={13} />{tx('新消息')}</button>}
    </div>
    {error && <div className="mx-auto w-full max-w-3xl px-4 md:px-6"><div className="anim-rise rounded-2xl bg-danger/10 px-4 py-2.5 text-sm text-danger">{error}</div></div>}
    {note && <div className="mx-auto w-full max-w-3xl px-4 md:px-6"><div className="anim-rise rounded-2xl bg-sunken px-4 py-2.5 text-sm text-muted">{note}</div></div>}
    <Composer text={text} setText={setText} inputRef={inputRef} onSend={value => send(value)} disabled={Boolean(noRouter)} placeholder={files.length ? tx('再说点什么…') : tx('跟{0}说…', persona.name)}
      files={files} onFiles={addFiles} onRemoveFile={removeFile} onCompact={id && said.length ? () => void compact() : undefined}
      top={quote ? <QuoteBar m={quote} name={persona.name} onClear={() => setQuote(null)} /> : undefined} />
  </div>
}

const TYPING: [number, number][][] = [[[0, 0]], [[1, 0]], [[2, 0]], []]
/** The typing bubble's three dots light up in turn. */
function Typing() {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  return <div role="status" aria-label={tx('正在输入')} className="flex h-6 items-center">
    <MotionGrid gridSize={[3, 1]} frames={TYPING} duration={220} animate={!still} className="gap-1"><MotionGridCells className="typing-cell" /></MotionGrid>
  </div>
}

/** "今天 14:02" over a message that follows a pause; "· 糯糯先开口" when it spoke first. */
function When({ m, prev, name }: { m: Message; prev?: Message; name: string }) {
  if (prev && m.createdAt - prev.createdAt < 15 * 60_000) return null
  const d = new Date(m.createdAt), now = new Date()
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  const date = days === 0 ? tx('今天') : days === 1 ? tx('昨天') : d.getFullYear() === now.getFullYear() ? tx('{0} 月 {1} 日', d.getMonth() + 1, d.getDate()) : d.toLocaleDateString(locale)
  const first = Boolean(prev) && m.role === 'assistant' && !m.meta.source
  return <div className="pt-2 pb-3 text-center text-[11px] text-faint tabular-nums">{date} {time}{first && tx(' · {0}先开口', name)}</div>
}

const FIRST: [LucideIcon, string][] = [[Tag, tx('帮我盯一个东西的价格')], [Bell, tx('每周五提醒我写周报')], [Plane, tx('帮我规划一次旅行')]]
const SIDE: [LucideIcon, string][] = [[Plane, tx('规划一次旅行')], [FileText, tx('写一份报告')], [Scale, tx('比较几款降噪耳机')]]

/**
 * An empty conversation (Figma v6, 20c). The main chat's first open: 糯糯 hops in, its hello writes itself in one
 * character at a time, three suggestions fade in after; pressing one sends it. A new side chat gets the same, quieter.
 */
function Welcome({ onSend, disabled, main }: { onSend(text: string): void; disabled: boolean; main: boolean }) {
  const persona = usePersona()
  return <div className="flex min-h-full flex-col items-center justify-center px-4 py-10 text-center md:px-6">
    <Avatar persona={persona} size={main ? 104 : 80} mood="happy" track className="welcome-hop text-fg" />
    <h2 className="mt-5 font-display text-[clamp(26px,4vw,32px)] leading-tight font-semibold">
      <SplittingText type="chars" text={main ? tx('你好，我是{0}', persona.name) : tx('新侧聊')} stagger={0.06} delay={250}
        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }} />
    </h2>
    <p className="feed-in mt-2.5 text-sm text-muted text-pretty" style={{ animationDelay: '650ms' }}>
      {main ? tx('先认识一下？说说你最近在忙什么，我会记下来，以后帮你盯着。') : tx('一件独立的小事放在这里，做完了就收进成果。')}
    </p>
    <div className="mt-7 flex max-w-xl flex-wrap justify-center gap-2.5">
      {(main ? FIRST : SIDE).map(([Icon, t], i) => <button key={t} disabled={disabled} onClick={() => onSend(t)} style={{ animationDelay: `${800 + i * 90}ms` }}
        className="feed-in press flex items-center gap-2 rounded-full border border-line bg-panel px-4 py-2 text-sm hover:border-faint disabled:opacity-50">
        <Icon size={15} className="text-muted" />{t}</button>)}
    </div>
    {main && <p className="feed-in mt-8 text-xs text-faint" style={{ animationDelay: '1100ms' }}>{tx('你说的都只存在这台电脑上。花钱、发消息、改日程，我都会先问你。')}</p>}
  </div>
}


/** 糯糯's messages: grey bubbles, no face beside them. */
function Bubble({ fresh, aside, children }: { fresh?: boolean; aside?: React.ReactNode; children: React.ReactNode }) {
  return <div className={cx('flex items-center gap-2', fresh && 'anim-rise')}>
    <div className="selectable min-w-0 max-w-[85%] rounded-[20px] bg-bubble px-4 py-2.5">{children}</div>
    {aside}
  </div>
}

type Actions = { quote(): void; edit(): void; recall(): void; regenerate(): void; reedit(): void; canReedit: boolean }
const RECALL_MS = 10 * 60_000

function Item({ m, fresh, tapback, name, actions }: { m: Message; fresh: boolean; tapback?: string | undefined; name: string; actions: Actions }) {
  const external = m.role === 'user' && m.meta.source && m.meta.source !== 'webchat'
  // A routine firing is the owner's own standing request: a quiet line, not a message from someone.
  if (external && m.meta.source === 'cron') return <div className={cx('flex items-center gap-3 py-2 text-xs text-faint', fresh && 'anim-fade')}>
    <span className="h-px flex-1 bg-line" /><span className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1"><AlarmClock size={12} />{m.content.split('\n')[0]!.replace(/^⏰\s*/, '').replace(/（.*?）：?$/, '')}</span><span className="h-px flex-1 bg-line" />
  </div>
  if (external) return <div className={cx('flex gap-2.5', fresh && 'anim-rise')}>
    <div className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-xl bg-sunken text-muted"><SourceIcon source={m.meta.source} size={14} /></div>
    <div className="min-w-0 flex-1 rounded-[22px] rounded-tl-md border border-line bg-card px-4 py-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span className="font-medium text-fg">{m.meta.source === 'cron' ? tx('定时任务') : m.meta.actor}</span>
        {m.meta.human === false && <span className="rounded-full bg-sunken px-1.5 text-[10px]">bot</span>}
        <span className="text-faint tabular-nums">{new Date(m.createdAt).toLocaleString()}</span>
        {m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent" aria-label={tx('打开原文')}><ExternalLink size={12} /></a>}
      </div>
      <div className="prose-chat text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
    </div>
  </div>
  if (m.role === 'user' && m.meta.recalled) return <div className="anim-fade py-1 text-center text-xs text-faint"> {tx('你撤回了一条消息')}{actions.canReedit && <> · <button onClick={actions.reedit} className="text-muted hover:text-fg">{tx('重新编辑')}</button></>}
  </div>
  if (m.role === 'user') return <div className={cx('msg flex flex-col items-end', fresh && 'anim-send')}>
    {m.meta.attachments?.length > 0 && <SentFiles files={m.meta.attachments} />}
    {(m.content || m.meta.quote) && <div className="flex items-center justify-end gap-2 self-stretch">
      <MsgActions m={m} actions={actions} />
      <div className="relative max-w-[85%]">
        <div className="selectable rounded-[20px] bg-accent px-4 py-2.5 text-[15px] whitespace-pre-wrap text-accent-fg">
          {m.meta.quote && <QuoteInBubble quote={m.meta.quote} name={name} />}{m.content}</div>
        {tapback && <Tapback key={tapback} emoji={tapback} />}
      </div>
    </div>}
  </div>
  return <div className="msg space-y-1.5">
    <Bubble fresh={fresh} aside={<MsgActions m={m} actions={actions} />}><div className="prose-chat text-[15px]"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div></Bubble>
    {m.meta.card && <div className={cx(fresh && 'anim-rise')}><ChatCard card={m.meta.card} /></div>}
    {m.meta.open && <OpenChip open={m.meta.open} />}
    {m.meta.error && <div className="flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} />{m.meta.error}</div>}
    {m.meta.via && <div className="flex items-center gap-1 text-[11px] text-faint">
      <SourceIcon source={m.meta.via} size={11} />
      {m.meta.delivery === 'sent' ? <>{tx('已发到')} {SOURCE_LABEL[m.meta.via] ?? m.meta.via}{m.meta.url && <a href={m.meta.url} target="_blank" rel="noreferrer" className="text-accent" aria-label={tx('打开')}><ArrowUpRight size={11} /></a>}</>
        : m.meta.delivery === 'pending' ? tx('发送中…')
        : <span className="text-danger">{m.meta.delivery === 'dropped' ? tx('没能发出去') : tx('发送失败，稍后重试')}{m.meta.deliveryError ? `：${m.meta.deliveryError}` : ''}</span>}
    </div>}
  </div>
}

const TAPBACK_LABEL: Record<string, string> = { '👌': tx('收到'), '👀': tx('在看'), '😂': tx('哈哈'), '❤️': tx('谢谢'), '👍': tx('好') }
const PAGE_OPENED = Date.now()
/** 糯糯's reaction, chosen by the model, sitting on the bottom-right corner (the end) of the owner's bubble. It zooms in, with a small burst when it lands live. */
function Tapback({ emoji }: { emoji: string }) {
  const [live] = useState(() => Date.now() - PAGE_OPENED > 1500)
  return <Particles key={emoji} animate={live} style={{ position: 'absolute' }} className="-right-2 -bottom-3.5">
    <span title={TAPBACK_LABEL[emoji]} aria-label={TAPBACK_LABEL[emoji]}
      className="tapback relative flex h-7 min-w-9 items-center justify-center rounded-full border-2 border-bg bg-bubble px-1.5 text-[14px] leading-none select-none">{emoji}</span>
    {live && <ParticlesEffect count={7} radius={24} spread={360} duration={0.7} sideOffset={-14} className="size-1.5 rounded-full bg-accent" />}
  </Particles>
}

/**
 * Beside a message on hover (Figma section 25, B): the owner's own can be edited or taken back for ten minutes; any
 * message can be answered (quoted) or copied; 糯糯's can be answered again.
 */
function MsgActions({ m, actions }: { m: Message; actions: Actions }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { void navigator.clipboard?.writeText(m.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) }
  const mine = m.role === 'user' && (!m.meta.source || m.meta.source === 'webchat')
  const recent = mine && Date.now() - m.createdAt < RECALL_MS
  const btn = (label: string, icon: React.ReactNode, run: () => void) => <button onClick={run} aria-label={label} title={label}
    className="press flex size-6 items-center justify-center rounded-md hover:bg-sunken hover:text-fg">{icon}</button>
  const time = <span className="px-0.5 tabular-nums">{new Date(m.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</span>
  return <div className="msg-actions flex h-6 shrink-0 items-center gap-0.5 text-[11px] text-faint">
    {mine && time}
    {recent && m.content && btn(tx('编辑'), <Pencil size={13} />, actions.edit)}
    {btn(tx('回复这条'), <Reply size={13} />, actions.quote)}
    {m.content && btn(tx('复制'), copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />, copy)}
    {recent && btn(tx('撤回'), <Undo2 size={13} />, actions.recall)}
    {m.role === 'assistant' && btn(tx('重新回答'), <RotateCcw size={13} />, actions.regenerate)}
    {!mine && time}
  </div>
}

/** Editing a sent message in place: 改好了，发 takes the old one back and sends the corrected text. */
function EditBox({ m, onCancel, onSave }: { m: Message; onCancel(): void; onSave(text: string): void }) {
  const [value, setValue] = useState(m.content)
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 220)}px` }, [value])
  useEffect(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(value.length, value.length) } }, [])
  const ok = value.trim() && value.trim() !== m.content
  return <div className="ml-auto max-w-[85%]">
    <div className="rounded-[20px] border-2 border-accent bg-panel px-4 pt-2.5 pb-2">
      <textarea ref={ref} value={value} onChange={e => setValue(e.target.value)} aria-label={tx('改这条消息')} rows={1}
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (ok) onSave(value.trim()) } }}
        className="w-full min-w-[260px] resize-none bg-transparent text-[15px] outline-none" />
      <div className="mt-1 flex justify-end gap-1.5">
        <button onClick={onCancel} className="press h-8 rounded-full border border-line px-3.5 text-[13px] hover:border-faint">{tx('取消')}</button>
        <button onClick={() => ok && onSave(value.trim())} disabled={!ok} className="press h-8 rounded-full bg-ink px-3.5 text-[13px] font-medium text-ink-fg disabled:opacity-40">{tx('改好了，发')}</button>
      </div>
    </div>
    <p className="mt-1 text-right text-[11px] text-faint">{tx('改了以后，它按新的说法重新做；之前那条作废')}</p>
  </div>
}

/**
 * The input bar (Figma v6): one rounded line with + on the left and the mic on the right; once there is text, the mic
 * becomes the send button. Never blocks on a message in flight: the owner may type several in a row.
 */
function Composer({ text, setText, inputRef, onSend, disabled, placeholder, files, onFiles, onRemoveFile, onCompact, top }: { text: string; setText(v: string): void; inputRef: React.RefObject<HTMLTextAreaElement | null>; onSend(text: string): void; disabled: boolean; placeholder: string
  files: Pending[]; onFiles(files: FileList | File[]): void; onRemoveFile(key: string): void; onCompact?: (() => void) | undefined; top?: React.ReactNode }) {
  const prefs = usePrefs()
  // 设置 → 语音 → 说完自动发送: a pause of 1.5 s sends what was heard.
  const voice = useVoice(heard => setText(heard), heard => {
    if (!prefs.autoSend || !heard.trim() || disabled) return
    voice.stop(); onSend(heard.trim()); setText('')
  })
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])
  const sendable = files.some(f => f.upload) && files.every(f => f.upload || f.error)
  const submit = () => {
    const value = text.trim()
    if ((!value && !sendable) || disabled) return
    voice.stop()
    onSend(value)
    setText('')
  }
  const ready = (Boolean(text.trim()) || sendable) && !disabled
  const picker = useRef<HTMLInputElement>(null)
  const prefill = (t: string) => { setText(t); requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length) } }) }
  return <div className="mx-auto w-full max-w-[680px] px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] md:px-8 md:pb-5">
    <input ref={picker} type="file" multiple hidden onChange={e => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = '' }} />
    <div className={cx('rounded-[26px] border bg-panel p-1.5 shadow-[0_6px_24px_-12px_rgb(0_0_0/0.14)] transition-[border-color] duration-200',
      voice.listening ? 'border-accent' : 'border-line focus-within:border-faint')}>
      {top}
      <PendingFiles files={files} onRemove={onRemoveFile} />
    <div className="flex items-end gap-1">
      {voice.listening ? <Wave /> : <PlusMenu onPick={prefill} onFile={() => picker.current?.click()} onCompact={onCompact} />}
      <textarea ref={inputRef} value={text} rows={1} autoFocus placeholder={disabled ? tx('先接上一个模型，才能聊') : voice.listening ? tx('在听…') : placeholder}
        disabled={disabled} onChange={e => setText(e.target.value)} aria-label={tx('消息')}
        onPaste={e => { const pasted = Array.from(e.clipboardData.files); if (pasted.length) { e.preventDefault(); onFiles(pasted) } }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-1 py-2 text-[15px] outline-none placeholder:text-faint focus-visible:outline-none" />
      {voice.listening && <Elapsed />}
      {voice.listening ? <button onClick={voice.stop} aria-label={tx('停止')} title={tx('停止')} className="anim-pop press flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg"><Square size={13} fill="currentColor" /></button>
        : ready ? <button onClick={submit} aria-label={tx('发送')} className="anim-pop press flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg"><ArrowUp size={18} /></button>
        : !prefs.voiceInput ? <button disabled aria-label={tx('发送')} className="flex size-9 shrink-0 items-center justify-center rounded-full text-faint opacity-60"><ArrowUp size={18} /></button>
        : <button onClick={voice.toggle} disabled={disabled || !voice.supported} aria-label={voice.listening ? tx('停止') : tx('说话')} aria-pressed={voice.listening}
          title={voice.supported ? (voice.listening ? tx('停止') : tx('说话')) : tx('这里用不了语音输入')}
          className={cx('press relative flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-40', voice.listening ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg')}>
          {voice.listening && <span className="ping-soft absolute inset-0 rounded-full bg-accent" aria-hidden />}
          <Mic size={18} className="relative" /></button>}
    </div>
    </div>
  </div>
}

/** While you speak: sound bars that move on the left of the input (where + was). */
function Wave() {
  return <span aria-hidden className="flex h-9 shrink-0 items-center gap-[3px] pr-1 pl-3 text-accent">
    {[0.45, 0.8, 1, 0.6, 0.9, 0.5, 0.7].map((h, i) => <span key={i} className="wave-bar w-[2.5px] rounded-full bg-current" style={{ height: `${Math.round(h * 18)}px`, animationDelay: `${i * 90}ms` }} />)}
  </span>
}

/** How long you have been speaking, 0:04. */
function Elapsed() {
  const [start] = useState(Date.now)
  const [now, setNow] = useState(start)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t) }, [])
  const s = Math.floor((now - start) / 1000)
  return <span className="flex h-9 shrink-0 items-center px-2 text-xs text-faint tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

/** + in the input bar: begin a reminder or a watch in your own words. A new side chat has one button, at the bottom of the sidebar. */
function PlusMenu({ onPick, onFile, onCompact }: { onPick(text: string): void; onFile(): void; onCompact?: (() => void) | undefined }) {
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
    <button onClick={() => setOpen(v => !v)} aria-label={tx('更多')} aria-expanded={open}
      className={cx('press flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg', open && 'bg-sunken text-fg')}>
      <Plus size={19} className={cx('transition-transform duration-200 ease-out', open && 'rotate-45')} /></button>
    {open && <div role="menu" className="anim-menu absolute bottom-11 left-0 z-20 w-48 rounded-2xl border border-line bg-panel p-1 shadow-xl [transform-origin:bottom_left]">
      {item(<Paperclip size={15} className="text-muted" />, tx('添加文件…'), onFile)}
      {item(<AlarmClock size={15} className="text-muted" />, tx('定时提醒我…'), () => onPick(tx('每天早上 9 点提醒我')))}
      {item(<ArrowUpRight size={15} className="text-muted" />, tx('帮我盯着…'), () => onPick(tx('帮我盯着')))}
      {onCompact && <><div className="mx-2 my-1 h-px bg-line" />{item(<Layers size={15} className="text-muted" />, tx('整理一下前面的'), onCompact)}</>}
    </div>}
  </div>
}

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: (() => void) | null }
/** Voice input through the browser's speech recognition, where there is one. */
function useVoice(onText: (text: string) => void, onPause?: (text: string) => void) {
  const Impl = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition as (new () => Recognition) | undefined
  const rec = useRef<Recognition | null>(null)
  const [listening, setListening] = useState(false)
  const latest = useRef(onText)
  latest.current = onText
  const paused = useRef(onPause)
  paused.current = onPause
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => rec.current?.stop(), [])
  const stop = () => { rec.current?.stop() }
  const toggle = () => {
    if (!Impl) return
    if (listening) return stop()
    const r: Recognition = new Impl()
    r.lang = getPrefs().voiceLang; r.interimResults = true; r.continuous = true
    r.onresult = e => {
      const heard = Array.from(e.results as ArrayLike<any>).map(x => x[0].transcript).join('')
      latest.current(heard)
      clearTimeout(pause.current)
      pause.current = setTimeout(() => paused.current?.(heard), 1_500)
    }
    r.onend = () => { clearTimeout(pause.current); setListening(false); rec.current = null }
    r.onerror = () => { setListening(false); rec.current = null }
    rec.current = r
    try { r.start(); setListening(true) } catch { setListening(false) }
  }
  return { supported: Boolean(Impl), listening, toggle, stop }
}
