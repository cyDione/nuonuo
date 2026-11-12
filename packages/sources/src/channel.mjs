// The Channel layer (docs/12-channels.md): everything chat apps have in common, written once. An adapter declares what
// its app can do (`capabilities`), connects, and translates messages in and out; this layer turns it into an ordinary
// SourceKind and handles who may ask for work, when the assistant is being addressed, topics and /new, splitting and
// plain-text downgrades, approvals asked in the chat, reconnecting and health.
//
// Plain JavaScript with no imports, so the plugin sandbox (plugin-runner.mjs) can load it without a build step.
// Types: channel.d.mts.

/** An error an adapter throws: `gone` = that chat can never receive messages again; `fatal` = do not retry (bad token). */
export class ChannelError extends Error {
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ChannelError'
    if (opts.status !== undefined) this.status = opts.status
    this.gone = Boolean(opts.gone)
    this.fatal = Boolean(opts.fatal)
  }
}

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve()
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

// Thread ids: `<source>:<chat>[:<topic>]:<epoch>`. Colons inside platform ids are escaped so the id splits cleanly.
const enc = s => String(s).replace(/%/g, '%25').replace(/:/g, '%3A')
const dec = s => s.replace(/%3A/g, ':').replace(/%25/g, '%')

export function channelThread(source, chat, topic, epoch = 0) {
  return `${source}:${enc(chat)}${topic !== undefined && topic !== null && topic !== '' ? `:${enc(topic)}` : ''}:${epoch}`
}

export function parseChannelThread(source, threadId) {
  if (typeof threadId !== 'string') return undefined
  const parts = threadId.split(':')
  if (parts[0] !== source || parts.length < 3 || parts.length > 4 || !/^\d+$/.test(parts.at(-1))) return undefined
  return { chat: dec(parts[1]), ...(parts.length === 4 ? { topic: dec(parts[2]) } : {}) }
}

/** Markdown the model writes, turned into plain text for apps that show it literally. */
export function plainText(md) {
  return String(md)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '$1 $2')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => (text === url ? url : `${text} (${url})`))
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Splits text into pieces of at most `max` characters, at a paragraph, then a line, then a space when it can. */
export function splitText(text, max) {
  const out = []
  let rest = String(text)
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = window.lastIndexOf('\n\n')
    if (cut < max * 0.5) cut = window.lastIndexOf('\n')
    if (cut < max * 0.5) cut = window.lastIndexOf(' ')
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest || !out.length) out.push(rest)
  return out
}

/**
 * Runs one WebSocket connection: resolves when it closes after opening, rejects when it fails before opening, and closes
 * it when the source stops. Messages are handled one at a time, in order.
 */
export function runSocket(socket, handlers, signal) {
  return new Promise((resolve, reject) => {
    let opened = false
    let chain = Promise.resolve()
    const stop = () => { try { socket.close(1000) } catch {} }
    if (signal?.aborted) { stop(); resolve(); return }
    signal?.addEventListener('abort', stop, { once: true })
    socket.addEventListener('open', () => {
      opened = true
      try { handlers.open?.() } catch (error) { reject(error); stop() }
    })
    socket.addEventListener('message', event => {
      // Answers to our own requests skip the queue: a handler may be waiting for one (sending a reply over the socket).
      try { if (handlers.immediate?.(event.data)) return } catch (error) { handlers.error?.(error); return }
      chain = chain.then(() => handlers.message(event.data)).catch(error => handlers.error?.(error))
    })
    socket.addEventListener('error', event => { if (!opened) reject(new ChannelError(`连接失败：${event?.message ?? 'WebSocket error'}`)) })
    socket.addEventListener('close', event => {
      signal?.removeEventListener('abort', stop)
      handlers.close?.(event)
      if (opened || signal?.aborted) resolve()
      else reject(new ChannelError(`连接被关闭（${event?.code ?? ''}）`))
    })
  })
}

const YES = /^(同意|批准|可以|好的?|1|y|yes|ok|approve)$/i
const NO = /^(拒绝|不同意|不行|不要|2|n|no|deny)$/i
const BUTTON = /^nuonuo:apv:(yes|no):([\w-]{1,80})$/

const DEFAULT_CAPABILITIES = { inbound: 'longpoll', threads: 'none', groups: { mention: true, replyToBot: true }, format: 'plain', maxLength: 4000, edit: false, buttons: false, typing: false, files: { in: false, out: false }, proactive: true }

/** Builds `defineChannel` with the host's zod (the sandbox hands plugins the same one). */
export function makeDefineChannel(z) {
  return function defineChannel(spec) {
    if (!spec || typeof spec.id !== 'string' || typeof spec.send !== 'function') throw new Error('defineChannel 需要 id 和 send')
    if (typeof spec.connect !== 'function' && typeof spec.webhook !== 'function') throw new Error('defineChannel 需要 connect（主动连上去）或 webhook（软件回调）')
    const id = spec.id
    const title = spec.title ?? id
    const caps = { ...DEFAULT_CAPABILITIES, ...(spec.capabilities ?? {}), groups: { ...DEFAULT_CAPABILITIES.groups, ...(spec.capabilities?.groups ?? {}) }, files: { ...DEFAULT_CAPABILITIES.files, ...(spec.capabilities?.files ?? {}) } }
    if (caps.edit && typeof spec.edit !== 'function') throw new Error(`${id}: capabilities.edit 需要 edit()`)
    const base = spec.config ?? z.object({})
    const schema = base.extend({
      allowed: z.array(z.string().trim().min(1)).default([]),
      approvals: z.boolean().default(false),
    })
    const idHint = spec.idHint ?? `你的 ${title} ID`
    const fields = [
      ...(spec.fields ?? []),
      { key: 'allowed', type: 'list', label: '允许派活的账号', placeholder: idHint, hint: `每行一个。其他人发来的消息会被忽略。不知道自己的 ID？给机器人发 /start。` },
      { key: 'approvals', type: 'switch', label: '允许在这里回答「要不要做」', hint: caps.buttons ? `需要确认时发来「同意 / 拒绝」按钮，只有上面的账号能点。` : `需要确认时发来一条消息，允许的账号回复「同意」或「拒绝」。` },
    ]

    // One io per source context: adapters may cache their session on it (a WeakMap keyed by io).
    const ios = new WeakMap()
    const ioOf = ctx => {
      let io = ios.get(ctx)
      if (io) return io
      io = {
        source: id,
        get config() { return ctx.config },
        signal: ctx.signal,
        state: ctx.state,
        secret: ctx.secret,
        log: (...args) => ctx.log(...args),
        facts: facts => ctx.facts(facts),
        online: detail => ctx.health('ok', detail ?? '在线'),
        sleep: ms => sleep(ms, ctx.signal),
        socket: url => {
          if (typeof globalThis.WebSocket !== 'function') throw new ChannelError('这个 Node 版本没有 WebSocket', { fatal: true })
          const ws = new globalThis.WebSocket(url)
          ws.binaryType = 'arraybuffer'
          return ws
        },
        runSocket: (socket, handlers) => runSocket(socket, { error: error => ctx.log(`处理消息出错：${error?.message ?? error}`), ...handlers }, ctx.signal),
        message: m => handle(ctx, m),
        action: a => handleAction(ctx, a),
      }
      ios.set(ctx, io)
      return io
    }

    const usernameOf = (ctx, actor) => ctx.state.get(`user:${actor}`)
    const allowed = (ctx, actor) => {
      const username = usernameOf(ctx, actor)
      return (ctx.config.allowed ?? []).some(a => a === actor || (username && a.replace(/^@/, '').toLowerCase() === String(username).toLowerCase()))
    }
    const epochOf = (ctx, chat) => ctx.state.get(`epoch:${chat}`) ?? 0
    const threadOf = (ctx, chat, topic) => channelThread(id, chat, topic, epochOf(ctx, chat))
    const label = from => (from?.username ? `@${from.username}` : from?.name ?? String(from?.id ?? ''))

    async function say(ctx, target, text) {
      try { await spec.send(ioOf(ctx), target, { text }) } catch (error) { ctx.log(`回复失败：${error?.message ?? error}`) }
    }

    async function answer(ctx, threadId, approvalId, approve, from, target) {
      if (!ctx.config.approvals || !allowed(ctx, String(from.id))) return '没有权限回答这个确认'
      if (typeof ctx.approvals?.answer !== 'function') return '这个版本的糯糯还不能在这里回答确认'
      try {
        await ctx.approvals.answer(approvalId, approve, `${title} ${label(from)}`)
      } catch (error) {
        const why = error?.message ?? String(error)
        if (target) await say(ctx, target, `没能处理：${why}`)
        return why
      }
      if (threadId) ctx.state.set(`apv:${threadId}`, null)
      return approve ? '已同意' : '已拒绝'
    }

    async function handle(ctx, m) {
      const from = m.from ?? {}
      if (from.self) return
      const actor = String(from.id)
      if (from.username) ctx.state.set(`user:${actor}`, from.username)
      const chat = String(m.chat.id)
      const target = { chat, ...(m.topic ? { topic: String(m.topic) } : {}) }
      const text = String(m.text ?? '').trim()
      const ok = allowed(ctx, actor)
      if (/^\/start(@\S+)?(\s|$)/.test(text)) {
        await say(ctx, target, ok ? (spec.welcome ?? '你好！直接发消息给我就行，我会在你的电脑上处理。/new 开始一个新话题。')
          : `这是一个私人智能体。如果你是它的主人，请把你的 ${title} ID ${actor} 加到 设置 → 来源 → ${title} 的允许列表里。`)
        return
      }
      if (/^\/new(@\S+)?$/.test(text)) {
        if (!ok) return
        ctx.state.set(`epoch:${chat}`, Date.now())
        await say(ctx, target, '好的，开始一个新话题。')
        return
      }
      const threadId = threadOf(ctx, chat, target.topic)
      const pending = ctx.state.get(`apv:${threadId}`)
      if (pending && ok && ctx.config.approvals && (YES.test(text) || NO.test(text))) {
        await answer(ctx, threadId, pending, YES.test(text), from, target)
        return
      }
      const addressed = m.chat.type === 'private' || (caps.groups.mention && Boolean(m.mentioned)) || (caps.groups.replyToBot && Boolean(m.replyToBot))
      const files = (m.files ?? []).map(f => (f.kind === 'image' ? '[图片]' : f.kind === 'voice' ? '[语音]' : `[文件 ${f.name ?? ''}]`.replace(' ]', ']'))).join(' ')
      const chatName = m.chat.type === 'private' ? `私聊 ${label(from)}` : m.chat.title ?? chat
      ctx.engine.receive({
        id: `${id}:${enc(chat)}:${m.id}`, source: id, threadId, actor, human: !from.bot, addressed,
        text: [text, files].filter(Boolean).join(' ') || '（空消息）', at: m.at ?? Date.now(), ...(m.url ? { url: m.url } : {}),
        meta: { chatId: m.chat.id, messageId: m.id, from: label(from) },
        thread: { title: `${title} · ${chatName}`, meta: { chatId: m.chat.id } },
      })
    }

    async function handleAction(ctx, a) {
      const match = BUTTON.exec(String(a?.data ?? ''))
      if (!match) return undefined
      const from = a.from ?? {}
      if (from.username) ctx.state.set(`user:${String(from.id)}`, from.username)
      const chat = String(a.chat?.id ?? a.chat ?? '')
      const target = chat ? { chat, ...(a.topic ? { topic: String(a.topic) } : {}) } : undefined
      return answer(ctx, chat ? threadOf(ctx, chat, target?.topic) : undefined, match[2], match[1] === 'yes', from, undefined)
    }

    const render = text => (caps.format === 'plain' ? plainText(text) : String(text))

    async function send(ctx, message) {
      const target = parseChannelThread(id, message.threadId)
      if (!target) return 'gone'
      const io = ioOf(ctx)
      try {
        const approval = message.approval
        if (approval && approval.state !== 'pending') {
          // Answered (here or elsewhere): mark the card and take its buttons away.
          const card = ctx.state.get(`apvmsg:${approval.id}`)
          if (ctx.state.get(`apv:${message.threadId}`) === approval.id) ctx.state.set(`apv:${message.threadId}`, null)
          if (card && caps.edit) await spec.edit(io, target, card.id, { text: `${card.text}\n\n${render(message.text)}` })
          ctx.state.set(`apvmsg:${approval.id}`, null)
          return {}
        }
        let buttons
        let text = render(message.text)
        if (approval) {
          ctx.state.set(`apv:${message.threadId}`, approval.id)
          if (caps.buttons) buttons = [{ id: `nuonuo:apv:yes:${approval.id}`, label: '同意', style: 'primary' }, { id: `nuonuo:apv:no:${approval.id}`, label: '拒绝', style: 'danger' }]
          else text = `${text}\n\n回复「同意」或「拒绝」。`
        }
        const chunks = splitText(text, Math.max(200, caps.maxLength))
        let last
        for (let i = 0; i < chunks.length; i++) {
          const final = i === chunks.length - 1
          last = await spec.send(io, target, { text: chunks[i], ...(final && buttons ? { buttons } : {}) })
        }
        if (approval && last?.id) ctx.state.set(`apvmsg:${approval.id}`, { id: last.id, text: chunks.at(-1) })
        return last?.url ? { url: last.url } : {}
      } catch (error) {
        if (error?.gone) return 'gone'
        throw error
      }
    }

    function start(ctx) {
      const io = ioOf(ctx)
      // A webhook-only app has nothing to connect to: messages arrive through webhook().
      if (typeof spec.connect !== 'function') { ctx.health('ok', '等待回调'); return () => {} }
      let stopped = false
      void (async () => {
        let failures = 0
        while (!stopped && !ctx.signal.aborted) {
          try {
            await spec.connect(io)
            failures = 0
            if (!stopped && !ctx.signal.aborted) await sleep(1_000, ctx.signal)
          } catch (error) {
            if (stopped || ctx.signal.aborted) break
            failures++
            const status = error?.status
            if (error?.fatal || failures >= 3 || status === 401 || status === 403) ctx.health('error', error?.message ?? String(error))
            await sleep(Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)), ctx.signal)
          }
        }
      })()
      return () => { stopped = true }
    }

    const formatNote = caps.format === 'plain' ? 'shown as plain text, no Markdown' : caps.format === 'html' ? 'basic formatting works' : 'Markdown works'
    const passThrough = ['icon', 'actions', 'authorized', 'http', 'routerPrompt', 'routerTools', 'workerPrompt', 'workerTools', 'workerEnv', 'writes', 'defaultEnabled']
    return {
      ...Object.fromEntries(passThrough.filter(k => spec[k] !== undefined).map(k => [k, spec[k]])),
      id, title,
      description: spec.description ?? '',
      schema, fields,
      capabilities: caps,
      start,
      // webhook(): the app calls the public URL /plugin/<id>/<path>; the owner-only URL still reaches http().
      ...(typeof spec.webhook === 'function' ? {
        http: (ctx, request, path, info) => info.public ? spec.webhook(ioOf(ctx), request, path, info) : (spec.http ? spec.http(ctx, request, path, info) : Promise.resolve(undefined)),
      } : {}),
      ...(typeof spec.poll === 'function' ? { poll: ctx => spec.poll(ioOf(ctx)) } : {}),
      allowed,
      send,
      threadInfo(_ctx, threadId) {
        const t = parseChannelThread(id, threadId)
        if (!t) return undefined
        return `${title} chat ${t.chat}${t.topic ? ` topic ${t.topic}` : ''} (replies are ${formatNote}; keep them short, a message holds about ${caps.maxLength} characters)`
      },
    }
  }
}
