/**
 * 主动 (Figma v7, 23 · I): how proactive it is, the strategy in the owner's own words, and its pace — how much it does
 * quietly at once and per day, whose events it ignores, and the quiet hours when it does not reach out. Its name and look
 * moved to the right pane's 它是谁.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type IdeaSettings, type NotifySettings, type ProactiveSettings } from '../api'
import { cx } from '../ui'
import { Area, Block, Btn, Choice, Foot, NumberInput, Page, Row, SaveBar, Section, TextInput, Toggle } from './kit'
import { useNotify } from './hooks'

const MODES: { id: ProactiveSettings['mode']; label: string }[] = [{ id: 'off', label: '关' }, { id: 'observe', label: '只留意' }, { id: 'auto', label: '主动去做' }]
const CADENCES: { id: IdeaSettings['cadence']; label: string }[] = [{ id: 'daily', label: '每天早上' }, { id: 'weekly', label: '每周一次' }, { id: 'off', label: '不要' }]
const BY: Record<string, string> = { owner: '你改的', router: '按你说的话改的', watchdog: '看门狗改的' }

export function AssistantPage() {
  const qc = useQueryClient()
  const proactive = useQuery({ queryKey: ['proactive'], queryFn: () => api.get<{ settings: ProactiveSettings; defaults: ProactiveSettings }>('/settings/proactive') }).data
  const notify = useNotify()
  const saveProactive = useMutation({
    mutationFn: (patch: Partial<ProactiveSettings>) => api.put('/settings/proactive', { ...proactive!.settings, ...patch }),
    onMutate: patch => qc.setQueryData<{ settings: ProactiveSettings }>(['proactive'], old => old && { ...old, settings: { ...old.settings, ...patch } }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['proactive'] }); qc.invalidateQueries({ queryKey: ['activity'] }) },
  })
  const ideas = useQuery({ queryKey: ['ideas'], queryFn: () => api.get<{ settings: IdeaSettings }>('/ideas') }).data?.settings
  const setCadence = useMutation({
    mutationFn: (cadence: IdeaSettings['cadence']) => api.put('/settings/ideas', { cadence }),
    onMutate: cadence => qc.setQueryData<{ settings: IdeaSettings }>(['ideas'], old => old && { ...old, settings: { ...old.settings, cadence } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ideas'] }),
  })
  const [strategy, setStrategy] = useState('')
  const [ignore, setIgnore] = useState('')
  useEffect(() => { if (proactive) { setStrategy(proactive.settings.strategy); setIgnore(proactive.settings.ignoreActors.join(', ')) } }, [proactive?.settings.version, proactive?.settings.strategy])
  if (!proactive) return <Page title="主动"><div /></Page>
  const s = proactive.settings
  const budget = (k: 'concurrent' | 'daily', v: string) => { const n = Math.max(1, Number(v) || 1); if (n !== s.budget[k]) saveProactive.mutate({ budget: { ...s.budget, [k]: n } }) }
  const quiet = notify.data?.settings.quiet
  const setQuiet = (patch: Partial<NotifySettings['quiet']>) => quiet && notify.save({ quiet: { ...quiet, ...patch } })
  return <Page title="主动">
    <Section title="多主动">
      <Row label="主动程度" sub="关：不主动找事 · 只留意：看到了告诉你 · 主动去做：能做的先做">
        <Choice label="主动程度" value={s.mode} onChange={mode => saveProactive.mutate({ mode })} options={MODES} className="w-[260px]" />
      </Row>
      {ideas && <Row label="点子" sub="多久换一批，换的时候在「点子」页">
        <Choice label="点子" value={ideas.cadence} onChange={c => setCadence.mutate(c)} options={CADENCES} className="w-[280px]" />
      </Row>}
    </Section>

    <section>
      <h2 className="mb-2 text-[13px] text-muted">主动的策略</h2>
      <div className="rounded-2xl bg-sunken px-4">
        <Block>
          <div className="mb-2.5 flex items-center gap-3">
            <span className="min-w-0 flex-1 text-sm">用你自己的话写：什么值得做、什么别管</span>
            <Btn onClick={() => setStrategy(proactive.defaults.strategy)}>用示例</Btn>
          </div>
          <Area value={strategy} onChange={e => setStrategy(e.target.value)} className="min-h-[92px]" />
        </Block>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
        <span className="mr-auto text-xs text-faint">{s.version ? `第 ${s.version} 版${s.by ? ` · ${BY[s.by] ?? s.by}` : ''}${s.at ? ` · ${new Date(s.at).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}` : '还没改过'}</span>
        <SaveBar dirty={strategy !== s.strategy} pending={saveProactive.isPending} error={saveProactive.error} onReset={() => setStrategy(s.strategy)} onSave={() => saveProactive.mutate({ strategy })} />
      </div>
    </section>

    <Section title="节奏" foot="要它留意哪些来源，在每个来源自己的页里打开「主动留意」。">
      <Row label="同时悄悄做的事" sub="最多几件">
        <NumberInput key={`c${s.budget.concurrent}`} min={1} max={10} defaultValue={s.budget.concurrent} onBlur={e => budget('concurrent', e.target.value)} aria-label="同时悄悄做的事" />
      </Row>
      <Row label="每天最多开始" sub="最多几件">
        <NumberInput key={`d${s.budget.daily}`} min={1} max={200} defaultValue={s.budget.daily} onBlur={e => budget('daily', e.target.value)} aria-label="每天最多开始" />
      </Row>
      <Row label="不理会的账号" sub="逗号分隔，比如机器人账号">
        <TextInput value={ignore} placeholder="dependabot, renovate" onChange={e => setIgnore(e.target.value)}
          onBlur={() => { const list = ignore.split(/[,，]/).map(x => x.trim()).filter(Boolean); if (list.join() !== s.ignoreActors.join()) saveProactive.mutate({ ignoreActors: list }) }} />
      </Row>
      {quiet && <Row label="安静时间" sub="这段时间它不弹通知，等你确认的事除外">
        <span className={cx('flex items-center gap-1 text-[13px]', !quiet.on && 'text-faint')}>
          <input type="time" aria-label="从" value={quiet.from} onChange={e => e.target.value && setQuiet({ from: e.target.value })} className="h-[30px] rounded-[8px] border border-line bg-card px-1.5 text-[13px] outline-none" />
          –
          <input type="time" aria-label="到" value={quiet.to} onChange={e => e.target.value && setQuiet({ to: e.target.value })} className="h-[30px] rounded-[8px] border border-line bg-card px-1.5 text-[13px] outline-none" />
        </span>
        <Toggle label="安静时间" checked={quiet.on} onChange={on => setQuiet({ on })} />
      </Row>}
    </Section>
    {saveProactive.error && strategy === s.strategy && <Foot><span className="text-danger">{(saveProactive.error as Error).message}</span></Foot>}
  </Page>
}
