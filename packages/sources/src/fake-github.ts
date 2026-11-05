/** An in-memory stand-in for the parts of the GitHub REST API the source uses (tests and local end-to-end runs). */
import { createServer, type Server } from 'node:http'

interface User { login: string; type: 'User' | 'Bot' }
interface Issue { number: number; title: string; body: string; user: User; state: 'open' | 'closed'; pr?: { head: string; merged: boolean }; created_at: string; updated_at: string }
interface Comment { id: number; number: number; body: string; user: User; created_at: string; updated_at: string; review?: { path: string; line: number } }
interface Review { id: number; number: number; state: string; body: string; user: User; submitted_at: string }

export class FakeGithub {
  issues = new Map<string, Issue>()
  comments: (Comment & { repo: string })[] = []
  reviews: (Review & { repo: string })[] = []
  checks = new Map<string, { name: string; status: string; conclusion: string | null }[]>()
  private seq = 1000
  private clock = Date.now()
  readonly base = 'http://fake-github.local'
  me: User
  /** OAuth device flow: the code shown to the owner, and whether they entered it on the (fake) github.com. */
  device = { clientId: 'client-1', deviceCode: 'device-1', userCode: 'ABCD-1234', token: 'oauth-token-1', approved: false, polls: 0 }
  approve() { this.device.approved = true }
  /** The Authorization header of the last API call. */
  lastAuth: string | undefined

  constructor(login = 'me') { this.me = { login, type: 'User' } }

  static sha(head: string) { return `sha-${head.replace(/[^\w-]/g, '-')}` }

  now() { this.clock = Math.max(Date.now(), this.clock + 1000); return new Date(this.clock).toISOString() }
  user(login: string): User { return { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' } }

  openIssue(repo: string, by: string, title: string, body = '', pr?: { head: string }): number {
    const number = [...this.issues.keys()].filter(k => k.startsWith(`${repo}#`)).length + 1
    const at = this.now()
    this.issues.set(`${repo}#${number}`, { number, title, body, user: this.user(by), state: 'open', ...(pr ? { pr: { ...pr, merged: false } } : {}), created_at: at, updated_at: at })
    return number
  }
  comment(repo: string, number: number, by: string, body: string, review?: { path: string; line: number }): number {
    const at = this.now()
    const id = ++this.seq
    this.comments.push({ id, repo, number, body, user: this.user(by), created_at: at, updated_at: at, ...(review ? { review } : {}) })
    const issue = this.issues.get(`${repo}#${number}`)
    if (issue) issue.updated_at = at
    return id
  }
  review(repo: string, number: number, by: string, state: string, body: string) {
    this.reviews.push({ id: ++this.seq, repo, number, state, body, user: this.user(by), submitted_at: this.now() })
  }
  merge(repo: string, number: number) {
    const issue = this.issues.get(`${repo}#${number}`)!
    issue.state = 'closed'; issue.pr!.merged = true; issue.updated_at = this.now()
  }

  /** A `fetch` that serves this fake. */
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    this.lastAuth = (init?.headers as Record<string, string> | undefined)?.authorization
    const body = parseBody(init?.body ? String(init.body) : '')
    const result = this.route(method, url, body)
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  }

  /** Serves the fake over HTTP (for a daemon under test). */
  listen(port: number): Promise<Server> {
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const c of req) raw += c
      const result = this.route(req.method ?? 'GET', new URL(req.url ?? '/', `http://127.0.0.1:${port}`), parseBody(raw))
      res.writeHead(result.status, { 'content-type': 'application/json' }).end(result.body === undefined ? '' : JSON.stringify(result.body))
    })
    return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
  }

  private route(method: string, url: URL, body: any): { status: number; body?: unknown } {
    const p = url.pathname.replace(/^\/api\/v3/, '')
    const since = url.searchParams.get('since') ?? ''
    const html = (repo: string, n: number, frag = '') => `https://github.com/${repo}/issues/${n}${frag}`
    let m: RegExpExecArray | null
    if (p === '/login/device/code' && method === 'POST') {
      if (body.client_id !== this.device.clientId) return { status: 200, body: { error: 'unauthorized_client' } }
      return { status: 200, body: { device_code: this.device.deviceCode, user_code: this.device.userCode, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0 } }
    }
    if (p === '/login/oauth/access_token' && method === 'POST') {
      this.device.polls++
      if (body.device_code !== this.device.deviceCode) return { status: 200, body: { error: 'bad_verification_code' } }
      return { status: 200, body: this.device.approved ? { access_token: this.device.token, token_type: 'bearer', scope: body.scope ?? '' } : { error: 'authorization_pending' } }
    }
    if (p === '/user') return { status: 200, body: this.me }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments$/.exec(p))) {
      const repo = m[1]!
      return { status: 200, body: this.comments.filter(c => c.repo === repo && !c.review && c.updated_at >= since).map(c => ({
        id: c.id, body: c.body, user: c.user, created_at: c.created_at, updated_at: c.updated_at, html_url: html(repo, c.number, `#issuecomment-${c.id}`),
        issue_url: `https://api.github.com/repos/${repo}/issues/${c.number}` })) }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/comments$/.exec(p))) {
      const repo = m[1]!
      return { status: 200, body: this.comments.filter(c => c.repo === repo && c.review && c.updated_at >= since).map(c => ({
        id: c.id, body: c.body, user: c.user, created_at: c.created_at, updated_at: c.updated_at, path: c.review!.path, line: c.review!.line,
        html_url: html(repo, c.number, `#discussion_r${c.id}`), pull_request_url: `https://api.github.com/repos/${repo}/pulls/${c.number}` })) }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(p))) {
      const repo = m[1]!
      return { status: 200, body: [...this.issues.entries()].filter(([k, i]) => k.startsWith(`${repo}#`) && i.updated_at >= since).map(([, i]) => this.issueJson(repo, i)) }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(p)) && method === 'POST') {
      const id = this.comment(m[1]!, Number(m[2]), this.me.login, body.body)
      return { status: 201, body: { id, html_url: html(m[1]!, Number(m[2]), `#issuecomment-${id}`) } }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(p))) {
      const issue = this.issues.get(`${m[1]}#${m[2]}`)
      return issue ? { status: 200, body: this.issueJson(m[1]!, issue) } : { status: 404, body: { message: 'Not Found' } }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(p))) {
      return { status: 200, body: this.reviews.filter(r => r.repo === m![1] && r.number === Number(m![2])).map(r => ({ ...r, html_url: html(r.repo, r.number, `#pullrequestreview-${r.id}`) })) }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(p))) {
      const issue = this.issues.get(`${m[1]}#${m[2]}`)
      if (!issue?.pr) return { status: 404, body: { message: 'Not Found' } }
      return { status: 200, body: { number: issue.number, state: issue.state, merged_at: issue.pr.merged ? issue.updated_at : null, updated_at: issue.updated_at, head: { sha: FakeGithub.sha(issue.pr.head), ref: issue.pr.head } } }
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs$/.exec(p))) {
      return { status: 200, body: { check_runs: (this.checks.get(m[2]!) ?? []).map((c, i) => ({ id: i, ...c, details_url: `https://ci.local/${i}` })) } }
    }
    return { status: 404, body: { message: `fake github: no route ${method} ${p}` } }
  }

  private issueJson(repo: string, i: Issue) {
    return { number: i.number, title: i.title, body: i.body, user: i.user, state: i.state, created_at: i.created_at, updated_at: i.updated_at,
      html_url: `https://github.com/${repo}/${i.pr ? 'pull' : 'issues'}/${i.number}`, ...(i.pr ? { pull_request: { url: '' } } : {}) }
  }
}

/** JSON, or a form body (the OAuth endpoints). */
function parseBody(raw: string): any {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return Object.fromEntries(new URLSearchParams(raw)) }
}
