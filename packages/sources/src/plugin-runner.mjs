// The sandboxed side of a third-party plugin (see plugin-sandbox.ts). The service starts this file in its own Node process
// with the permission model on: it may read and write only the plugin's folder, cannot start programs, threads or native
// addons, and talks to the service only through these messages. Plain JavaScript so it runs without a build step.
//
// argv: <zod entry path> <plugin entry path> <plugin id> <plugin dir>
import { pathToFileURL } from 'node:url'
import { appToken, oauth } from './auth.mjs'
import { ChannelError, makeDefineChannel } from './channel.mjs'

const [zodPath, entry, pluginId, pluginDir] = process.argv.slice(2)
const zodModule = await import(pathToFileURL(zodPath).href)
const z = zodModule.z ?? zodModule.default?.z ?? zodModule.default ?? zodModule

const send = msg => { try { process.send(msg) } catch {} }
const pending = new Map()
let seq = 0
/** Asks the service for something and waits for the answer. */
const ask = (type, body) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); send({ kind: 'ask', id, type, ...body }) })
const tell = (type, body) => send({ kind: 'tell', type, ...body })
const log = (...args) => tell('log', { text: args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()).join(' ') })
console.log = console.info = console.warn = console.error = log

const JSON_SCHEMA = Symbol.for('nuonuo.jsonSchema')
const sdk = {
  apiVersion: 1,
  definePlugin: p => p,
  defineChannel: makeDefineChannel(z),
  ChannelError,
  oauth,
  appToken,
  tool: t => t,
  jsonSchema: schema => ({ [JSON_SCHEMA]: true, jsonSchema: schema }),
  z,
}

const toJsonSchema = schema => {
  if (!schema) return { type: 'object', properties: {} }
  if (schema[JSON_SCHEMA]) return schema.jsonSchema
  try { const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }); delete out.$schema; return out } catch { return { type: 'object', properties: {} } }
}
const toolDefs = tools => Object.fromEntries(Object.entries(tools ?? {}).map(([name, t]) => [name, { description: String(t?.description ?? ''), inputSchema: toJsonSchema(t?.inputSchema ?? t?.parameters) }]))
const runTool = async (tools, name, args) => {
  const t = tools?.[name]
  if (!t || typeof t.execute !== 'function') throw new Error(`没有工具 ${name}`)
  const schema = t.inputSchema ?? t.parameters
  const input = schema && !schema[JSON_SCHEMA] && typeof schema.parse === 'function' ? schema.parse(args) : args
  return await t.execute(input, { toolCallId: '', messages: [] })
}
const refuse = what => { throw new Error(`第三方插件不能使用 ${what}（见 docs/04-plugin-sdk.md 的「插件能用的接口」）`) }
const safe = (f, fallback) => { try { return f() } catch (e) { return fallback } }
const stubTicket = { id: '', title: '', threadId: '', stage: 'working', directory: pluginDir }

// ── The plugin itself ───────────────────────────────────────────────────────
let plugin
let pluginState = {}
const pluginCtx = {
  id: pluginId, dir: pluginDir, log,
  state: { get: k => pluginState[k], set: (k, v) => { pluginState[k] = v; tell('state', { scope: 'plugin', key: k, value: v }) } },
}
/** Per source: its kind, the context it sees, and whether it runs. */
const sources = new Map()
let engineView = { main: '', followed: [], threads: {} }

function sourceCtx(kind, config, state, secrets) {
  const id = kind.id
  const own = threadId => { if (typeof threadId !== 'string' || !threadId.startsWith(`${id}:`)) throw new Error(`插件来源 ${id} 只能使用以 "${id}:" 开头的线程，收到 ${String(threadId)}`) }
  const facade = {
    receive: t => {
      if (t?.source !== id) throw new Error(`插件来源 ${id} 不能以 ${t?.source} 的名义送来消息`)
      own(t.threadId)
      const allowed = typeof kind.allowed === 'function' && t.actor ? safe(() => Boolean(kind.allowed(entry.ctx, t.actor)), false) : false
      tell('receive', { source: id, trigger: t, allowed })
      return { status: 'stored', deliveredTo: [], routed: false }
    },
    followed: () => engineView.followed.filter(f => f.threadId.startsWith(`${id}:`)),
    follow: (ticketId, threadId, k, info) => { own(threadId); tell('follow', { source: id, ticketId, threadId, followKind: k, info }) },
    threadClosed: (threadId, outcome) => { own(threadId); tell('threadClosed', { source: id, threadId, outcome }) },
    mainConversation: () => engineView.main,
    conversationOfThread: threadId => engineView.threads[threadId],
  }
  const abort = new AbortController()
  const entry = { kind, running: false, stop: undefined, abort, state, secrets, ctx: undefined }
  entry.ctx = {
    id, config, signal: abort.signal,
    engine: new Proxy(facade, { get: (t, p) => typeof p === 'string' && p in t ? t[p] : typeof p === 'string' ? refuse(`engine.${p}`) : undefined }),
    store: new Proxy({}, { get: (_t, p) => typeof p === 'string' && p !== 'then' ? refuse('store') : undefined }),
    state: { get: k => entry.state[k], set: (k, v) => { entry.state[k] = v; tell('state', { scope: 'source', source: id, key: k, value: v }) } },
    facts: facts => tell('facts', { source: id, facts }),
    health: (status, detail) => tell('health', { source: id, status, detail }),
    log: (...args) => log(`[${id}]`, ...args),
    secret: {
      get: name => entry.secrets[name],
      set: (name, value) => { entry.secrets[name] = String(value); tell('secret', { source: id, name, value: String(value) }) },
      delete: name => { delete entry.secrets[name]; tell('secret', { source: id, name, value: null }) },
    },
    notify: (text, opts) => tell('notify', { source: id, text: String(text), title: opts?.title }),
    saveFile: file => ask('saveFile', { source: id, name: String(file?.name ?? 'file'), mime: file?.mime ? String(file.mime) : undefined, data: Buffer.from(file.bytes).toString('base64') }),
    approvals: { answer: (approvalId, approve, by) => ask('approval', { source: id, approvalId: String(approvalId), approve: Boolean(approve), by: String(by ?? '') }) },
  }
  return entry
}

/** What the service needs to answer synchronous questions (prompts, tool lists, authorization) without asking. */
function snapshot() {
  const out = {
    plugin: {
      routerPrompt: safe(() => typeof plugin.routerPrompt === 'function' ? plugin.routerPrompt(pluginCtx) : plugin.routerPrompt, undefined),
      workerPrompt: safe(() => typeof plugin.workerPrompt === 'function' ? plugin.workerPrompt(pluginCtx) : plugin.workerPrompt, undefined),
      routerTools: toolDefs(safe(() => plugin.routerTools?.(pluginCtx), {})),
      workerTools: toolDefs(safe(() => plugin.workerTools?.(pluginCtx), {})),
    },
    sources: {},
  }
  for (const [id, e] of sources) {
    const k = e.kind
    out.sources[id] = {
      authorized: typeof k.authorized === 'function' ? safe(() => Boolean(k.authorized(e.ctx)), false) : undefined,
      routerPrompt: e.running ? safe(() => k.routerPrompt?.(e.ctx), undefined) : undefined,
      workerPrompt: e.running ? safe(() => k.workerPrompt?.(e.ctx, stubTicket), undefined) : undefined,
      workerEnv: e.running ? safe(() => k.workerEnv?.(e.ctx, stubTicket), undefined) : undefined,
      routerTools: e.running ? toolDefs(safe(() => k.routerTools?.(e.ctx), {})) : {},
      workerTools: e.running ? toolDefs(safe(() => k.workerTools?.(e.ctx, stubTicket, {}), {})) : {},
      homeThread: e.running ? safe(() => k.homeThread?.(e.ctx), undefined) : undefined,
      threadInfo: Object.fromEntries(engineView.followed.filter(f => f.threadId.startsWith(`${id}:`))
        .map(f => [f.threadId, safe(() => k.threadInfo?.(e.ctx, f.threadId), undefined)]).filter(([, v]) => v)),
    }
  }
  return out
}
let snapTimer
const pushSnapshot = () => { clearTimeout(snapTimer); snapTimer = setTimeout(() => tell('snapshot', { snapshot: snapshot() }), 20) }
setInterval(pushSnapshot, 5_000).unref()

const handlers = {
  async prepare({ source, config, state, secrets }) {
    const kind = (plugin.sources ?? []).find(k => k.id === source)
    if (!kind) throw new Error(`没有来源 ${source}`)
    const old = sources.get(source)
    const parsed = kind.schema?.safeParse ? kind.schema.safeParse(config ?? {}) : { success: true, data: config }
    const entry = sourceCtx(kind, parsed.success ? parsed.data : config, state ?? old?.state ?? {}, secrets ?? old?.secrets ?? {})
    if (old) { entry.running = old.running; entry.stop = old.stop; entry.abort = old.abort; entry.ctx.signal = old.abort.signal }
    sources.set(source, entry)
  },
  async start({ source }) {
    const e = sources.get(source)
    if (!e) throw new Error(`来源 ${source} 没有准备好`)
    e.running = true
    const stop = e.kind.start(e.ctx)
    e.stop = typeof stop === 'function' ? stop : undefined
  },
  async stop({ source }) {
    const e = sources.get(source)
    if (!e?.running) return
    e.running = false
    e.abort.abort()
    try { await e.stop?.() } finally {
      const fresh = sourceCtx(e.kind, e.ctx.config, e.state, e.secrets)
      sources.set(source, fresh)
    }
  },
  async poll({ source }) { const e = sources.get(source); await e.kind.poll?.(e.ctx) },
  async send({ source, message }) { const e = sources.get(source); return await e.kind.send(e.ctx, message) },
  async tool({ scope, source, role, name, args }) {
    if (scope === 'plugin') return await runTool(role === 'router' ? plugin.routerTools?.(pluginCtx) : plugin.workerTools?.(pluginCtx), name, args)
    const e = sources.get(source)
    return await runTool(role === 'router' ? e.kind.routerTools?.(e.ctx) : e.kind.workerTools?.(e.ctx, stubTicket, {}), name, args)
  },
  async http({ source, request, path, info }) {
    const e = sources.get(source)
    if (!e?.kind.http) return null
    const req = new Request(request.url, { method: request.method, headers: request.headers, ...(request.body ? { body: Buffer.from(request.body, 'base64') } : {}) })
    const res = await e.kind.http(e.ctx, req, path, info)
    if (!res) return null
    return { status: res.status, headers: [...res.headers.entries()], body: Buffer.from(await res.arrayBuffer()).toString('base64') }
  },
  async engine({ view }) { engineView = view },
}

process.on('message', async msg => {
  if (msg?.kind === 'answer') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.value)
    return
  }
  if (msg?.kind !== 'call') return
  try {
    const value = await handlers[msg.type](msg)
    send({ kind: 'answer', id: msg.id, value: value === undefined ? null : value })
  } catch (error) {
    send({ kind: 'answer', id: msg.id, error: error instanceof Error ? error.message : String(error) })
  }
  pushSnapshot()
})
process.on('disconnect', () => process.exit(0))
process.on('unhandledRejection', e => log('未处理的错误：', e instanceof Error ? e.message : String(e)))

// ── Load ────────────────────────────────────────────────────────────────────
try {
  const init = await ask('init', {})
  pluginState = init.pluginState ?? {}
  const mod = await import(pathToFileURL(entry).href)
  const exported = mod.default
  if (!exported) throw new Error('入口模块没有 default 导出')
  plugin = typeof exported === 'function' ? await exported(sdk) : exported
  if (!plugin || typeof plugin !== 'object' || typeof plugin.id !== 'string') throw new Error('插件必须导出包含 id 的对象')
  tell('hello', {
    plugin: {
      id: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description,
      writes: plugin.writes ?? [], skills: plugin.skills ?? [], mcpServers: plugin.mcpServers ?? [],
      sources: (plugin.sources ?? []).map(k => ({
        id: k.id, title: k.title, icon: k.icon, description: k.description, fields: k.fields, defaultEnabled: k.defaultEnabled, actions: k.actions, writes: k.writes,
        capabilities: k.capabilities,
        configSchema: safe(() => { const s = z.toJSONSchema(k.schema, { io: 'input', unrepresentable: 'any' }); delete s.$schema; return s }, null),
        has: Object.fromEntries(['authorized', 'poll', 'allowed', 'send', 'threadInfo', 'homeThread', 'routerPrompt', 'routerTools', 'workerPrompt', 'workerTools', 'workerEnv', 'http'].map(m => [m, typeof k[m] === 'function'])),
        validStart: typeof k.start === 'function',
      })),
    },
    snapshot: snapshot(),
  })
} catch (error) {
  tell('fatal', { error: error instanceof Error ? error.message : String(error) })
  setTimeout(() => process.exit(1), 50)
}
