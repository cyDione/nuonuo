// An example Super-assistant plugin: watches RSS/Atom feeds.
// Matching items either become a notice in this source's conversation ("notify"), or a request to the agent ("agent"),
// e.g. "summarize this article for me". Copy this folder into ~/.super-assistant/plugins/ and enable it in Settings → 插件.

/** @param {import('@super-assistant/plugin-sdk').PluginSdk} sdk */
export default function plugin({ definePlugin, z }) {
  const Config = z.object({
    feeds: z.array(z.string().url()).default([]),
    keywords: z.array(z.string()).default([]),
    mode: z.enum(['notify', 'agent']).default('notify'),
    instruction: z.string().default('用三句话总结这篇文章，并告诉我值不值得读原文。'),
    pollMinutes: z.number().int().min(5).max(1440).default(30),
  })

  /** Tiny RSS/Atom item extraction; good enough for an example. */
  function items(xml) {
    const out = []
    for (const block of xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? []) {
      const pick = tag => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) ?? [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? ''
      const link = pick('link') || (block.match(/<link[^>]*href="([^"]+)"/) ?? [])[1] || ''
      out.push({ id: pick('guid') || pick('id') || link, title: pick('title'), link, summary: pick('description') || pick('summary') })
    }
    return out
  }

  async function poll(ctx) {
    const seen = new Set(ctx.state.get('seen') ?? [])
    const first = !ctx.state.get('initialized')
    for (const feed of ctx.config.feeds) {
      const res = await fetch(feed, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'super-assistant-rss/0.1' } })
      if (!res.ok) throw new Error(`${feed} → ${res.status}`)
      for (const item of items(await res.text())) {
        if (!item.id || seen.has(item.id)) continue
        seen.add(item.id)
        if (first) continue // do not flood on the first run
        const text = `${item.title} ${item.summary}`.toLowerCase()
        if (ctx.config.keywords.length && !ctx.config.keywords.some(k => text.includes(k.toLowerCase()))) continue
        if (ctx.config.mode === 'notify') ctx.notify(`**${item.title}**\n${item.link}`, { title: '📰 RSS 订阅' })
        else ctx.engine.receive({
          id: `rss:${item.id}`, source: 'rss', threadId: `rss:${item.id}`, actor: 'owner', human: true, addressed: true, at: Date.now(),
          text: `订阅源有新文章「${item.title}」：${item.link}\n\n${ctx.config.instruction}`, url: item.link,
          thread: { title: `📰 ${item.title}`.slice(0, 60), url: item.link },
        })
      }
    }
    ctx.state.set('seen', [...seen].slice(-2000))
    ctx.state.set('initialized', true)
  }

  return definePlugin({
    id: 'rss-watch',
    name: 'RSS 订阅',
    version: '0.1.0',
    sources: [{
      id: 'rss',
      title: 'RSS 订阅',
      description: '监控 RSS/Atom 订阅：命中关键词时通知你，或者交给智能体处理（例如总结文章）。',
      schema: Config,
      fields: [
        { key: 'feeds', type: 'list', label: '订阅地址', placeholder: 'https://example.com/feed.xml' },
        { key: 'keywords', type: 'list', label: '关键词（留空表示全部）' },
        { key: 'mode', type: 'select', label: '命中后', options: [{ value: 'notify', label: '通知我' }, { value: 'agent', label: '交给智能体' }] },
        { key: 'instruction', type: 'text', label: '交给智能体时的要求' },
        { key: 'pollMinutes', type: 'number', label: '检查间隔（分钟）', min: 5, max: 1440, advanced: true },
      ],
      poll,
      start(ctx) {
        let timer
        const loop = async () => {
          try { await poll(ctx); ctx.health('ok', `上次检查 ${new Date().toLocaleTimeString()}`) } catch (e) { ctx.health('error', String(e.message ?? e)) }
          if (!ctx.signal.aborted) timer = setTimeout(loop, ctx.config.pollMinutes * 60_000)
        }
        void loop()
        return () => clearTimeout(timer)
      },
      // Items handed to the agent are written as the owner's own request (they configured this plugin).
      allowed: (_ctx, actor) => actor === 'owner',
    }],
  })
}
