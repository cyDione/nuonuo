/** HTTP surface of the daemon: the JSON API under /api, the login link under /auth, and the web UI's static files. */
import { serveStatic } from '@hono/node-server/serve-static'
import { describeError, ModelError, PROVIDER_PRESETS, REASONING_LEVELS, ROLE_IDS, ROLES, type ProviderKind, type RoleId } from '@nuonuo/models'
import { Hono, type Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, relative } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { COOKIE, hostGuard, requireToken, webGate } from './auth'
import { connectHost, DEFAULT_HOST, DEFAULT_PORT, networkUrls, readSavedConfig, resolveConfig, validHost, VERSION, writeSavedConfig } from './config'
import { Conversations } from './conversations'
import { EventMapper } from './events'
import { dispositionText, reportsOf, ticketView, transcript } from './views'
import { PERSONA_LANGUAGES, PERSONA_ROLES, DEFAULT_PERSONA, DEFAULT_PROACTIVE, DomainError, StructuredCallError, DEFAULT_ACCESS, LOCAL_APPS, suggestSteps, parseMemoryExport, type AccessSettings, KIND_LABEL, persona, savePersona, MEMORY_KINDS, type MemoryStatus, DEFAULT_EXECUTION, DEFAULT_REVIEW, proactiveHistory, proactiveSettings, ROUTER_SESSION, saveProactiveSettings, INSTRUCTIONS_MAX, WATCHDOG_SESSION } from '@nuonuo/core'
import { kvGet, kvSet, newId, schema } from '@nuonuo/db'
import { fireRoutine } from '@nuonuo/sources'
import { runDoctor } from './doctor'
import { MAX_UPLOAD, Uploads } from './uploads'
import { search } from './search'
import { clearChats, exportAll, PrivacySchema, privacySettings, savePrivacySettings, sideChats } from './data'
import { DEFAULT_NOTIFY, NotifySettingsSchema, notifySettings, saveNotifySettings } from './notices'
import type { Runtime } from './runtime'
import type { Updater } from './update'

const KINDS = ['anthropic', 'openai', 'google', 'deepseek', 'openai-compatible', 'typesafe'] as const satisfies readonly ProviderKind[]
const PricesSchema = z.record(z.string(), z.object({ input: z.number().min(0).optional(), output: z.number().min(0).optional(),
  cacheRead: z.number().min(0).optional(), cacheWrite: z.number().min(0).optional() }).strict())
const ProviderBody = z.object({
  kind: z.enum(KINDS), name: z.string().trim().min(1).max(60), baseUrl: z.string().url().nullish().or(z.literal('')),
  apiKey: z.string().max(500).nullish(), options: z.object({ prices: PricesSchema.optional(), headers: z.record(z.string(), z.string()).optional(), decisionsUrl: z.string().url().optional() }).optional(),
})
const ConversationPatch = z.object({ title: z.string().trim().min(1).max(80).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict()

export class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) { super(message) }
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) throw new HttpError(400, 'invalid', parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return parsed.data
}

export interface AppControl {
  /** Stops and starts the service again (for settings that apply on start); missing when nothing would start it again. */
  restart?: () => void
  /** The port actually listened on (differs from the configured one for port 0). */
  port?: () => number
}

/** `closing` aborts on shutdown so long-lived event streams end instead of holding the HTTP server open. */
export function createApp(rt: Runtime, token: string, webRoot?: string, updater?: Updater, closing?: AbortSignal, control: AppControl = {}): Hono {
  const app = new Hono()
  const conversations = new Conversations(rt.store, rt.hub)
  const uploads = new Uploads(rt.store, rt.uploadsDir)

  app.use('*', hostGuard(rt.config))
  app.use('*', webGate(rt.config))

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof DomainError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.code === 'missing' ? 404 : error.code === 'conflict' ? 409 : 400)
    }
    if (error instanceof ModelError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.code === 'unknown_provider' ? 404 : 400)
    }
    console.error(error)
    return c.json({ error: { code: 'internal', message: describeError(error) } }, 500)
  })

  /** The link `nuonuo start` prints: it trades the token for an HttpOnly cookie and goes to the app. */
  app.get('/auth', c => {
    if (c.req.query('token') !== token) return c.text('令牌无效。运行 nuonuo token 获取新的登录链接。', 401)
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 400 })
    return c.redirect('/')
  })

  const api = new Hono()
  api.use('*', requireToken(token))
  const guard = <T>(fn: () => T): T => { try { return fn() } catch (error) { throw error instanceof HttpError ? error : new HttpError(400, 'invalid', (error as Error).message) } }

  api.get('/health', c => c.json({
    ok: true, version: VERSION, home: rt.config.home, pid: process.pid, uptimeMs: Date.now() - rt.startedAt,
    secrets: rt.secrets.backend, effects: rt.effects.health(),
  }))
  // Updates (packaged Linux build): GET is the cached status, POST /check asks GitHub now, POST runs install.sh.
  const updates = () => { if (!updater) throw new HttpError(404, 'not_found', '更新不可用'); return updater }
  api.get('/update', c => c.json(updates().status()))
  api.post('/update/check', async c => c.json(await updates().check()))
  api.put('/update/settings', async c => c.json(updates().setPrefs(await body(c, z.object({ auto: z.boolean(), channel: z.enum(['stable', 'beta']), install: z.boolean() }).partial().strict()))))
  api.post('/update', async c => {
    try { return c.json(await updates().update()) } catch (error) { throw error instanceof HttpError ? error : new HttpError(409, 'update_failed', (error as Error).message) }
  })

  // Network access: where the service listens and whether browsers may open it. Saved to <home>/config.json and applied
  // when the service starts again; a --host/--port flag or NUONUO_HOST/PORT overrides the saved value.
  const access = () => {
    const cfg = rt.config
    const saved = readSavedConfig(cfg.home)
    const port = control.port?.() ?? cfg.port
    const next = resolveConfig({ desktop: cfg.desktop, host: cfg.sources.host === 'flag' ? cfg.host : undefined, port: cfg.sources.port === 'flag' ? cfg.port : undefined })
    return {
      desktop: cfg.desktop,
      running: { host: cfg.host, port, web: cfg.web },
      saved: { host: saved.host ?? DEFAULT_HOST, port: saved.port ?? DEFAULT_PORT, web: saved.web ?? !cfg.desktop },
      sources: cfg.sources,
      localUrl: `http://${connectHost(cfg.host)}:${port}/auth?token=${token}`,
      networkUrls: cfg.web ? networkUrls(cfg.host, port).map(u => `${u}/auth?token=${token}`) : [],
      restartNeeded: next.host !== cfg.host || (next.port !== cfg.port && cfg.port !== 0) || next.web !== cfg.web,
      canRestart: Boolean(control.restart),
    }
  }
  const AccessBody = z.object({
    host: z.string().trim().refine(validHost, '无效的监听地址').optional(),
    port: z.number().int().min(1).max(65535).optional(),
    web: z.boolean().optional(),
  }).strict()
  api.get('/system/access', c => c.json(access()))
  api.put('/system/access', async c => {
    const input = await body(c, AccessBody)
    guard(() => writeSavedConfig(rt.config.home, input))
    return c.json(access())
  })
  api.post('/system/restart', c => {
    if (!control.restart) throw new HttpError(409, 'cannot_restart', '这个进程没有办法自己重启：请手动重启服务')
    // Answer first; the restart closes this connection.
    setTimeout(() => control.restart?.(), 300)
    return c.json({ ok: true })
  })
  api.get('/doctor', async c => c.json({ checks: await runDoctor(rt) }))
  api.get('/catalog', c => c.json({ presets: PROVIDER_PRESETS, roles: ROLES, reasoningLevels: REASONING_LEVELS }))

  // Providers
  api.get('/providers', c => c.json({ providers: rt.hub.listProviders() }))
  api.post('/providers', async c => {
    const input = await body(c, ProviderBody)
    if (input.kind === 'openai-compatible' && !input.baseUrl) throw new HttpError(400, 'invalid', 'OpenAI 兼容供应商需要 Base URL')
    return c.json({ provider: rt.hub.createProvider({ ...input, baseUrl: input.baseUrl || null }) }, 201)
  })
  api.patch('/providers/:id', async c => {
    const input = await body(c, ProviderBody.partial())
    return c.json({ provider: rt.hub.updateProvider(c.req.param('id'), input) })
  })
  api.delete('/providers/:id', c => { rt.hub.deleteProvider(c.req.param('id')); return c.body(null, 204) })
  // `?role=` filters and orders for that layer (the reviewer gets Jev first). Never cached: the page's refresh must refetch.
  api.get('/providers/:id/models', async c => {
    const role = c.req.query('role') as RoleId | undefined
    if (role !== undefined && !ROLE_IDS.includes(role)) throw new HttpError(400, 'invalid', `unknown layer ${role}`)
    c.header('Cache-Control', 'no-store')
    return c.json(await rt.hub.modelOptions(c.req.param('id'), role))
  })
  api.post('/models/test', async c => {
    const { kind, ...ref } = await body(c, z.object({ providerId: z.string(), model: z.string().trim().min(1), kind: z.enum(['language', 'embedding']).optional() }))
    return c.json(await rt.hub.testModel(ref, kind))
  })

  // Layers
  api.get('/roles', c => {
    const configs = rt.hub.roleConfigs()
    const resolved = Object.fromEntries(ROLE_IDS.map(role => {
      const r = rt.hub.resolve(role)
      return [role, r ? { source: r.source, model: r.config.chain[0], today: rt.hub.usageToday(role) } : null]
    }))
    return c.json({ configs, resolved })
  })
  api.put('/roles/:role', async c => {
    const role = c.req.param('role') as RoleId
    if (!ROLE_IDS.includes(role)) throw new HttpError(404, 'missing', `unknown layer ${role}`)
    return c.json({ config: rt.hub.saveRole(role, await c.req.json().catch(() => undefined)) })
  })

  // Usage
  api.get('/usage', c => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 1, 1), 90)
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1))
    const daily = rt.store.sqlite.prepare(`SELECT date(at / 1000, 'unixepoch', 'localtime') AS day, role,
        sum(input_tokens + output_tokens) AS tokens, sum(cost_usd) AS costUsd, count(*) AS calls
      FROM usage_ledger WHERE at >= ? GROUP BY day, role ORDER BY day`).all(start.getTime())
    return c.json({ since: start.getTime(), rows: rt.hub.usageSince(start.getTime()), daily })
  })

  // Conversations (M0 direct-chat preview)
  api.get('/conversations', c => c.json({ conversations: conversations.list(c.req.query('archived') === '1') }))
  api.post('/conversations', async c => {
    const input = await body(c, z.object({ title: z.string().trim().min(1).max(80).optional() }).optional().default({}))
    return c.json({ conversation: conversations.create(input.title) }, 201)
  })
  api.patch('/conversations/:id', async c => {
    const updated = conversations.update(c.req.param('id'), await body(c, ConversationPatch))
    if (!updated) throw new HttpError(404, 'missing', 'no such conversation')
    return c.json({ conversation: updated })
  })
  api.get('/conversations/main', c => c.json({ id: rt.engine.mainConversation() }))
  api.get('/persona', c => c.json({ persona: persona(rt.store), defaults: DEFAULT_PERSONA }))
  api.put('/persona', async c => {
    const input = await body(c, z.object({ name: z.string().max(40), avatar: z.string().max(16), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), personality: z.string().max(2_000), role: z.enum(PERSONA_ROLES), language: z.enum(PERSONA_LANGUAGES) }).partial())
    const next = savePersona(rt.store, input)
    rt.bus.emit({ type: 'persona.updated' })
    return c.json({ persona: next })
  })
  api.delete('/conversations/:id', c => {
    const id = c.req.param('id')
    if (id === rt.engine.mainConversation()) throw new HttpError(409, 'conflict', '主对话不能删除')
    if (conversations.get(id)) for (const t of rt.engine.tickets({ threadId: rt.engine.threadOf(id), open: true })) rt.engine.stopTask(t.id, 'person', '对话已删除')
    conversations.delete(id)
    return c.body(null, 204)
  })
  api.get('/conversations/:id/messages', c => {
    const conversation = conversations.get(c.req.param('id'))
    if (!conversation) throw new HttpError(404, 'missing', 'no such conversation')
    return c.json({ conversation, messages: conversations.messages(conversation.id) })
  })
  /** The owner's message becomes a trigger; the router or the task's worker picks it up and answers over /api/events. */
  api.post('/conversations/:id/messages', async c => {
    const id = c.req.param('id')
    if (!conversations.get(id)) throw new HttpError(404, 'missing', 'no such conversation')
    const { content, replyTo, attachments = [], quote } = await body(c, z.object({ content: z.string().trim().max(100_000), replyTo: z.string().optional(),
      attachments: z.array(z.string()).max(20).optional(), quote: z.string().optional() }).refine(b => b.content.length > 0 || (b.attachments?.length ?? 0) > 0, '消息不能为空'))
    if (!rt.hub.resolve('router')) throw new ModelError('no_model', '主 Agent 还没有配置模型：请到 设置 → 分层模型 选择')
    const files = guard(() => uploads.take(attachments))
    const quoted = quote ? conversations.message(quote) : undefined
    if (quote && (!quoted || quoted.conversationId !== id)) throw new HttpError(400, 'invalid', '引用的消息不在这个对话里')
    const result = rt.engine.receiveMessage(id, content, { ...(replyTo ? { replyTo } : {}), ...(files.length ? { attachments: files } : {}),
      ...(quoted ? { quote: { messageId: quoted.id, text: quoted.content } } : {}) })
    void conversations.autoTitle(id).then(named => { if (named) rt.bus.emit({ type: 'conversation.updated', conversationId: id }) })
    return c.json({ message: conversations.message(result.messageId), deliveredTo: result.deliveredTo }, 201)
  })
  // Attachments: uploaded first (a chip in the composer), then sent with the message by id.
  api.post('/uploads', async c => {
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new HttpError(400, 'invalid', '缺少文件')
    if (file.size > MAX_UPLOAD) throw new HttpError(400, "too_large", "文件超过 50MB")
    const conversationId = typeof form.conversation === 'string' && form.conversation ? form.conversation : undefined
    if (conversationId && !conversations.get(conversationId)) throw new HttpError(404, 'missing', 'no such conversation')
    const bytes = new Uint8Array(await file.arrayBuffer())
    const saved = guard(() => uploads.save({ name: file.name, mime: file.type, bytes, ...(conversationId ? { conversationId } : {}) }))
    return c.json({ upload: { id: saved.id, name: saved.name, mime: saved.mime, size: saved.size } }, 201)
  })
  api.get('/uploads/:id', c => {
    const row = uploads.get(c.req.param('id'))
    if (!row || !existsSync(row.path)) throw new HttpError(404, 'missing', '附件已不存在')
    const inline = /^image\/(png|jpeg|gif|webp)$|^application\/pdf$/.test(row.mime) && !c.req.query('download')
    return new Response(Readable.toWeb(createReadStream(row.path)) as ReadableStream, { headers: { 'content-type': inline ? row.mime : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'", 'cache-control': 'private, max-age=3600' } })
  })
  api.delete('/uploads/:id', c => { if (!uploads.discard(c.req.param('id'))) throw new HttpError(409, 'conflict', '已发送的附件不能删除'); return c.body(null, 204) })
  /** 「整理一下前面的」: the assistant's working memory of the chat is summarised now, and the chat shows where. */
  api.post('/conversations/:id/compact', async c => {
    const id = c.req.param('id')
    if (!conversations.get(id)) throw new HttpError(404, 'missing', 'no such conversation')
    if (!rt.hub.resolve('summarizer') && !rt.hub.resolve('router')) throw new ModelError('no_model', '还没有配置模型')
    if (rt.agents.isRunning(ROUTER_SESSION)) throw new HttpError(409, 'conflict', '它正在回你，等它说完再整理')
    const session = rt.agents.session(ROUTER_SESSION)
    let compacted = false
    try { compacted = session ? await rt.agents.compact(session) : false } catch (error) { throw new HttpError(400, 'model', `整理失败：${(error as Error).message}`) }
    if (!compacted) return c.json({ compacted: false, note: '前面的还不多，不用整理' })
    const messageId = newId('msg')
    const summary = (rt.store.sqlite.prepare("SELECT json_extract(payload, '$.summary') AS s FROM session_events WHERE session_id = ? AND kind = 'compaction' ORDER BY id DESC LIMIT 1").get(ROUTER_SESSION) as { s: string } | undefined)?.s ?? ''
    const count = (rt.store.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant')").get(id) as { n: number }).n
    rt.store.db.insert(schema.messages).values({ id: messageId, conversationId: id, role: 'system', content: '前面的聊天已整理', meta: { kind: 'compacted', count, summary }, createdAt: Date.now() }).run()
    rt.bus.emit({ type: 'message.created', conversationId: id, messageId })
    return c.json({ compacted: true, messageId })
  })
  api.post('/conversations/:id/read', c => { conversations.markRead(c.req.param('id')); return c.json({ ok: true }) })
  // Message actions: 撤回, 编辑 (take back and send the corrected text), 重新回答.
  api.post('/messages/:id/recall', c => { rt.engine.recallMessage(c.req.param('id')); return c.json({ ok: true }) })
  api.post('/messages/:id/edit', async c => {
    const { content } = await body(c, z.object({ content: z.string().trim().min(1).max(100_000) }))
    const old = conversations.message(c.req.param('id'))
    if (!old) throw new HttpError(404, 'missing', 'no such message')
    rt.engine.recallMessage(old.id, { edited: true })
    const result = rt.engine.receiveMessage(old.conversationId, content)
    return c.json({ message: conversations.message(result.messageId) }, 201)
  })
  api.post('/messages/:id/regenerate', c => {
    if (!rt.hub.resolve('router')) throw new ModelError('no_model', '主 Agent 还没有配置模型')
    rt.engine.regenerate(c.req.param('id')); return c.json({ ok: true })
  })
  api.get('/messages/:id', c => {
    const message = conversations.message(c.req.param('id'))
    if (!message) throw new HttpError(404, 'missing', 'no such message')
    return c.json({ message })
  })

  // Tasks
  api.get('/tickets', c => {
    const conversationId = c.req.query('conversation')
    const list = rt.engine.tickets(conversationId ? { threadId: rt.engine.threadOf(conversationId) } : {}).slice(0, 200)
    return c.json({ tickets: list.map(t => ticketView(rt.engine, t, rt.reviewer.pending(t.id))) })
  })
  api.get('/tickets/:id', c => {
    const ticket = rt.engine.ticket(c.req.param('id'))
    return c.json({ ticket: ticketView(rt.engine, ticket, rt.reviewer.pending(ticket.id)), reports: reportsOf(rt.store, ticket.id), transcript: transcript(rt.agents, ticket.sessionId),
      running: rt.agents.isRunning(ticket.sessionId), jobs: rt.agents.jobs.running(ticket.sessionId), approvals: rt.reviewer.pending(ticket.id),
      browser: rt.browser.hasPage(ticket.id), project: rt.engine.projectOf(ticket) ?? null, usage: rt.engine.usageOf(ticket.id),
      files: rt.engine.artifacts({ ticketId: ticket.id }).map(a => ({ id: a.id, name: a.name, size: a.size })) })
  })
  api.post('/tickets/:id/stop', c => { rt.engine.stopTask(c.req.param('id'), 'person', '主人在界面上停止'); return c.json({ ok: true }) })
  api.post('/tickets/:id/retry', c => { rt.engine.retry(c.req.param('id')); return c.json({ ok: true }) })
  api.get('/inbox', c => {
    const items = rt.engine.tickets({ open: true }).map(t => ticketView(rt.engine, t)).filter(t => t.stage.startsWith('person/'))
    return c.json({ items })
  })
  api.get('/router', c => c.json({ state: rt.agents.session(ROUTER_SESSION)?.state ?? 'idle', transcript: transcript(rt.agents, ROUTER_SESSION).slice(-200) }))

  // Deliverables: files tasks produced, shown in the task details and in the library.
  const MIME: Record<string, string> = { '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.html': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'text/plain; charset=utf-8', '.pdf': 'application/pdf' }
  const textual = (ext: string) => /^\.(md|txt|json|csv|log|ya?ml|toml|ini|py|js|ts|tsx|jsx|sh|go|rs|java|c|cpp|h|rb|php|sql|html|css|xml|svg)$/.test(ext)
  // ⌘K: conversations, what was made and what it remembers.
  api.get('/search', c => c.json(search(rt.store, c.req.query('q') ?? '')))
  api.get('/artifacts', c => {
    const titles = new Map<string, { title: string; conversationId: string | null }>()
    const items = rt.engine.artifacts({ limit: 300 }).map(a => {
      if (!titles.has(a.ticketId)) { try { const t = rt.engine.ticket(a.ticketId); titles.set(a.ticketId, { title: t.title, conversationId: rt.engine.conversationOfThread(t.threadId) ?? null }) } catch { titles.set(a.ticketId, { title: '', conversationId: null }) } }
      return { ...a, ...titles.get(a.ticketId)!, text: textual(extname(a.name).toLowerCase()) }
    })
    return c.json({ artifacts: items })
  })
  api.get('/artifacts/:id', c => {
    const a = rt.engine.artifact(c.req.param('id'))
    if (!existsSync(a.absolute) || !statSync(a.absolute).isFile()) throw new HttpError(404, 'missing', '文件已不存在')
    const ext = extname(a.name).toLowerCase()
    const type = MIME[ext] ?? (textual(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream')
    const disposition = c.req.query('download') ? 'attachment' : 'inline'
    return new Response(Readable.toWeb(createReadStream(a.absolute)) as ReadableStream, { headers: { 'content-type': type,
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(a.name)}`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'cache-control': 'no-store' } })
  })

  // Activity: what happened to every event, and what the proactive strategy decided.
  api.get('/activity', c => {
    const triggers = rt.engine.triggerLog(Math.min(Number(c.req.query('limit')) || 100, 500)).filter(t => t.source !== 'webchat' || t.actor !== 'owner')
    return c.json({ proactive: proactiveSettings(rt.store).mode, stats: rt.engine.attentionStats(), events: triggers.map(t => ({ id: t.id, source: t.source, actor: t.actor, human: t.human, at: t.at,
      text: t.text.slice(0, 400), url: (t.meta as { url?: string }).url ?? null, conversationId: rt.engine.conversationOfThread(t.threadId) ?? null,
      thread: t.threadId, proactive: (t.disposition as any).proactive ?? null, feedback: (t.disposition as any).feedback ?? null, ticketId: (t.disposition as any).startedTicket ?? null, outcome: dispositionText(t.disposition as Record<string, any>) })) })
  })
  /** The owner promotes an observed event to silent work. */
  api.post('/triggers/:id/act', c => {
    const trigger = rt.engine.triggerLog(1000).find(t => t.id === c.req.param('id'))
    if (!trigger) throw new HttpError(404, 'missing', 'no such event')
    const p = (trigger.disposition as any).proactive ?? {}
    const ticket = rt.engine.startProactive(trigger.id, { title: p.title || '主动处理', reason: p.reason || '主人要求处理', ...(p.goal ? { goal: p.goal } : {}), byOwner: true })
    rt.bus.emit({ type: 'activity.updated' })
    return c.json({ ticketId: ticket.id })
  })
  api.post('/triggers/:id/feedback', async c => {
    const { useful } = await body(c, z.object({ useful: z.boolean() }))
    rt.engine.proactiveFeedback(c.req.param('id'), useful)
    return c.json({ ok: true })
  })
  const ProactiveBody = z.object({ mode: z.enum(['off', 'observe', 'auto']), strategy: z.string().max(8_000), sources: z.array(z.string().max(40)).max(30),
    ignoreActors: z.array(z.string().trim().min(1).max(100)).max(100),
    budget: z.object({ concurrent: z.number().int().min(1).max(10), daily: z.number().int().min(1).max(200) }) }).passthrough()
  api.get('/settings/proactive', c => c.json({ settings: proactiveSettings(rt.store), defaults: DEFAULT_PROACTIVE, history: proactiveHistory(rt.store).slice(0, 10) }))
  api.put('/settings/proactive', async c => {
    const { mode, strategy, sources, ignoreActors, budget } = await body(c, ProactiveBody)
    const before = proactiveSettings(rt.store).mode
    const settings = saveProactiveSettings(rt.store, { mode, strategy, sources, ignoreActors, budget }, 'owner')
    if (before !== 'off' && settings.mode === 'off') rt.engine.revokeProactive('主人关闭了主动处理')
    return c.json({ settings })
  })

  // Standing instructions (versioned)
  api.get('/instructions', c => c.json({ current: rt.instructions.current(), history: rt.instructions.history() }))
  api.put('/instructions', async c => {
    const { body: text } = await body(c, z.object({ body: z.string().max(INSTRUCTIONS_MAX) }))
    return c.json({ current: rt.instructions.update(text, 'owner') })
  })
  api.post('/instructions/restore', async c => {
    const { version } = await body(c, z.object({ version: z.number().int().min(1) }))
    return c.json({ current: guard(() => rt.instructions.restore(version, 'owner')) })
  })

  // Sources
  api.get('/sources', c => c.json({ sources: rt.sources.list() }))
  api.put('/sources/:id', async c => {
    const input = await body(c, z.object({ enabled: z.boolean(), config: z.record(z.string(), z.unknown()) }))
    try { await rt.sources.save(c.req.param('id'), input) } catch (error) { throw new HttpError(400, 'invalid', (error as Error).message) }
    await new Promise(r => setTimeout(r, 300))
    return c.json({ sources: rt.sources.list() })
  })
  api.post('/sources/:id/poll', async c => {
    try { await rt.sources.pollNow(c.req.param('id')) } catch (error) { throw new HttpError(400, 'invalid', (error as Error).message) }
    return c.json({ sources: rt.sources.list() })
  })

  // Routines
  const RoutineBody = z.object({ name: z.string().trim().min(1).max(60), schedule: z.string().trim().min(9).max(100), prompt: z.string().trim().min(1).max(4000), enabled: z.boolean().optional() })
  api.get('/routines', c => c.json({ routines: rt.routines.list() }))
  api.post('/routines', async c => { const input = await body(c, RoutineBody); return c.json({ routine: guard(() => rt.routines.create(input)) }, 201) })
  api.patch('/routines/:id', async c => { const input = await body(c, RoutineBody.partial()); return c.json({ routine: guard(() => rt.routines.update(c.req.param('id'), input)) }) })
  api.delete('/routines/:id', c => { rt.routines.delete(c.req.param('id')); return c.body(null, 204) })
  /** 运行记录: each time a routine fired, what came of it (the reply, or the work it started and how that ended). */
  api.get('/routines/:id/runs', c => {
    const id = c.req.param('id')
    const rows = rt.store.sqlite.prepare("SELECT id, at, disposition FROM triggers WHERE source = 'cron' AND json_extract(meta, '$.routineId') = ? ORDER BY at DESC LIMIT 50").all(id) as { id: string; at: number; disposition: string }[]
    const runs = rows.map(r => {
      const d = JSON.parse(r.disposition || '{}') as Record<string, any>
      let ticket: { id: string; title: string; stage: string } | null = null
      const ticketId = d.startedTicket ?? d.attachedTo ?? d.deliveredTo?.[0]
      if (ticketId) { try { const v = ticketView(rt.engine, rt.engine.ticket(ticketId)); ticket = { id: v.id, title: v.title, stage: v.stage } } catch { /* deleted */ } }
      const reply = d.answered ? conversations.message(d.answered) : undefined
      const failed = ticket?.stage === 'person/failed'
      return { id: r.id, at: r.at, outcome: dispositionText(d), ok: !failed, reply: reply ? { id: reply.id, text: reply.content.slice(0, 300), conversationId: reply.conversationId } : null, ticket }
    })
    return c.json({ runs })
  })
  api.post('/routines/:id/run', c => {
    guard(() => rt.routines.runNow(c.req.param('id'), (r, at) => fireRoutine({ engine: rt.engine, store: rt.store }, r, at)))
    return c.json({ ok: true, routine: rt.routines.get(c.req.param('id')) })
  })

  // Review: rules, approvals, audit
  const ReviewBody = z.object({
    external: z.enum(['allow', 'review', 'ask', 'deny']), mode: z.enum(['model', 'ask']), destructive: z.enum(['review', 'ask', 'deny']),
    rules: z.array(z.string().trim().min(1).max(500)).max(50),
    allow: z.array(z.string().trim().min(1).max(300)).max(100), deny: z.array(z.string().trim().min(1).max(300)).max(100),
  }).strict()
  // 权限 → 文件夹 and 本机应用: one home for what the assistant may touch on this computer.
  const LocalAccessBody = z.object({
    folders: z.array(z.object({ path: z.string().trim().min(1).max(1_000), write: z.boolean() })).max(100),
    never: z.array(z.string().trim().min(1).max(1_000)).max(100),
    apps: z.partialRecord(z.enum(LOCAL_APPS), z.enum(['auto', 'ask', 'read', 'off'])),
    sources: z.record(z.string().max(80), z.enum(['read', 'act'])),
  }).partial().strict()
  api.get('/settings/access', c => c.json({ settings: rt.access.settings(), defaults: DEFAULT_ACCESS, platform: process.platform }))
  api.put('/settings/access', async c => c.json({ settings: rt.access.save(await body(c, LocalAccessBody) as Partial<AccessSettings>) }))
  api.get('/settings/review', c => c.json({ settings: rt.reviewer.settings(), defaults: DEFAULT_REVIEW }))
  api.put('/settings/review', async c => {
    const settings = await body(c, ReviewBody)
    for (const p of [...settings.allow, ...settings.deny]) { try { new RegExp(p) } catch { throw new HttpError(400, 'invalid', `不是合法的正则表达式：${p}`) } }
    kvSet(rt.store, 'settings:review', settings)
    return c.json({ settings: rt.reviewer.settings() })
  })
  api.get('/approvals', c => c.json({ approvals: rt.reviewer.pending() }))
  api.post('/approvals/:id', async c => {
    const { approve, note, scope } = await body(c, z.object({ approve: z.boolean(), note: z.string().max(500).optional(), scope: z.enum(['once', 'task', 'always']).optional() }))
    return c.json({ approval: guard(() => rt.reviewer.decide(c.req.param('id'), approve, note, scope)) })
  })
  api.get('/grants', c => c.json({ grants: rt.reviewer.grants() }))
  api.delete('/grants/:id', c => { rt.reviewer.revokeGrant(c.req.param('id')); rt.bus.emit({ type: 'activity.updated' }); return c.body(null, 204) })
  api.get('/audit', c => c.json({ entries: rt.reviewer.auditLog(Math.min(Number(c.req.query('limit')) || 200, 1000)) }))

  // Goals (目标): set in conversation; the owner pins, finishes, drops or deletes them here.
  api.get('/goals', c => c.json({ goals: rt.goals.list(['active', 'done']), week: rt.goals.week() }))
  api.patch('/goals/:id', async c => {
    const patch = await body(c, z.object({ pinned: z.boolean().optional(), status: z.enum(['active', 'done', 'dropped']).optional(), title: z.string().trim().min(1).max(40).optional() }).strict())
    return c.json({ goal: guard(() => rt.goals.update(c.req.param('id'), patch)) })
  })
  api.delete('/goals/:id', c => { rt.goals.remove(c.req.param('id')); return c.body(null, 204) })
  /** A step the owner adds under a goal (from 拆成几步 or by hand). */
  api.post('/goals', async c => {
    const input = await body(c, z.object({ title: z.string().trim().min(1).max(40), target: z.number().positive(), unit: z.string().max(8).optional(),
      style: z.enum(['amount', 'days']).optional(), parentId: z.string() }).strict())
    return c.json({ goal: guard(() => rt.goals.create(input)) }, 201)
  })
  api.put('/goals/order', async c => { const { ids } = await body(c, z.object({ ids: z.array(z.string()).max(200) })); return c.json({ goals: guard(() => rt.goals.reorder(ids)) }) })
  api.post('/goals/:id/suggest', async c => {
    const goal = guard(() => rt.goals.get(c.req.param('id')))
    if (!rt.hub.resolve('router')) throw new ModelError('no_model', '还没有配置模型')
    const children = rt.goals.list(['active', 'done']).filter(g => g.parentId === goal.id)
    try { return c.json({ steps: await suggestSteps(rt.hub, goal, children) }) } catch (error) { throw new HttpError(400, 'model', (error as Error).message) }
  })

  // 会做的事 (它是谁): procedures the owner taught it.
  const SkillBody = z.object({ name: z.string().trim().min(1).max(20), when: z.string().trim().min(1).max(120), steps: z.string().trim().min(1).max(4_000), enabled: z.boolean().optional() }).strict()
  api.get('/skills', c => c.json({ skills: rt.skills.list() }))
  api.post('/skills', async c => { const input = await body(c, SkillBody); return c.json({ skill: guard(() => rt.skills.create(input)) }, 201) })
  api.patch('/skills/:id', async c => { const input = await body(c, SkillBody.partial()); return c.json({ skill: guard(() => rt.skills.update(c.req.param('id'), input)) }) })
  api.delete('/skills/:id', c => { rt.skills.remove(c.req.param('id')); return c.body(null, 204) })

  // 动态: changes in what it watches for the owner.
  api.get('/feed', c => c.json({ items: rt.feed.list(), unseen: rt.feed.unseen() }))
  api.post('/feed/seen', c => { rt.feed.seeAll(); return c.json({ ok: true }) })
  api.post('/feed/:id/react', async c => { const { reaction } = await body(c, z.object({ reaction: z.enum(['up', 'down']).nullable() })); return c.json({ item: guard(() => rt.feed.react(c.req.param('id'), reaction)) }) })
  api.post('/feed/:id/save', async c => { const { saved } = await body(c, z.object({ saved: z.boolean() })); return c.json({ item: guard(() => rt.feed.save(c.req.param('id'), saved)) }) })
  api.post('/feed/:id/dismiss', c => { guard(() => rt.feed.dismiss(c.req.param('id'))); return c.json({ ok: true }) })

  // 点子: a few things it could do, a new batch each morning.
  api.get('/ideas', c => c.json({ batch: rt.ideas.batch(), settings: rt.ideas.settings() }))
  api.put('/settings/ideas', async c => c.json({ settings: rt.ideas.saveSettings(await body(c, z.object({ cadence: z.enum(['daily', 'weekly', 'off']).optional(), hour: z.number().int().min(0).max(23).optional() }).strict())) }))
  api.post('/ideas/refresh', async c => {
    if (!rt.hub.resolve('router')) throw new ModelError('no_model', '主 Agent 还没有配置模型：请到 设置 → 分层模型 选择')
    try { return c.json({ batch: await rt.ideas.refresh() }) } catch (error) {
      if (error instanceof StructuredCallError) throw new HttpError(409, 'ideas_failed', `这次没想出来：${error.message}`)
      throw error
    }
  })
  api.post('/ideas/seen', c => { rt.ideas.seen(); return c.json({ ok: true }) })
  api.post('/ideas/:id/dismiss', c => { guard(() => rt.ideas.dismiss(c.req.param('id'))); return c.json({ ok: true }) })
  /** 「去做」: a side chat that starts with what the idea offered. */
  api.post('/ideas/:id/go', c => {
    if (!rt.hub.resolve('router')) throw new ModelError('no_model', '主 Agent 还没有配置模型：请到 设置 → 分层模型 选择')
    const idea = guard(() => rt.ideas.take(c.req.param('id')))
    const title = ('label' in idea && typeof idea.label === 'string' && idea.label ? idea.label.split(' · ')[0]! : idea.text).slice(0, 40)
    const conversation = conversations.create(title)
    rt.engine.receiveMessage(conversation.id, idea.say)
    rt.bus.emit({ type: 'conversation.updated', conversationId: conversation.id })
    return c.json({ conversationId: conversation.id }, 201)
  })

  // Memory
  api.get('/memories', c => {
    const status = (c.req.query('status') ?? 'active,pending').split(',') as MemoryStatus[]
    const rows = rt.memory.list({ status })
    const scopes = [...new Set(rows.map(r => r.scope).filter(Boolean))] as string[]
    return c.json({ memories: rows.map(({ embedding: _e, ...m }) => m), scopes: Object.fromEntries(scopes.map(s => [s, rt.memory.scopeName(s)])),
      kinds: MEMORY_KINDS.map(id => ({ id, label: KIND_LABEL[id] })) })
  })
  api.post('/memories', async c => {
    const input = await body(c, z.object({ kind: z.enum(MEMORY_KINDS), text: z.string().trim().min(2).max(500), scope: z.string().trim().max(200).optional(), ttlDays: z.number().int().min(1).max(365).optional() }))
    return c.json(guard(() => rt.memory.add({ ...input, trust: 'user', createdBy: 'owner' })), 201)
  })
  api.patch('/memories/:id', async c => {
    const { action, text } = await body(c, z.object({ action: z.enum(['confirm', 'reject', 'edit']), text: z.string().trim().min(2).max(500).optional() }))
    guard(() => action === 'confirm' ? rt.memory.confirm(c.req.param('id'), text) : action === 'reject' ? rt.memory.reject(c.req.param('id')) : rt.memory.edit(c.req.param('id'), text ?? ''))
    return c.json({ memory: rt.memory.get(c.req.param('id')) })
  })
  api.delete('/memories/:id', c => { rt.memory.remove(c.req.param('id')); return c.body(null, 204) })
  // The active entries as one Markdown document (## 关于你 / ## 项目 · 名字 / ## 近期 / ## 经验, one line each); saving it
  // forgets the lines that were removed and remembers the new ones.
  api.get('/memories/markdown', c => c.json({ markdown: rt.memory.markdown() }))
  api.put('/memories/markdown', async c => {
    const { markdown } = await body(c, z.object({ markdown: z.string().max(200_000) }))
    return c.json(guard(() => rt.memory.applyMarkdown(markdown, 'owner')))
  })
  // 从别的 AI 带过来: paste what another assistant remembers, tick the lines to keep, import them as the owner's.
  api.post('/memories/import/preview', async c => {
    const { text } = await body(c, z.object({ text: z.string().min(1).max(200_000) }))
    return c.json({ items: parseMemoryExport(text) })
  })
  api.post('/memories/import', async c => {
    const { items } = await body(c, z.object({ items: z.array(z.object({ kind: z.enum(['profile', 'lesson']), text: z.string().trim().min(2).max(300) })).min(1).max(200) }))
    let added = 0, existing = 0, skipped = 0
    for (const item of items) {
      try {
        const r = rt.memory.add({ kind: item.kind, text: item.text, trust: 'user', createdBy: 'import' })
        if (r.status === 'exists') existing++; else if (r.status === 'active') added++; else skipped++
      } catch { skipped++ }
    }
    return c.json({ added, existing, skipped })
  })
  api.post('/memories/consolidate', c => c.json(rt.memory.consolidate()))

  // 通知: which changes notify, how, and the quiet hours. 试一下 sends a sample whatever the settings.
  api.get('/settings/notifications', c => c.json({ settings: notifySettings(rt.store), defaults: DEFAULT_NOTIFY }))
  api.put('/settings/notifications', async c => {
    const patch = await body(c, NotifySettingsSchema.partial())
    return c.json({ settings: guard(() => saveNotifySettings(rt.store, patch)) })
  })
  api.post('/notifications/test', c => c.json({ notice: rt.notices.test() }))

  // 数据和隐私
  api.get('/settings/privacy', c => c.json({ settings: privacySettings(rt.store) }))
  api.put('/settings/privacy', async c => c.json({ settings: savePrivacySettings(rt.store, await body(c, PrivacySchema.partial())) }))
  api.get('/export', c => {
    const data = exportAll(rt.store, { app: 'nuonuo', version: VERSION, persona: persona(rt.store) })
    const day = new Date().toISOString().slice(0, 10)
    c.header('content-disposition', `attachment; filename="nuonuo-${day}.json"`)
    return c.json(data)
  })
  api.delete('/memories', c => {
    const all = rt.memory.list({ status: ['active', 'pending'] })
    for (const m of all) rt.memory.remove(m.id)
    return c.json({ removed: all.length })
  })
  api.delete('/conversations', c => {
    const keep = [rt.engine.mainConversation(), rt.watchdog.conversation()]
    for (const id of sideChats(rt.store, keep)) for (const t of rt.engine.tickets({ threadId: rt.engine.threadOf(id), open: true })) rt.engine.stopTask(t.id, 'person', '聊天记录已清除')
    const removed = clearChats(rt.store, keep)
    rt.bus.emit({ type: 'conversation.updated', conversationId: keep[0]! })
    return c.json({ removed })
  })

  // Watchdog
  api.get('/watchdog', c => c.json({ conversationId: rt.watchdog.conversation(), state: rt.agents.session(WATCHDOG_SESSION)?.state ?? 'idle' }))
  api.post('/watchdog/run', c => c.json({ findings: rt.watchdog.tick() }))

  // Browser handoff: the owner operates a task's tab from the web UI, then hands it back.
  api.post('/browser/:ticket/handoff', c => {
    const ticket = rt.engine.ticket(c.req.param('ticket'))
    if (!rt.browser.hasPage(ticket.id)) throw new HttpError(409, 'conflict', '这个任务没有打开的浏览器页面')
    rt.browser.handoffs.add(ticket.id)
    return c.json({ ok: true })
  })
  api.get('/browser/:ticket/screenshot', async c => {
    const ticket = rt.engine.ticket(c.req.param('ticket'))
    if (!rt.browser.hasPage(ticket.id)) throw new HttpError(404, 'missing', '没有打开的页面')
    const png = await rt.browser.screenshot(ticket.id)
    return c.body(new Uint8Array(png), 200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
  })
  // 看它的浏览器 (read-only, from 活动): where its tab is, and each step it took with a picture.
  api.get('/browser/:ticket/state', async c => {
    const ticket = rt.engine.ticket(c.req.param('ticket'))
    return c.json({ state: await rt.browser.state(ticket.id), steps: rt.browser.steps(ticket.id) })
  })
  api.get('/browser/:ticket/steps/:n', c => {
    const ticket = rt.engine.ticket(c.req.param('ticket'))
    const shot = rt.browser.stepShot(ticket.id, Number(c.req.param('n')))
    if (!shot) throw new HttpError(404, 'missing', '没有这一步的截图')
    return c.body(new Uint8Array(shot), 200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' })
  })
  const BrowserInput = z.discriminatedUnion('type', [
    z.object({ type: z.literal('click'), x: z.number().min(0).max(4000), y: z.number().min(0).max(4000) }),
    z.object({ type: z.literal('type'), text: z.string().max(2000) }),
    z.object({ type: z.literal('paste'), text: z.string().max(20_000) }),
    z.object({ type: z.literal('key'), key: z.string().regex(/^[\w+]{1,30}$/) }),
    z.object({ type: z.literal('goto'), url: z.string().url() }),
    z.object({ type: z.literal('scroll'), dy: z.number().min(-5000).max(5000) }),
  ])
  api.post('/browser/:ticket/input', async c => {
    const ticket = rt.engine.ticket(c.req.param('ticket'))
    if (!rt.browser.handoffs.has(ticket.id)) throw new HttpError(409, 'conflict', '先点「开始接管」')
    return c.json(await rt.browser.input(ticket.id, await body(c, BrowserInput)))
  })
  api.post('/browser/:ticket/return', async c => {
    const ticket = rt.engine.ticket(c.req.param('ticket'))
    rt.browser.handoffs.delete(ticket.id)
    const { note } = await body(c, z.object({ note: z.string().max(1000).optional() }).optional().default({}))
    const conversationId = rt.engine.conversationOfThread(ticket.threadId)
    if (conversationId) rt.engine.receiveMessage(conversationId, note?.trim() || '我已经在浏览器里操作完了，交还给你，继续吧。', { replyTo: ticket.id })
    return c.json({ ok: true })
  })

  // Plugins
  api.get('/plugins', c => c.json({ plugins: rt.plugins.list(), dir: `${rt.config.home}/plugins` }))
  api.post('/plugins/:id', async c => {
    const { enabled } = await body(c, z.object({ enabled: z.boolean() }))
    try { return c.json({ plugin: await rt.plugins.setEnabled(c.req.param('id'), enabled) }) } catch (error) { throw new HttpError(400, 'invalid', (error as Error).message) }
  })
  /** A source's own endpoints (owner only). */
  api.all('/sources/:id/http/*', async c => {
    const path = c.req.path.split('/http/').slice(1).join('/http/')
    const res = await rt.sources.http(c.req.param('id'), c.req.raw, path, { public: false, origin: new URL(c.req.url).origin })
    if (!res) throw new HttpError(404, 'missing', 'no such endpoint')
    return res
  })

  // MCP servers
  const McpBody = z.array(z.object({
    name: z.string().regex(/^[a-z0-9_-]{1,24}$/, '名称只能用小写字母、数字、- 和 _'), enabled: z.boolean(), transport: z.enum(['stdio', 'http']),
    command: z.string().max(500).optional(), args: z.array(z.string().max(1000)).max(50).optional(), env: z.record(z.string(), z.string().max(2000)).optional(),
    url: z.string().url().optional(), headers: z.record(z.string(), z.string().max(2000)).optional(),
    roles: z.array(z.enum(['worker', 'router'])).min(1), review: z.boolean(),
  }).strict()).max(30)
  api.get('/settings/mcp', c => c.json({ servers: kvGet(rt.store, 'settings:mcp') ?? [], status: rt.mcp.status() }))
  api.put('/settings/mcp', async c => {
    const servers = await body(c, McpBody)
    if (new Set(servers.map(s => s.name)).size !== servers.length) throw new HttpError(400, 'invalid', '名称不能重复')
    kvSet(rt.store, 'settings:mcp', servers)
    return c.json({ servers, status: await rt.mcp.sync() })
  })
  api.post('/mcp/sync', async c => c.json({ status: await rt.mcp.sync() }))

  // Execution settings
  const ExecutionBody = z.object({
    maxWorkers: z.number().int().min(1).max(16), foregroundSeconds: z.number().min(1).max(600), timeoutMinutes: z.number().int().min(1).max(24 * 60),
    blockedCommands: z.array(z.string().trim().min(1).max(64)).max(100), workspaceRoots: z.array(z.string().trim().min(1).max(500)).max(50),
    sandbox: z.object({ mode: z.enum(['off', 'external', 'all']), image: z.string().trim().min(1).max(200), network: z.enum(['bridge', 'none']) }).strict(),
  }).strict()
  api.get('/settings/execution', c => c.json({ settings: rt.engine.execution(), defaults: DEFAULT_EXECUTION }))
  api.put('/settings/execution', async c => {
    const settings = await body(c, ExecutionBody)
    kvSet(rt.store, 'settings:execution', settings)
    rt.agents.options.maxWorkers = settings.maxWorkers
    return c.json({ settings: rt.engine.execution() })
  })

  /** One SSE stream per browser tab: messages, streaming replies, task and session state. */
  api.get('/events', c => streamSSE(c, async sse => {
    const mapper = new EventMapper()
    const queue: string[] = []
    let wake: (() => void) | undefined
    const off = rt.bus.on(event => {
      for (const e of mapper.map(event)) queue.push(JSON.stringify(e))
      wake?.()
    })
    const closed = new Promise<void>(resolve => {
      const done = () => resolve()
      c.req.raw.signal.addEventListener('abort', done, { once: true })
      closing?.addEventListener('abort', done, { once: true })
    })
    try {
      await sse.writeSSE({ event: 'ready', data: '{}' })
      for (;;) {
        while (queue.length) await sse.writeSSE({ event: 'message', data: queue.shift()! })
        const ping = new Promise<'ping'>(r => setTimeout(() => r('ping'), 20_000))
        const next = await Promise.race([new Promise<'event'>(r => { wake = () => r('event') }), ping, closed.then(() => 'closed' as const)])
        wake = undefined
        if (next === 'closed') break
        if (next === 'ping') await sse.writeSSE({ event: 'ping', data: '{}' })
      }
    } finally { off() }
  }))

  app.route('/api', api)

  /** Public endpoints of sources (OAuth callbacks): no owner token, so each source checks its own state parameter. */
  app.all('/plugin/:id/*', async c => {
    const path = c.req.path.replace(new RegExp(`^/plugin/${c.req.param('id')}/`), '')
    const res = await rt.sources.http(c.req.param('id'), c.req.raw, path, { public: true, origin: new URL(c.req.url).origin })
    return res ?? c.text('not found', 404)
  })

  if (webRoot && existsSync(webRoot)) {
    const root = relative(process.cwd(), webRoot) || '.'
    app.use('/*', serveStatic({ root }))
    app.get('*', serveStatic({ root, path: 'index.html' }))
  } else {
    app.get('/', c => c.html('<p>Web UI 未构建：运行 <code>pnpm build</code>，或在开发时使用 <code>pnpm dev</code>（http://localhost:5173）。</p>'))
  }
  return app
}
