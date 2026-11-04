/** HTTP surface of the daemon: the JSON API under /api, the login link under /auth, and the web UI's static files. */
import { serveStatic } from '@hono/node-server/serve-static'
import { describeError, ModelError, PROVIDER_PRESETS, REASONING_LEVELS, ROLE_IDS, ROLES, type ProviderKind, type RoleId } from '@super-agent/models'
import { Hono, type Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import { z } from 'zod'
import { COOKIE, hostGuard, requireToken } from './auth'
import { VERSION } from './config'
import { Conversations } from './conversations'
import { runDoctor } from './doctor'
import type { Runtime } from './runtime'

const KINDS = ['anthropic', 'openai', 'google', 'deepseek', 'openai-compatible'] as const satisfies readonly ProviderKind[]
const PricesSchema = z.record(z.string(), z.object({ input: z.number().min(0).optional(), output: z.number().min(0).optional(),
  cacheRead: z.number().min(0).optional(), cacheWrite: z.number().min(0).optional() }).strict())
const ProviderBody = z.object({
  kind: z.enum(KINDS), name: z.string().trim().min(1).max(60), baseUrl: z.string().url().nullish().or(z.literal('')),
  apiKey: z.string().max(500).nullish(), options: z.object({ prices: PricesSchema.optional(), headers: z.record(z.string(), z.string()).optional() }).optional(),
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

export function createApp(rt: Runtime, token: string, webRoot?: string): Hono {
  const app = new Hono()
  const conversations = new Conversations(rt.store, rt.hub)

  app.use('*', hostGuard(rt.config))

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof ModelError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.code === 'unknown_provider' ? 404 : 400)
    }
    console.error(error)
    return c.json({ error: { code: 'internal', message: describeError(error) } }, 500)
  })

  /** The link `superagent start` prints: it trades the token for an HttpOnly cookie and goes to the app. */
  app.get('/auth', c => {
    if (c.req.query('token') !== token) return c.text('令牌无效。运行 superagent token 获取新的登录链接。', 401)
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 400 })
    return c.redirect('/')
  })

  const api = new Hono()
  api.use('*', requireToken(token))

  api.get('/health', c => c.json({
    ok: true, version: VERSION, home: rt.config.home, pid: process.pid, uptimeMs: Date.now() - rt.startedAt,
    secrets: rt.secrets.backend, effects: rt.effects.health(),
  }))
  api.get('/doctor', c => c.json({ checks: runDoctor(rt) }))
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
  api.get('/providers/:id/models', async c => {
    try { return c.json({ models: await rt.hub.listModels(c.req.param('id')) }) }
    catch (error) {
      if (error instanceof ModelError) throw error
      return c.json({ models: [], error: describeError(error) })
    }
  })
  api.post('/models/test', async c => {
    const ref = await body(c, z.object({ providerId: z.string(), model: z.string().trim().min(1) }))
    return c.json(await rt.hub.testModel(ref))
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
  api.get('/conversations', c => c.json({ conversations: conversations.list() }))
  api.post('/conversations', async c => {
    const input = await body(c, z.object({ title: z.string().trim().min(1).max(80).optional() }).optional().default({}))
    return c.json({ conversation: conversations.create(input.title) }, 201)
  })
  api.patch('/conversations/:id', async c => {
    const updated = conversations.update(c.req.param('id'), await body(c, ConversationPatch))
    if (!updated) throw new HttpError(404, 'missing', 'no such conversation')
    return c.json({ conversation: updated })
  })
  api.delete('/conversations/:id', c => { conversations.delete(c.req.param('id')); return c.body(null, 204) })
  api.get('/conversations/:id/messages', c => {
    const conversation = conversations.get(c.req.param('id'))
    if (!conversation) throw new HttpError(404, 'missing', 'no such conversation')
    return c.json({ conversation, messages: conversations.messages(conversation.id) })
  })
  /** Stores the person's message and streams the reply as SSE: `message` (stored user message), `delta`, then `done` or `error`. */
  api.post('/conversations/:id/messages', async c => {
    const id = c.req.param('id')
    if (!conversations.get(id)) throw new HttpError(404, 'missing', 'no such conversation')
    const { content } = await body(c, z.object({ content: z.string().trim().min(1).max(100_000) }))
    if (!rt.hub.resolve('router')) throw new ModelError('no_model', '主 Agent 还没有配置模型：请到 设置 → 分层模型 选择')
    const userMessage = conversations.addMessage(id, 'user', content)
    return streamSSE(c, async sse => {
      await sse.writeSSE({ event: 'message', data: JSON.stringify(userMessage) })
      const abort = new AbortController()
      c.req.raw.signal.addEventListener('abort', () => abort.abort())
      let text = ''
      try {
        const result = conversations.reply(id, abort.signal)
        for await (const delta of result.textStream) {
          text += delta
          await sse.writeSSE({ event: 'delta', data: JSON.stringify({ text: delta }) })
        }
        const usage = await result.totalUsage
        const saved = conversations.addMessage(id, 'assistant', text, { model: (await result.response).modelId,
          usage: { input: usage.inputTokens, output: usage.outputTokens } })
        await sse.writeSSE({ event: 'done', data: JSON.stringify(saved) })
        void conversations.autoTitle(id)
      } catch (error) {
        const message = describeError(error)
        const saved = conversations.addMessage(id, 'assistant', text || '（回复失败）', { error: message, partial: Boolean(text) })
        await sse.writeSSE({ event: 'error', data: JSON.stringify({ message, saved }) })
      }
    })
  })

  app.route('/api', api)

  if (webRoot && existsSync(webRoot)) {
    const root = relative(process.cwd(), webRoot) || '.'
    app.use('/*', serveStatic({ root }))
    app.get('*', serveStatic({ root, path: 'index.html' }))
  } else {
    app.get('/', c => c.html('<p>Web UI 未构建：运行 <code>pnpm build</code>，或在开发时使用 <code>pnpm dev</code>（http://localhost:5173）。</p>'))
  }
  return app
}
