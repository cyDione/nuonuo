/**
 * 点子 (Figma v6, 18c): a few things 糯糯 could do for you, thought up from what you talked about, your goals and what
 * changed. The skeleton never moves (a wide card and two narrow ones, then two cards and 「你可能还想」); only what is in
 * the cards changes. Each card can be put away with ×, and kinds you keep putting away come up less. 「去做」 opens a side
 * chat that starts with the card's offer. Cards come in one after another (fade and rise).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2, Sparkles, X } from 'lucide-react'
import { useEffect } from 'react'
import { api, ApiError, type Idea, type IdeaBatch, type IdeaSettings } from './api'
import { Avatar, usePersona } from './persona'
import { go } from './route'
import { cx } from './ui'
import { tx } from './i18n'

export const useIdeas = () => useQuery({ queryKey: ['ideas'], queryFn: () => api.get<{ batch: IdeaBatch | null; settings: IdeaSettings }>('/ideas') })

const CADENCE: Record<IdeaSettings['cadence'], string> = { daily: tx('每天早上换一批'), weekly: tx('每周换一批'), off: tx('已经关了，不会自己换') }

export function IdeasPage() {
  const persona = usePersona()
  const qc = useQueryClient()
  const { data } = useIdeas()
  const batch = data?.batch
  const settings = data?.settings
  useEffect(() => { if (batch && !batch.seen) void api.post('/ideas/seen').then(() => qc.invalidateQueries({ queryKey: ['ideas'] })) }, [batch?.at, batch?.seen])
  const refresh = useMutation({ mutationFn: () => api.post('/ideas/refresh'), onSettled: () => qc.invalidateQueries({ queryKey: ['ideas'] }) })

  const cards = (batch?.cards ?? []).filter(c => !c.dismissed && !c.done)
  const more = (batch?.more ?? []).filter(m => !m.done)
  const [wide, a, b, c, d] = cards
  const left = cards.length + more.length

  return <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-[61rem] px-4 pt-8 pb-16 md:px-6">
      <header className="anim-rise">
        <h1 className="font-display text-3xl font-semibold">{tx('给你的点子')}</h1>
        <p className="mt-1.5 text-sm text-muted">{tx('从你最近聊的、你的目标和它盯着的变化里想到的，')}{settings ? CADENCE[settings.cadence] : tx('每天早上换一批')}{tx('。点按钮就开一个侧聊。')}</p>
      </header>

      {batch && left > 0 && <div className="mt-6 space-y-4">
        {(wide || a || b) && <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr_1fr]">
          {[wide, a, b].map((idea, i) => idea && <Card key={idea.id} idea={idea} wide={i === 0} index={i} />)}
        </div>}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.6fr_1.6fr_1fr]">
          {[c, d].map((idea, i) => idea && <Card key={idea.id} idea={idea} index={3 + i} />)}
          {more.length > 0 && <More items={more} />}
        </div>
      </div>}

      {data && (!batch || !left) && <div className="mt-8 flex flex-col items-start gap-3 rounded-[22px] bg-sunken px-6 py-6">
        <p className="text-sm text-muted">{!batch ? tx('{0}还没想过点子。聊得越多，它想得越准。', persona.name) : tx('这一批都处理完了。')}</p>
        <button onClick={() => refresh.mutate()} disabled={refresh.isPending}
          className="press flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-ink-fg disabled:opacity-60">
          {refresh.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}{refresh.isPending ? tx('在想…') : tx('现在想几个')}
        </button>
        {refresh.error && <p className="text-xs text-warn">{refresh.error instanceof ApiError ? refresh.error.message : tx('没想出来，过会儿再试')}</p>}
      </div>}

      {batch && left > 0 && <div className="mt-8 flex items-center gap-3 text-sm text-muted">
        <Avatar persona={persona} size={28} mood="happy" />
        {settings?.cadence === 'weekly' ? tx('这周就这些。') : tx('今天就这些。')}{tx('点子太多会吵的话，在「设置 → 助理」里可以调成每周一次。')} </div>}
    </div>
  </div>
}

function useGo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ conversationId: string }>(`/ideas/${id}/go`),
    onSuccess: r => { qc.invalidateQueries({ queryKey: ['ideas'] }); qc.invalidateQueries({ queryKey: ['conversations'] }); go(`/c/${r.conversationId}`) },
  })
}

function Card({ idea, wide, index }: { idea: Idea; wide?: boolean; index: number }) {
  const qc = useQueryClient()
  const start = useGo()
  const dismiss = useMutation({ mutationFn: () => api.post(`/ideas/${idea.id}/dismiss`), onSuccess: () => qc.invalidateQueries({ queryKey: ['ideas'] }) })
  return <div data-tone={idea.tone} className={cx('flow feed-in relative flex min-h-[200px] flex-col rounded-[22px] px-5 pt-5 pb-5', wide && 'md:min-h-[200px]')} style={{ animationDelay: `${index * 70}ms` }}>
    <div className="relative flex items-start gap-3">
      <span className="min-w-0 flex-1 truncate text-xs opacity-85">{idea.label}</span>
      <button onClick={() => dismiss.mutate()} disabled={dismiss.isPending} aria-label={tx('不要这个')} title={tx('不要这个（这类会少推）')}
        className="press -mt-1 -mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-full opacity-80 hover:bg-white/15 hover:opacity-100"><X size={15} /></button>
    </div>
    <p className={cx('relative mt-3 font-semibold text-pretty', wide ? 'text-[18px] leading-7' : 'text-[16px] leading-[1.65]')}>{idea.text}</p>
    <div className="relative mt-auto pt-5">
      <button onClick={() => start.mutate(idea.id)} disabled={start.isPending}
        className="press rounded-full bg-white px-3.5 py-1.5 text-[13px] font-medium text-[#1a1a1a] disabled:opacity-70">{start.isPending ? tx('在开…') : idea.action}</button>
    </div>
  </div>
}

function More({ items }: { items: IdeaBatch['more'] }) {
  const start = useGo()
  return <div className="feed-in rounded-[22px] bg-sunken px-5 pt-5 pb-3" style={{ animationDelay: '350ms' }}>
    <div className="text-xs text-muted">{tx('你可能还想')}</div>
    <div className="mt-2">{items.map(m => <button key={m.id} onClick={() => start.mutate(m.id)} disabled={start.isPending}
      className="group flex w-full items-center gap-2 py-2.5 text-left text-sm">
      <span className="min-w-0 flex-1 truncate">{m.text}</span>
      <ChevronRight size={15} className="shrink-0 text-faint transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
    </button>)}</div>
  </div>
}
