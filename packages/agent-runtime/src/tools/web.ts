import { tool } from 'ai'
import { z } from 'zod'
import type { Blobs } from '../blobs'

/** Crude HTML → text: enough for docs and articles; scripts, styles and tags are dropped. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function webTools(blobs: Blobs) {
  return {
    web_fetch: tool({
      description: 'Fetch a URL (http/https) and return its text content. HTML is converted to plain text.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        if (!/^https?:\/\//.test(url)) throw new Error('只支持 http/https')
        const res = await fetch(url, { headers: { 'user-agent': 'super-agent/0.1 (+local personal agent)' }, signal: AbortSignal.timeout(30_000), redirect: 'follow' })
        const type = res.headers.get('content-type') ?? ''
        const body = await res.text()
        const text = type.includes('html') ? htmlToText(body) : body
        return blobs.spill('web', `[${res.status} ${type}] ${res.url}\n\n${text}`)
      },
    }),
  }
}
