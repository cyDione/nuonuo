/**
 * 看它的浏览器 (Figma section 25, M): in 活动, a task that uses its browser shows where its tab is, a look at the page
 * (只看，不会打断它: the picture refreshes, nothing is sent to the page) and the steps it took, each with the small
 * picture taken right after it. Taking over stays in the task's own card (handoff), not here.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Eye, EyeOff, Globe, LoaderCircle, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type BrowserStep, type Ticket } from './api'
import { cx } from './ui'

const host = (url: string) => { try { return new URL(url).host } catch { return url } }
const minutes = (from: number) => Math.max(1, Math.round((Date.now() - from) / 60_000))

export function BrowserWatch({ t }: { t: Ticket }) {
  const state = useQuery({ queryKey: ['browser', t.id], queryFn: () => api.get<{ state: { url: string; title: string; handoff: boolean } | null; steps: BrowserStep[] }>(`/browser/${t.id}/state`), refetchInterval: 4_000 })
  const stop = useMutation({ mutationFn: () => api.post(`/tickets/${t.id}/stop`) })
  const [looking, setLooking] = useState(false)
  const [big, setBig] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!looking) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setTick(n => n + 1) }, 2_000)
    return () => clearInterval(timer)
  }, [looking])
  const s = state.data
  if (!s || (!s.state && !s.steps.length)) return null
  const steps = s.steps
  const latest = steps.at(-1)
  const picture = looking && s.state ? `/api/browser/${t.id}/screenshot?t=${tick}` : latest?.shot ? `/api/browser/${t.id}/steps/${latest.n}` : null
  return <div className="mt-2 overflow-hidden rounded-2xl border border-line">
    <div className="flex items-start gap-2.5 px-3.5 pt-3">
      <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{t.title}</span>
        <span className="block text-[11px] text-faint tabular-nums">第 {steps.length} 步 · 已经 {minutes(t.createdAt)} 分钟</span>
      </span>
      <button onClick={() => stop.mutate()} disabled={stop.isPending} aria-label="停下" title="停下" className="press flex size-8 shrink-0 items-center justify-center rounded-full border border-line hover:border-faint"><Square size={11} fill="currentColor" /></button>
    </div>
    {s.state && <div className="mx-3.5 mt-3 overflow-hidden rounded-xl border border-line bg-sunken">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-muted">
        <Globe size={12} className="shrink-0" /><span className="min-w-0 flex-1 truncate">{s.state.url}</span>
        {looking && <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent px-1.5 py-px text-[10px] font-medium text-accent-fg"><span className="size-1.5 rounded-full bg-accent-fg" />实时</span>}
      </div>
      {picture && <img src={picture} alt={s.state.title || '它的浏览器'} className="block aspect-[16/10] w-full bg-card object-cover object-top" />}
    </div>}
    {s.state && <div className="px-3.5 pt-2">
      <button onClick={() => setLooking(v => !v)} aria-pressed={looking} className="press flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-sunken text-[13px] hover:bg-hero-2">
        {looking ? <><EyeOff size={14} />不看了</> : <><Eye size={14} />看一眼（只看，不会打断它）</>}
      </button>
    </div>}
    {steps.length > 0 && <div className="px-3.5 pt-3 pb-3">
      <div className="mb-1.5 text-[11px] text-faint">做过的步骤</div>
      <div className="space-y-2">{steps.slice(-6).map((step, i, list) => <div key={step.n} className="flex items-center gap-2.5">
        {i === list.length - 1 && t.stage === 'working' ? <LoaderCircle size={14} className="shrink-0 animate-spin text-accent" /> : <Check size={14} className="shrink-0 text-ok" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{step.action}</span>
          <span className="block truncate text-[11px] text-faint">{host(step.url)}{step.title ? ` · ${step.title}` : ''}</span>
        </span>
        {step.shot && <button onClick={() => setBig(step.n)} aria-label={`放大第 ${step.n + 1} 步的截图`} className="press shrink-0 overflow-hidden rounded-lg border border-line">
          <img src={`/api/browser/${t.id}/steps/${step.n}`} alt="" loading="lazy" className="h-9 w-16 object-cover object-top" /></button>}
      </div>)}</div>
      <p className="mt-2.5 text-[11px] text-faint">点步骤右边的小图，能放大看那一刻的截图。</p>
    </div>}
    {big != null && <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-6" onMouseDown={e => { if (e.target === e.currentTarget) setBig(null) }}>
      <div className={cx('anim-pop relative max-h-full max-w-4xl overflow-hidden rounded-2xl bg-panel shadow-2xl')}>
        <img src={`/api/browser/${t.id}/steps/${big}`} alt="那一步的截图" className="block max-h-[80dvh] w-auto" />
        <div className="flex items-center gap-2 px-4 py-2.5 text-[13px]"><span className="min-w-0 flex-1 truncate">{steps.find(x => x.n === big)?.action}</span>
          <button onClick={() => setBig(null)} aria-label="关闭" className="press flex size-7 items-center justify-center rounded-full hover:bg-sunken"><X size={15} /></button></div>
      </div>
    </div>}
  </div>
}
