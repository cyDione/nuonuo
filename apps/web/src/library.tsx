/**
 * 成果 (Figma v6, 19c): what 糯糯 and the owner made together, kept quietly here instead of in the conversation.
 * A filter row whose highlight slides to the chosen kind, and a grid of cards that zoom in one after another. Each card
 * shows the shape of what is inside (lines of a document, a table's grid, the picture itself) rather than a file icon.
 */
import { useQuery } from '@tanstack/react-query'
import { ArrowDownUp, FolderOpen, Image as ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { api, type Artifact, type Conversation } from './api'
import { ArtifactModal, previewKind } from './preview'
import { go } from './route'
import { Button, cx, Empty, Seg } from './ui'
import { tx } from './i18n'

type Kind = 'doc' | 'sheet' | 'image' | 'page' | 'other'
const KIND_LABEL: Record<Kind, string> = { doc: tx('文档'), sheet: tx('表格'), image: tx('图片'), page: tx('网页'), other: tx('文件') }
const ORDER: Kind[] = ['doc', 'sheet', 'image', 'page', 'other']

function kindOf(name: string): Kind {
  const k = previewKind(name)
  if (k === 'markdown' || k === 'pdf' || /\.(docx?|txt|rtf|pages)$/i.test(name)) return 'doc'
  if (k === 'csv' || /\.(xlsx?|numbers)$/i.test(name)) return 'sheet'
  if (k === 'image' || /\.svg$/i.test(name)) return 'image'
  if (k === 'html') return 'page'
  return 'other'
}
const day = (at: number) => {
  const d = new Date(at), now = new Date()
  if (d.toDateString() === now.toDateString()) return tx('今天')
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}` : d.toLocaleDateString()
}
const stem = (name: string) => name.replace(/\.[^.]+$/, '')

export function Library() {
  const items = useQuery({ queryKey: ['artifacts'], queryFn: () => api.get<{ artifacts: Artifact[] }>('/artifacts') }).data?.artifacts
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<{ conversations: Conversation[] }>('/conversations') }).data?.conversations ?? []
  const mainId = conversations.find(c => c.meta.main)?.id
  const [filter, setFilter] = useState<'all' | Kind>('all')
  const [byName, setByName] = useState(false)
  const [open, setOpen] = useState<Artifact | null>(null)

  const all = (items ?? []).map(a => ({ ...a, kind: kindOf(a.name) }))
  // Only the kinds there is something of get a filter, so no filter ever leads to an empty page.
  const kinds = ORDER.filter(k => all.some(a => a.kind === k))
  const shown = all.filter(a => filter === 'all' || a.kind === filter)
    .sort((a, b) => byName ? a.name.localeCompare(b.name, 'zh-CN') : b.createdAt - a.createdAt)
  const where = (a: Artifact) => !a.conversationId ? null : a.conversationId === mainId ? tx('主聊') : tx('侧聊')

  return <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-[56rem] px-4 pt-8 pb-16 md:px-6">
      <header className="anim-rise">
        <h1 className="font-display text-3xl font-semibold">{tx('成果')}</h1>
        <p className="mt-1.5 text-sm text-muted">{tx('你们一起做出来的东西，安静地放在这里，不会塞进聊天')}</p>
      </header>

      {items && !items.length && <div className="mt-10"><Empty icon={<FolderOpen size={26} />} title={tx('还没有东西')} action={<Button size="sm" variant="ink" onClick={() => go('/')}>{tx('去主聊交代一件事')}</Button>}> {tx('糯糯做完的事如果有文件（报告、表格、图片……），会跟着回复一起发给你，也会放在这里。')}</Empty></div>}

      {!!all.length && <div className="mt-7 flex items-center justify-between gap-3">
        {kinds.length > 1 ? <Seg<'all' | Kind> label={tx('筛选成果')} value={filter} onChange={setFilter} className="w-fit"
          options={[{ id: 'all', label: tx('全部') }, ...kinds.map(k => ({ id: k, label: KIND_LABEL[k] }))]} /> : <span />}
        <button onClick={() => setByName(v => !v)} className="press flex items-center gap-1 rounded-full px-2 py-1 text-[13px] text-muted hover:text-fg">
          {byName ? tx('按名字') : tx('最近')}<ArrowDownUp size={13} />
        </button>
      </div>}

      <div key={filter + byName} className="mt-5 grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((a, i) => <button key={a.id} onClick={() => setOpen(a)} className="card-in press group text-left" style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}>
          <Thumb a={a} kind={a.kind} />
          <div className="mt-2.5 truncate px-0.5 text-sm font-medium">{stem(a.name)}</div>
          <div className="mt-0.5 truncate px-0.5 text-xs text-faint">{[KIND_LABEL[a.kind], day(a.createdAt), where(a)].filter(Boolean).join(' · ')}</div>
        </button>)}
      </div>
    </div>
    {open && <ArtifactModal id={open.id} name={open.name} onClose={() => setOpen(null)} />}
  </div>
}

/** The card's top half: the shape of what is inside. */
function Thumb({ a, kind }: { a: Artifact; kind: Kind }) {
  const frame = 'relative h-40 overflow-hidden rounded-2xl bg-sunken transition-colors duration-150 group-hover:bg-hero-2'
  const [broken, setBroken] = useState(false)
  if (kind === 'image') return <div className={frame}>
    {broken ? <ImageIcon size={28} className="absolute inset-0 m-auto text-faint" />
      : <img src={`/api/artifacts/${a.id}`} alt="" loading="lazy" onError={() => setBroken(true)} className="size-full object-cover" />}
  </div>
  return <div className={frame}>
    <div className="absolute inset-x-[12%] top-5 bottom-0 rounded-t-lg bg-panel px-4 pt-4 shadow-[0_1px_2px_rgb(0_0_0/0.05)]">
      {kind === 'sheet' ? <div className="-mx-4 -mt-4 grid grid-cols-4">
        {Array.from({ length: 20 }, (_, i) => <span key={i} className={cx('h-[22px] border-r border-b border-line last:border-r-0', i < 4 && 'bg-sunken')}>
          {i === 9 && <span className="mx-1.5 mt-1.5 block h-2.5 rounded-sm bg-fg/75" />}
        </span>)}
      </div> : kind === 'page' ? <>
        <span className="block h-2 w-16 rounded-full bg-fg/80" />
        <span className="mt-3 block h-10 rounded-md bg-sunken" />
        <span className="mt-2.5 block h-1.5 w-3/4 rounded-full bg-line" />
        <span className="mt-2 block h-1.5 w-1/2 rounded-full bg-line" />
      </> : <>
        <span className="block h-2 w-20 rounded-full bg-fg/80" />
        {[92, 78, 88, 70, 90, 52].map((w, i) => <span key={i} className="mt-2.5 block h-1.5 rounded-full bg-line" style={{ width: `${w}%` }} />)}
      </>}
    </div>
  </div>
}
