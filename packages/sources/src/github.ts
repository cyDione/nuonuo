/**
 * GitHub source: polls the REST API (a personal machine rarely has a public URL for webhooks), so a restart or a sleeping
 * laptop simply catches up from its cursors.
 *
 * - Threads are issues and pull requests: `github:owner/repo#12`.
 * - Authorization: the OAuth device flow ("授权 GitHub" shows a code to enter on github.com), which needs no callback URL and so
 *   works on a headless box reached over `ssh -L`. The token goes into the secret store. GITHUB_TOKEN / GH_TOKEN or the local
 *   `gh` login still work when no authorization is stored.
 * - A request is a comment, issue or review comment that mentions the agent (default `@agent`) by an allowed account
 *   (the account behind the token, plus an allowlist).
 * - The agent writes as that same account, so its comments carry an invisible marker and are skipped when read back.
 * - Threads that tasks follow are polled for reviews, CI results and merge/close.
 */
import { tool } from 'ai'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { oauth } from './auth.mjs'
import type { SourceContext, SourceKind } from './kind'

export const MARKER = '<!-- nuonuo -->'

/**
 * The built-in OAuth App (device flow enabled). A client ID is public by design: the device flow needs no secret.
 * The owner's "Super Assistant" app; `clientId` in the settings is only needed to use another app.
 */
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23liK2hYlHXMinmLMg'
/** What `gh` asks for, so workers can use `gh` and git with the same token. */
export const GITHUB_SCOPES = 'repo read:org workflow'

export const GithubConfigSchema = z.object({
  repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, '格式应为 owner/repo')).default([]),
  mention: z.string().trim().min(2).default('@agent'),
  allowed: z.array(z.string().trim().min(1)).default([]),
  pollSeconds: z.number().int().min(15).max(3600).default(60),
  apiUrl: z.string().url().default('https://api.github.com'),
  clientId: z.string().trim().default(''),
  oauthUrl: z.string().url().default('https://github.com'),
}).strict()
export type GithubConfig = z.infer<typeof GithubConfigSchema>

interface IssueInfo { title: string; url: string; pr: boolean; state: string; repo: string; number: number }

const exec = promisify(execFile)

/** The fallback token when no authorization is stored: GITHUB_TOKEN / GH_TOKEN, else the local `gh` login. */
export async function githubToken(env = process.env): Promise<string | undefined> {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try { return (await exec('gh', ['auth', 'token'], { timeout: 10_000 })).stdout.trim() || undefined } catch { return undefined }
}

export class GithubApi {
  constructor(private base: string, private token: string | undefined, private fetchImpl: typeof fetch = fetch) {}
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'nuonuo',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw Object.assign(new Error(`GitHub ${method} ${path} → ${res.status} ${text.slice(0, 200)}`), { status: res.status })
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }
  get<T>(path: string) { return this.request<T>('GET', path) }
}

export const threadId = (repo: string, number: number) => `github:${repo}#${number}`
export function parseThread(id: string): { repo: string; number: number } | undefined {
  const m = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(id)
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined
}


export function githubKind(deps: { fetch?: typeof fetch; token?: () => Promise<string | undefined> } = {}): SourceKind<GithubConfig> {
  const f = deps.fetch ?? fetch
  const apis = new WeakMap<object, { api: GithubApi; login: string; token: string | undefined; oauth: boolean }>()
  const clientId = (ctx: SourceContext<GithubConfig>) => ctx.config.clientId || DEFAULT_GITHUB_CLIENT_ID
  const oauthToken = (ctx: SourceContext<GithubConfig>) => ctx.secret.get('token')

  const session = async (ctx: SourceContext<GithubConfig>) => {
    const stored = oauthToken(ctx)
    const known = apis.get(ctx)
    // Reuse the session unless the authorization changed (granted, replaced or removed) since it was made.
    if (known && (stored ? known.token === stored : !known.oauth)) return known
    const token = stored ?? await (deps.token ?? githubToken)()
    if (!token) throw Object.assign(new Error('还没有授权 GitHub：在 设置 → 来源 → GitHub 点「授权 GitHub」'), { status: 401 })
    const api = new GithubApi(ctx.config.apiUrl, token, f)
    let me: { login: string }
    try { me = await api.get<{ login: string }>('/user') } catch (error) {
      if (stored && (error as { status?: number }).status === 401) throw Object.assign(new Error('GitHub 授权已失效（可能在 GitHub 上被撤销了），请重新点「授权 GitHub」'), { status: 401 })
      throw error
    }
    const value = { api, login: me.login, token, oauth: Boolean(stored) }
    apis.set(ctx, value)
    ctx.state.set('login', me.login)
    ctx.facts({ 账号: me.login, 授权: stored ? 'OAuth 授权' : '环境变量 / gh 登录' })
    return value
  }

  // OAuth device flow (shared, auth.mjs): no callback URL, so it works on a headless box reached over `ssh -L`.
  const auth = oauth<GithubConfig>({
    flow: 'device', label: 'GitHub', fetch: f,
    clientId: config => config.clientId || DEFAULT_GITHUB_CLIENT_ID,
    deviceUrl: config => `${config.oauthUrl.replace(/\/$/, '')}/login/device/code`,
    tokenUrl: config => `${config.oauthUrl.replace(/\/$/, '')}/login/oauth/access_token`,
    scopes: GITHUB_SCOPES.split(' '),
    missingClient: '先在下面填写 OAuth App 的 Client ID 并保存（GitHub → Settings → Developer settings → OAuth Apps，勾选 Enable Device Flow）',
    deviceErrorHint: error => error === 'device_flow_disabled' ? '：这个 OAuth App 没有勾选 Enable Device Flow' : error === 'unauthorized_client' || error === 'Not Found' ? '：Client ID 不对' : undefined,
    disconnectConfirm: '断开后智能体将不能再读写你的 GitHub（除非本机还有 GITHUB_TOKEN 或 gh 登录）。确定断开？',
    onGrant: async (ctx, token) => {
      const me = await new GithubApi(ctx.config.apiUrl, token, f).get<{ login: string }>('/user')
      ctx.state.set('login', me.login)
      return { 账号: me.login, 授权: 'OAuth 授权' }
    },
    onDisconnect: ctx => ctx.facts({ 授权: '未授权' }),
  })

  const addressed = (ctx: SourceContext<GithubConfig>, text: string) => text.toLowerCase().includes(ctx.config.mention.toLowerCase())
  // Comments posted before the rename carry the old marker; they are ours too, so never answer them.
  const isOwn = (body: string | null | undefined) => Boolean(body?.includes(MARKER) || body?.includes('<!-- super-agent -->'))

  async function issue(ctx: SourceContext<GithubConfig>, api: GithubApi, repo: string, number: number, fresh = false): Promise<IssueInfo> {
    const key = `issue:${repo}#${number}`
    const cached = ctx.state.get<IssueInfo>(key)
    if (cached && !fresh) return cached
    const raw = await api.get<{ title: string; html_url: string; pull_request?: unknown; state: string }>(`/repos/${repo}/issues/${number}`)
    const info = { title: raw.title, url: raw.html_url, pr: Boolean(raw.pull_request), state: raw.state, repo, number }
    ctx.state.set(key, info)
    return info
  }

  const thread = (info: IssueInfo) => ({ title: `${info.repo}#${info.number} ${info.title}`, url: info.url, meta: { repo: info.repo, number: info.number, pr: info.pr } })

  async function pollRepo(ctx: SourceContext<GithubConfig>, api: GithubApi, login: string, repo: string) {
    const cursorKey = `cursor:${repo}`
    const since = ctx.state.get<string>(cursorKey) ?? new Date().toISOString()
    let next = since
    const bump = (t: string) => { if (t > next) next = t }
    const receive = (t: Parameters<typeof ctx.engine.receive>[0]) => ctx.engine.receive(t)

    // New issues and pull requests (their opening text).
    const issues = await api.get<any[]>(`/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`)
    for (const it of issues) {
      bump(it.updated_at)
      if (it.created_at <= since || isOwn(it.body)) continue
      const info: IssueInfo = { title: it.title, url: it.html_url, pr: Boolean(it.pull_request), state: it.state, repo, number: it.number }
      ctx.state.set(`issue:${repo}#${it.number}`, info)
      const text = `${it.title}\n\n${it.body ?? ''}`.trim()
      receive({ id: `github:issue:${repo}#${it.number}`, source: 'github', threadId: threadId(repo, it.number), actor: it.user.login,
        human: it.user.type !== 'Bot', addressed: addressed(ctx, text), text, at: Date.parse(it.created_at), url: it.html_url,
        meta: { kind: info.pr ? 'pull' : 'issue', repo, number: it.number }, thread: thread(info) })
    }
    // Conversation comments on issues and pull requests.
    const comments = await api.get<any[]>(`/repos/${repo}/issues/comments?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`)
    for (const c of comments) {
      bump(c.updated_at)
      if (c.created_at <= since || isOwn(c.body)) continue
      const number = Number(String(c.issue_url).split('/').pop())
      const info = await issue(ctx, api, repo, number)
      receive({ id: `github:comment:${c.id}`, source: 'github', threadId: threadId(repo, number), actor: c.user.login, human: c.user.type !== 'Bot',
        addressed: addressed(ctx, c.body ?? ''), text: c.body ?? '', at: Date.parse(c.created_at), url: c.html_url,
        meta: { kind: 'comment', repo, number }, thread: thread(info) })
    }
    // Inline review comments on pull requests.
    const reviewComments = await api.get<any[]>(`/repos/${repo}/pulls/comments?sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`)
    for (const c of reviewComments) {
      bump(c.updated_at)
      if (c.created_at <= since || isOwn(c.body)) continue
      const number = Number(String(c.pull_request_url).split('/').pop())
      const info = await issue(ctx, api, repo, number)
      receive({ id: `github:review-comment:${c.id}`, source: 'github', threadId: threadId(repo, number), actor: c.user.login, human: c.user.type !== 'Bot',
        addressed: addressed(ctx, c.body ?? ''), text: `${c.path}${c.line ? `:${c.line}` : ''}\n${c.body ?? ''}`, at: Date.parse(c.created_at), url: c.html_url,
        meta: { kind: 'review-comment', repo, number, path: c.path, line: c.line }, thread: thread(info) })
    }
    ctx.state.set(cursorKey, next)
  }

  /** Followed pull requests: reviews, CI conclusions and merge/close. */
  async function pollFollowed(ctx: SourceContext<GithubConfig>, api: GithubApi) {
    const followed = ctx.engine.followed().filter(f => f.threadId.startsWith('github:') && !f.closed)
    const seen = new Set<string>()
    for (const f of followed) {
      if (seen.has(f.threadId)) continue
      seen.add(f.threadId)
      const ref = parseThread(f.threadId)
      if (!ref) continue
      const info = await issue(ctx, api, ref.repo, ref.number, true)
      if (!info.pr) { if (info.state === 'closed' && f.kind === 'own') ctx.engine.threadClosed(f.threadId, 'closed'); continue }
      const pr = await api.get<any>(`/repos/${ref.repo}/pulls/${ref.number}`)
      // Reviews with a verdict or a body.
      const reviews = await api.get<any[]>(`/repos/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`)
      for (const r of reviews) {
        if (isOwn(r.body) || (!r.body && r.state === 'COMMENTED')) continue
        ctx.engine.receive({ id: `github:review:${r.id}`, source: 'github', threadId: f.threadId, actor: r.user.login, human: r.user.type !== 'Bot',
          addressed: addressed(ctx, r.body ?? ''), text: `[review ${r.state}] ${r.body ?? ''}`.trim(), at: Date.parse(r.submitted_at ?? pr.updated_at),
          url: r.html_url, meta: { kind: 'review', state: r.state }, thread: thread(info) })
      }
      // CI on the head commit: one trigger per (sha, outcome) once every check finished.
      const checks = await api.get<{ check_runs: any[] }>(`/repos/${ref.repo}/commits/${pr.head.sha}/check-runs?per_page=100`)
      const runs = checks.check_runs ?? []
      if (runs.length && runs.every(r => r.status === 'completed')) {
        const failed = runs.filter(r => !['success', 'neutral', 'skipped'].includes(r.conclusion))
        const outcome = failed.length ? 'failure' : 'success'
        ctx.engine.receive({ id: `github:ci:${ref.repo}#${ref.number}:${pr.head.sha}:${outcome}`, source: 'github', threadId: f.threadId, actor: 'github-actions[bot]',
          human: false, addressed: false, at: Date.now(), url: `${info.url}/checks`,
          text: failed.length ? `CI 失败（${pr.head.sha.slice(0, 7)}）：${failed.map(r => `${r.name}: ${r.conclusion}${r.details_url ? ` ${r.details_url}` : ''}`).join('；')}`
            : `CI 全部通过（${pr.head.sha.slice(0, 7)}，${runs.length} 项）`,
          meta: { kind: 'ci', sha: pr.head.sha, outcome }, thread: thread(info) })
      }
      if (pr.merged_at) ctx.engine.threadClosed(f.threadId, 'merged')
      else if (pr.state === 'closed') ctx.engine.threadClosed(f.threadId, 'closed')
    }
  }

  async function pollOnce(ctx: SourceContext<GithubConfig>): Promise<void> {
    const { api, login } = await session(ctx)
    for (const repo of ctx.config.repos) await pollRepo(ctx, api, login, repo)
    await pollFollowed(ctx, api)
  }

  return auth.source({
    id: 'github',
    title: 'GitHub',
    icon: 'github',
    description: '在 Issue / PR 里 @ 智能体即可派活；它会在原处回复、开 PR，并跟进评审与 CI。点「授权 GitHub」用你的 GitHub 账号登录授权即可接入。',
    schema: GithubConfigSchema,
    fields: [
      { key: 'repos', type: 'list', label: '监听的仓库', placeholder: 'owner/repo', hint: '每行一个' },
      { key: 'mention', type: 'text', label: '唤起词', hint: '评论中包含它才算在叫智能体（智能体以你的账号发言，所以不能用 @你自己）' },
      { key: 'allowed', type: 'list', label: '也允许这些账号派活', placeholder: 'github-login', hint: '默认只有授权的那个账号' },
      { key: 'pollSeconds', type: 'number', label: '轮询间隔（秒）', min: 15, max: 3600, advanced: true },
      { key: 'apiUrl', type: 'text', label: 'API 地址', advanced: true, hint: 'GitHub Enterprise 填 https://host/api/v3' },
      { key: 'clientId', type: 'text', label: 'OAuth App Client ID', placeholder: 'Ov23…', ...(DEFAULT_GITHUB_CLIENT_ID ? { advanced: true as const } : {}),
        hint: DEFAULT_GITHUB_CLIENT_ID ? '留空使用内置的应用' : '点下面的链接新建 OAuth App：名称随意，Homepage 和 Redirect URI 都填 http://127.0.0.1:7420；勾选 Enable Device Flow，取消勾选 Expire user access tokens（否则 8 小时就要重新授权），把 Client ID（Ov23 开头）填在这里。不需要 Client Secret',
        links: [{ label: '新建 GitHub OAuth App', href: 'https://github.com/settings/applications/new' }, { label: '已有的 OAuth Apps', href: 'https://github.com/settings/developers' }] },
      { key: 'oauthUrl', type: 'text', label: 'OAuth 地址', advanced: true, hint: 'GitHub Enterprise 填 https://host' },
    ],
    poll: pollOnce,
    start(ctx) {
      let timer: NodeJS.Timeout | undefined
      let failures = 0
      const loop = async () => {
        try {
          await pollOnce(ctx)
          failures = 0
          ctx.health('ok', `上次轮询 ${new Date().toLocaleTimeString()}`)
        } catch (error) {
          failures++
          const message = error instanceof Error ? error.message : String(error)
          ctx.log('poll failed:', message)
          if (failures >= 3 || (error as { status?: number }).status === 401) ctx.health('error', message)
        }
        if (!ctx.signal.aborted) timer = setTimeout(loop, ctx.config.pollSeconds * 1000)
      }
      void loop()
      return () => clearTimeout(timer)
    },
    allowed(ctx, actor) {
      const login = ctx.state.get<string>('login')
      return actor === login || ctx.config.allowed.includes(actor)
    },
    async send(ctx, message) {
      const ref = parseThread(message.threadId)
      if (!ref) return 'gone'
      const { api } = await session(ctx)
      try {
        const posted = await api.request<{ html_url: string }>('POST', `/repos/${ref.repo}/issues/${ref.number}/comments`,
          { body: `🤖 **Nuonuo**\n\n${message.text}\n\n${MARKER}` })
        return { url: posted.html_url }
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status === 404 || status === 410 || status === 422) return 'gone'
        throw error
      }
    },
    threadInfo(ctx, id) {
      const ref = parseThread(id)
      const info = ref && ctx.state.get<IssueInfo>(`issue:${ref.repo}#${ref.number}`)
      return info ? `${info.repo} ${info.pr ? 'pull request' : 'issue'} #${info.number} (${info.state}) "${info.title}" ${info.url}` : ref ? `${ref.repo} #${ref.number}` : undefined
    },
    workerPrompt(ctx, ticket) {
      const ref = parseThread(ticket.threadId)
      const repos = ctx.config.repos.join(', ')
      return `## GitHub
${ref ? `This task came from GitHub ${ref.repo} #${ref.number}. Read it first: \`gh issue view ${ref.number} -R ${ref.repo} --comments\` (or \`gh pr view\` / \`gh pr diff\` for a pull request).` : `Watched repositories: ${repos}.`}
- Use the \`gh\` CLI and git; they are logged in as the owner. Work in a clone inside your working directory (\`gh repo clone <repo> .\` when it is empty).
- Code changes: branch \`nuonuo/${ticket.name}\`, clear commits, push, then \`gh pr create\` with a body covering background, the change and how you verified it. Then call github_follow with the PR number so reviews and CI reach you.
- Your report is posted back to the GitHub thread by the main agent; don't post comments yourself unless the owner asked.
- Never push to the default branch, force-push shared branches, or merge unless the owner asked.`
    },
    workerTools(ctx, ticket) {
      return {
        github_follow: tool({
          description: 'Follow a GitHub pull request or issue you opened for this task, so its reviews, comments and CI results reach you and its merge ends the task.',
          inputSchema: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe('owner/repo; defaults to the task\'s repository'), number: z.number().int().positive() }),
          execute: async ({ repo, number }) => {
            const target = repo ?? parseThread(ticket.threadId)?.repo
            if (!target) throw new Error('需要 repo（owner/repo）')
            const { api } = await session(ctx)
            const info = await issue(ctx, api, target, number, true)
            ctx.engine.follow(ticket.id, threadId(target, number), 'own', thread(info))
            return `已跟进 ${info.url}`
          },
        }),
      }
    },
    workerEnv(ctx, ticket): Record<string, string> {
      const ref = parseThread(ticket.threadId)
      const env: Record<string, string> = ref ? { NUONUO_GITHUB_REPO: ref.repo, NUONUO_GITHUB_NUMBER: String(ref.number) } : {}
      // With an OAuth authorization there may be no `gh` login on this machine: lend the token to `gh` and to git over HTTPS.
      const token = oauthToken(ctx)
      if (token) {
        const host = new URL(ctx.config.oauthUrl).host
        Object.assign(env, host === 'github.com' ? { GH_TOKEN: token } : { GH_ENTERPRISE_TOKEN: token, GH_HOST: host },
          { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `credential.https://${host}.helper`, GIT_CONFIG_VALUE_0: '',
            GIT_CONFIG_KEY_1: `credential.https://${host}.helper`, GIT_CONFIG_VALUE_1: '!gh auth git-credential' })
      }
      return env
    },
  })
}
