/**
 * 心境 in 它是谁 (Figma section 29, 197:1183): the switch (its only entry), one line on how it is, three meters
 * (心情 from the centre line, 精力, 信任), the last 50 turns of mood, and 回到初始 with an inline confirm.
 * Black, white and grey only: this view's colour belongs to the 灵魂 / 记忆 buttons.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from './api'
import { Switch } from './skills'
import { tx } from './i18n'
import { cx } from './ui'

interface MoodPoint { at: number; mood: number; energy: number; trust: number }
export interface MoodView { enabled: boolean; mood: number; energy: number; trust: number; summary: string; history: MoodPoint[] }

const pick = (v: number, lo: number, hi: number, words: string[]) => words[Math.min(words.length - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * words.length)))]!
/** The same words the assistant hears about itself (packages/plugins/src/mood.ts). */
export function moodLine(m: { mood: number; energy: number }): string {
  const mood = pick(m.mood, -1, 1, [tx('低落'), tx('有点闷'), tx('心情平静'), tx('心情不错'), tx('心情很好')])
  const energy = pick(m.energy, 0, 1, [tx('没什么劲'), tx('平稳'), tx('有精神')])
  return tx('{0}，{1}', mood, energy)
}

/** A thin track; the fill moves with transform only, so a change glides instead of jumping. */
function Meter({ label, value, shown, centred }: { label: string; value: number; shown: string; centred?: boolean }) {
  const v = Math.max(-1, Math.min(1, value))
  return <div className="contents text-[13px]">
    <span className="text-[13px] text-muted">{label}</span>
    <span className="relative h-1.5 overflow-hidden rounded-full bg-line" role="meter" aria-label={label} aria-valuemin={centred ? -1 : 0} aria-valuemax={1} aria-valuenow={v}>
      {centred
        ? <>
          <span className={cx('absolute inset-y-0 w-1/2 rounded-full bg-fg transition-transform duration-[240ms] ease-[var(--ease-out-strong)] motion-reduce:transition-none', v >= 0 ? 'left-1/2 origin-left' : 'right-1/2 origin-right')}
            style={{ transform: `scaleX(${Math.abs(v)})` }} />
          <span className="absolute inset-y-0 left-1/2 w-px bg-faint" />
        </>
        : <span className="absolute inset-0 origin-left rounded-full bg-fg transition-transform duration-[240ms] ease-[var(--ease-out-strong)] motion-reduce:transition-none" style={{ transform: `scaleX(${Math.max(0, v)})` }} />}
    </span>
    <span className="text-right text-xs text-muted tabular-nums">{shown}</span>
  </div>
}

/** The mood of the last turns as one line; the dashed rule is where it settles back to. Data, so it never animates. */
function Trend({ points }: { points: MoodPoint[] }) {
  const W = 312, H = 36
  const y = (v: number) => H / 2 - v * (H / 2.2)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(points.length === 1 ? W - 4 : i / (points.length - 1) * (W - 4)).toFixed(1)} ${y(p.mood).toFixed(1)}`).join(' ')
  const last = points.at(-1)
  return <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible text-fg" aria-hidden>
    <line x1={0} x2={W} y1={y(0.2)} y2={y(0.2)} className="stroke-line" strokeDasharray="3 3" />
    {points.length > 1 && <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    {last && <circle cx={W - 4} cy={y(last.mood)} r={3} fill="currentColor" />}
  </svg>
}

export function MoodSection({ Head }: { Head: React.ComponentType<{ title: string; count?: number | string | undefined; action?: React.ReactNode }> }) {
  const qc = useQueryClient()
  const view = useQuery({ queryKey: ['mood'], queryFn: () => api.get<{ mood: MoodView }>('/mood'), refetchInterval: 20_000 }).data?.mood
  const put = (data: { mood: MoodView }) => qc.setQueryData(['mood'], data)
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.put<{ mood: MoodView }>('/mood', { enabled }),
    onMutate: enabled => qc.setQueryData<{ mood: MoodView }>(['mood'], old => old && { mood: { ...old.mood, enabled } }), onSuccess: put, onError: () => qc.invalidateQueries({ queryKey: ['mood'] }) })
  const reset = useMutation({ mutationFn: () => api.post<{ mood: MoodView }>('/mood/reset', {}), onSuccess: d => { put(d); setConfirm(false) } })
  const [confirm, setConfirm] = useState(false)
  if (!view) return null
  return <section className="border-t border-line pt-5">
    <Head title={tx('心境')} action={<span className="-my-1.5 self-center"><Switch on={view.enabled} onChange={v => toggle.mutate(v)} label={tx('心境')} disabled={toggle.isPending} /></span>} />
    {!view.enabled ? <p className="text-[13px] text-faint">{tx('关着。')}</p> : <div className="space-y-3">
      <p className="text-[15px] font-medium text-pretty">{moodLine(view)}</p>
      <div className="grid grid-cols-[auto_1fr_2.5rem] items-center gap-x-2.5 gap-y-2.5">
        <Meter label={tx('心情')} value={view.mood} shown={`${view.mood > 0 ? '+' : ''}${view.mood.toFixed(2)}`} centred />
        <Meter label={tx('精力')} value={view.energy} shown={view.energy.toFixed(2)} />
        <Meter label={tx('信任')} value={view.trust / 100} shown={String(Math.round(view.trust))} />
      </div>
      <Trend points={view.history} />
      <div className="flex items-center gap-2 text-xs">
        <span className="flex-1 text-[11px] text-faint">{view.history.length ? tx('最近 {0} 轮', view.history.length) : tx('还没有记录')}</span>
        {confirm ? <>
          <span className="text-muted">{tx('回到初始？')}</span>
          <button onClick={() => reset.mutate()} disabled={reset.isPending} className="press font-medium text-fg">{tx('确定')}</button>
          <button onClick={() => setConfirm(false)} className="press text-muted hover:text-fg">{tx('取消')}</button>
        </> : <button onClick={() => setConfirm(true)} className="press text-muted hover:text-fg">{tx('回到初始')}</button>}
      </div>
    </div>}
  </section>
}
