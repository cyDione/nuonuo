// Instabox (https://instabox.sh) as a cloud computer for nuonuo. The plugin only knows how to reach the machine: its
// state, waking it, running one command and keeping it awake. nuonuo's shared cloud-computer layer does the rest (its
// own account on the machine, the shell, files and browsers): see docs/13-computers.md.
//
// The machine pauses itself when idle. A paused machine is woken (`/wake`), one the owner paused is resumed, and a
// stopped one is started, so the first command after a while takes a few seconds longer.

const API = 'https://api.instabox.sh'

export default ({ definePlugin, defineComputer }) => {
  /** The machine id, looked up from the setting (an id or a name, or the first machine) and kept for a while. */
  let cached

  const keyOf = ctx => String(ctx.settings.get('apiKey') ?? '').trim()

  async function api(ctx, method, path, body, opts = {}) {
    const headers = { 'X-API-Key': keyOf(ctx), Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.idempotent) headers['Idempotency-Key'] = `nuonuo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    let res
    try {
      res = await fetch(`${API}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) })
    } catch (error) {
      throw Object.assign(new Error(`连不上 Instabox：${error?.message ?? error}`), { retryable: true })
    }
    const text = await res.text()
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch {}
    if (!res.ok) {
      const e = data.error ?? {}
      const retryAfter = e.retryAfterSeconds ?? (Number(res.headers.get('retry-after')) || undefined)
      throw Object.assign(new Error(`Instabox ${res.status} ${e.code ?? ''}：${e.message ?? text.slice(0, 200)}`), { code: e.code, status: res.status, retryable: Boolean(e.retryable), retryAfterSeconds: retryAfter })
    }
    return data
  }

  async function machineId(ctx) {
    const want = String(ctx.settings.get('machine') ?? '').trim()
    if (cached && cached.want === want && cached.key === keyOf(ctx) && Date.now() - cached.at < 10 * 60_000) return cached.id
    const { machines = [] } = await api(ctx, 'GET', '/v1/machines')
    const m = want ? machines.find(x => x.id === want || x.name === want) : machines[0]
    if (!m) throw new Error(want ? `Instabox 账户里没有机器「${want}」` : 'Instabox 账户里还没有机器：先在 instabox.sh 建一台')
    cached = { want, key: keyOf(ctx), id: m.id, at: Date.now() }
    return m.id
  }

  /** The provider's machine as the shared layer sees it. */
  function view(m) {
    const cooldown = m.cooldownUntil ? Math.ceil((Date.parse(m.cooldownUntil) - Date.now()) / 1000) : 0
    const base = { name: m.name, ...(cooldown > 0 ? { retryAfterSeconds: cooldown } : {}) }
    if (m.operationId && m.state !== 'running') return { ...base, state: 'waking', detail: `正在${m.desiredState === 'running' ? '唤醒' : '切换'}` }
    switch (m.state) {
      case 'running': return m.runtime?.ready === false ? { ...base, state: 'waking', detail: '正在启动' } : { ...base, state: 'ready' }
      case 'suspended': case 'suspending':
        return { ...base, state: 'asleep', detail: cooldown > 0 ? `运行时间到了，冷却中` : m.autoSuspendedAt ? '空闲后自动休眠了' : '被手动暂停了' }
      case 'stopped': case 'stopping': return { ...base, state: 'off', detail: '已关机' }
      case 'error': return { ...base, state: 'error', detail: '机器出错了，到 instabox.sh 看看' }
      default: return { ...base, state: 'waking', detail: m.state }
    }
  }

  const get = async ctx => api(ctx, 'GET', `/v1/machines/${await machineId(ctx)}`)

  async function waitRunning(ctx, ms) {
    const until = Date.now() + ms
    for (;;) {
      const m = await get(ctx)
      const v = view(m)
      if (v.state === 'ready' || v.state === 'error' || Date.now() > until) return v
      if (v.state === 'asleep' && v.retryAfterSeconds) return v
      await new Promise(r => setTimeout(r, 2_000))
    }
  }

  const instabox = defineComputer({
    id: 'instabox',
    title: 'Instabox 云电脑',
    description: '云端的一台 Linux 机器（4 核 8 GB），空闲时自动休眠',
    capabilities: {
      sudo: true, docker: true, sleeps: true, dataDir: '/data', maxExecSeconds: 600,
      // Browsers started from a shell show up on the machine's desktop unless told not to: that desktop is the owner's.
      env: { INSTABOX_HEADLESS: '1' },
    },
    async status(ctx) {
      if (!keyOf(ctx)) return { state: 'unconfigured', detail: '在插件设置里填上 Instabox 的 API key' }
      try { return view(await get(ctx)) } catch (error) {
        if (error.status === 401) return { state: 'unconfigured', detail: 'API key 无效或过期了，到插件设置里换一个' }
        if (error.status === 404) { cached = undefined; return { state: 'unconfigured', detail: '找不到设置的机器' } }
        return { state: 'error', detail: error.message }
      }
    },
    async wake(ctx) {
      const id = await machineId(ctx)
      const m = await get(ctx)
      const v = view(m)
      if (v.state === 'ready') return v
      if (v.retryAfterSeconds && v.state === 'asleep') return v
      try {
        if (m.state === 'stopped') await api(ctx, 'POST', `/v1/machines/${id}/start`, {}, { idempotent: true })
        else if (m.state === 'suspended' && !m.autoSuspendedAt) await api(ctx, 'POST', `/v1/machines/${id}/resume`, {}, { idempotent: true })
        else if (m.state === 'suspended' || m.state === 'suspending') await api(ctx, 'POST', `/v1/machines/${id}/wake`, {}, { timeoutMs: 90_000 })
      } catch (error) {
        if (error.code === 'machine_cooldown') return { state: 'asleep', name: m.name, detail: '运行时间到了，冷却中', retryAfterSeconds: error.retryAfterSeconds }
        if (error.code !== 'operation_conflict') throw error
      }
      return waitRunning(ctx, 180_000)
    },
    async exec(ctx, { command, stdin, timeoutSeconds }) {
      const id = await machineId(ctx)
      const body = { cmd: command, timeoutSeconds: Math.max(1, Math.min(600, Math.round(timeoutSeconds))), ...(stdin !== undefined ? { stdin } : {}) }
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api(ctx, 'POST', `/v1/machines/${id}/exec`, body, { timeoutMs: (body.timeoutSeconds + 75) * 1000 })
          return { exitCode: r.exitCode ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: Boolean(r.timedOut), truncated: Boolean(r.truncated) }
        } catch (error) {
          // Too many requests at once, or the machine still waking: wait a little and try again.
          if (attempt < 3 && (error.code === 'quota_exceeded' || (error.code === 'operation_conflict' && error.retryable) || error.code === 'host_unavailable')) {
            await new Promise(r => setTimeout(r, Math.min(10, error.retryAfterSeconds ?? 2 + attempt * 2) * 1000))
            continue
          }
          throw error
        }
      }
    },
    async keepAwake(ctx, { key, seconds }) {
      const id = await machineId(ctx)
      await api(ctx, 'PUT', `/v1/machines/${id}/activity-leases/${encodeURIComponent(`nuonuo-${key}`.slice(0, 64))}`, { ttlSeconds: Math.max(30, Math.min(3600, seconds)) })
    },
  })

  return definePlugin({
    id: 'instabox',
    name: 'Instabox 云电脑',
    version: '0.1.0',
    description: '把 Instabox 的云端 Linux 机器接成糯糯自己的云电脑',
    computers: [instabox],
  })
}
