/**
 * Deliverables shown in place (Muse: "rich, bespoke interfaces rather than text"): Markdown rendered, CSV as a table,
 * images and PDFs as themselves, and HTML — trackers, dashboards, itineraries — live in an isolated sandbox.
 */
import { useQuery } from '@tanstack/react-query'
import { Download, ExternalLink, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type PreviewKind = 'markdown' | 'csv' | 'image' | 'pdf' | 'html' | 'text' | 'none'

export function previewKind(name: string): PreviewKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (['csv', 'tsv'].includes(ext)) return 'csv'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (['txt', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'py', 'js', 'ts', 'tsx', 'jsx', 'sh', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'rb', 'php', 'sql', 'css', 'xml', 'svg', 'patch', 'diff'].includes(ext)) return 'text'
  return 'none'
}

const url = (id: string) => `/api/artifacts/${id}`

function useText(id: string, enabled: boolean) {
  return useQuery({ queryKey: ['artifact-text', id], enabled, staleTime: 60_000, queryFn: async () => {
    const res = await fetch(url(id), { credentials: 'same-origin' })
    if (!res.ok) throw new Error(res.status === 404 ? '文件已不存在' : `读取失败（${res.status}）`)
    return res.text()
  } })
}

function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false; else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

export function ArtifactBody({ id, name }: { id: string; name: string }) {
  const kind = previewKind(name)
  const text = useText(id, ['markdown', 'csv', 'html', 'text'].includes(kind))
  if (kind === 'image') return <img src={url(id)} alt={name} className="mx-auto max-h-[70vh] rounded-lg" />
  if (kind === 'pdf') return <iframe src={url(id)} title={name} className="h-[75vh] w-full rounded-lg border border-line" />
  if (kind === 'none') return <p className="py-10 text-center text-sm text-muted">这种文件没法在这里预览，可以下载后打开。</p>
  if (text.error) return <p className="py-10 text-center text-sm text-danger">{(text.error as Error).message}</p>
  if (!text.data) return <p className="py-10 text-center text-sm text-faint">读取中…</p>
  if (kind === 'markdown') return <div className="prose-chat text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text.data}</ReactMarkdown></div>
  if (kind === 'csv') {
    const rows = parseCsv(text.data, name.toLowerCase().endsWith('.tsv') ? '\t' : ',').slice(0, 500)
    return <div className="overflow-auto rounded-lg border border-line"><table className="w-full text-xs">
      <thead className="sticky top-0 bg-sunken"><tr>{rows[0]?.map((c, i) => <th key={i} className="border-b border-line px-2 py-1.5 text-left font-medium">{c}</th>)}</tr></thead>
      <tbody>{rows.slice(1).map((r, i) => <tr key={i} className="border-b border-line last:border-0">{r.map((c, j) => <td key={j} className="px-2 py-1 align-top">{c}</td>)}</tr>)}</tbody>
    </table></div>
  }
  // No same-origin: the page runs its scripts but cannot reach the app, its cookies or the API.
  if (kind === 'html') return <iframe srcDoc={text.data} title={name} sandbox="allow-scripts allow-popups allow-forms" className="h-[75vh] w-full rounded-lg border border-line bg-white" />
  return <pre className="max-h-[75vh] overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs whitespace-pre-wrap">{text.data}</pre>
}

export function ArtifactModal({ id, name, onClose }: { id: string; name: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  // Portalled to <body>: a transformed or clipped ancestor (list rows animate in) would otherwise trap the fixed overlay.
  return createPortal(<div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4 " onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div role="dialog" aria-modal="true" aria-label={name} className="anim-pop flex max-h-[92vh] w-full max-w-4xl flex-col rounded-3xl border border-line bg-panel shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="min-w-0 flex-1 truncate font-display font-semibold">{name}</span>
        <a href={url(id)} target="_blank" rel="noreferrer" className="press rounded-full p-2 text-faint hover:bg-sunken hover:text-fg" title="新窗口打开" aria-label="新窗口打开"><ExternalLink size={16} /></a>
        <a href={`${url(id)}?download=1`} className="press rounded-full p-2 text-faint hover:bg-sunken hover:text-fg" title="下载" aria-label="下载"><Download size={16} /></a>
        <button onClick={onClose} className="press rounded-full p-2 text-faint hover:bg-sunken hover:text-fg" aria-label="关闭"><X size={18} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5"><ArtifactBody id={id} name={name} /></div>
    </div>
  </div>, document.body)
}
