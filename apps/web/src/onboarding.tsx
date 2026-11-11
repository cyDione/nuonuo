/**
 * First launch (Figma v7, 23 · F): a conversation in 主聊, not a setup wizard. 糯糯 says hello and asks for three small
 * things, one card at a time: a model (provider and key right here), a source to watch, how proactive to be, and
 * (Figma section 25, F) memories carried over from another AI, which are only written once the owner confirms. Every
 * step can be skipped; what is left is one line each below the card. Shown only to someone starting without a model, and
 * never again once finished or skipped through.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Provider, type ProactiveSettings, type RolesResponse, type SourceInfo } from './api'
import { SourceIcon } from './icons'
import { usePersona } from './persona'
import { go } from './route'
import { cx } from './ui'

type Step = 'model' | 'source' | 'proactive' | 'import' | 'done'
const ORDER: Step[] = ['model', 'source', 'proactive', 'import']
const KEY = 'sa-onboarding'
const read = (): Step | null => { try { return localStorage.getItem(KEY) as Step | null } catch { return null } }
const write = (s: Step) => { try { localStorage.setItem(KEY, s) } catch { /* private mode */ } }

/**
 * Where first launch stands. Someone who already has a model never sees it (an existing install); someone without one
 * starts at the first step, and progress is kept across reloads.
 */
export function useOnboarding(): { step: Exclude<Step, 'done'> | null; next(): void } {
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') }).data
  const [stored, setStored] = useState(read)
  const step: Step | null = stored ?? (roles ? (roles.resolved.router ? 'done' : 'model') : null)
  const next = () => { const s = ORDER[ORDER.indexOf(step as Step) + 1] ?? 'done'; write(s); setStored(s) }
  return { step: step === 'done' || step === null ? null : step, next }
}

const TITLES: Record<Exclude<Step, 'done'>, string> = { model: '接上一个模型', source: '接一个让我留意的来源', proactive: '我该多主动', import: '从别的 AI 搬记忆过来' }
const LATER: Record<Exclude<Step, 'done'>, string> = { model: '接上一个模型', source: '接一个让我留意的来源（GitHub、Gmail、RSS…）', proactive: '我该多主动：只留意 / 主动去做', import: '从别的 AI 搬记忆过来（可以不搬）' }

export function Onboarding({ step, next }: { step: Exclude<Step, 'done'>; next(): void }) {
  const persona = usePersona()
  const i = ORDER.indexOf(step)
  return <div className="mx-auto max-w-[680px] px-4 pt-6 pb-4 md:px-8">
    <div className="mb-3 text-center text-xs text-faint">刚刚</div>
    <div className="space-y-1.5">
      {[`嗨，我是${persona.name}。`, '我会替你盯着事、先把能做的做了，要花钱或往外发的先问你。', '开始前要你帮我四件小事，一分钟。'].map((t, n) =>
        <div key={t} className="feed-in w-fit max-w-[85%] rounded-[20px] bg-bubble px-4 py-2.5 text-[15px]" style={{ animationDelay: `${n * 160}ms` }}>{t}</div>)}
    </div>
    <div key={step} className="anim-rise mt-3 max-w-[440px] overflow-hidden rounded-[18px] border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{i + 1} / {ORDER.length} · {TITLES[step]}</span>
        <button onClick={next} className="shrink-0 text-xs text-muted hover:text-fg">跳过</button>
      </div>
      <div className="px-4 pt-3 pb-3.5">
        {step === 'model' ? <ModelStep onDone={next} /> : step === 'source' ? <SourceStep onDone={next} /> : step === 'proactive' ? <ProactiveStep onDone={next} /> : <ImportStep onDone={next} />}
      </div>
    </div>
    {i < ORDER.length - 1 && <div className="mt-2 max-w-[440px] space-y-0.5 rounded-[18px] bg-sunken px-4 py-2.5">
      {ORDER.slice(i + 1).map(s => <div key={s} className="flex gap-3 py-1 text-[13px] text-muted"><span className="w-3 shrink-0 text-faint tabular-nums">{ORDER.indexOf(s) + 1}</span>{LATER[s as Exclude<Step, 'done'>]}</div>)}
    </div>}
  </div>
}

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', kind: 'openai', placeholder: 'sk-…' },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', placeholder: 'sk-ant-…' },
  { id: 'gateway', label: '自己的网关', kind: 'openai-compatible', placeholder: '没有可以留空' },
] as const

function ModelStep({ onDone }: { onDone(): void }) {
  const qc = useQueryClient()
  const [pick, setPick] = useState<(typeof PROVIDERS)[number]>(PROVIDERS[1])
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [made, setMade] = useState<{ id: string; kind: string } | null>(null)
  const connect = useMutation({
    mutationFn: async () => {
      const body = { apiKey: key.trim() || null, baseUrl: pick.id === 'gateway' ? baseUrl.trim() : null }
      // Trying again after a wrong key changes the provider made the first time instead of adding another.
      const id = made?.kind === pick.kind ? (await api.patch(`/providers/${made.id}`, body), made.id)
        : (await api.post<{ provider: Provider }>('/providers', { kind: pick.kind, name: pick.label, ...body })).provider.id
      setMade({ id, kind: pick.kind })
      const { models, error } = await api.get<{ models: string[]; error?: string }>(`/providers/${id}/models?role=router`)
      const model = models[0]
      if (!model) throw new Error(error ?? '没找到能用的模型')
      const test = await api.post<{ ok: boolean; error?: string }>('/models/test', { providerId: id, model })
      if (!test.ok) throw new Error(test.error ?? '没接通')
      await api.put('/roles/router', { enabled: true, chain: [{ providerId: id, model }] })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); qc.invalidateQueries({ queryKey: ['providers'] }); onDone() },
  })
  const ready = (pick.id !== 'gateway' ? key.trim() : baseUrl.trim()) && !connect.isPending
  const input = 'h-9 w-full rounded-[10px] border border-line bg-panel px-3 text-sm outline-none placeholder:text-faint focus:border-faint'
  return <form onSubmit={e => { e.preventDefault(); if (ready) connect.mutate() }}>
    <div className="text-xs text-muted">我用哪家的模型想事情</div>
    <div role="radiogroup" aria-label="模型供应商" className="mt-2 flex flex-wrap gap-1.5">
      {PROVIDERS.map(p => <button key={p.id} type="button" role="radio" aria-checked={pick.id === p.id} onClick={() => setPick(p)}
        className={cx('press h-8 rounded-full px-3.5 text-[13px]', pick.id === p.id ? 'bg-ink font-medium text-ink-fg' : 'border border-line hover:border-faint')}>{p.label}</button>)}
    </div>
    {pick.id === 'gateway' && <label className="mt-3 block"><span className="text-xs text-muted">地址（OpenAI 兼容）</span>
      <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://gateway.example.com/v1" className={cx(input, 'mt-1.5 font-mono text-[13px]')} /></label>}
    <label className="mt-3 block"><span className="text-xs text-muted">API Key</span>
      <input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={pick.placeholder} className={cx(input, 'mt-1.5 font-mono text-[13px]')} /></label>
    <p className="mt-1.5 text-[11px] text-faint">只存在这台电脑上的数据目录里。</p>
    <div className="mt-3 flex items-center gap-3">
      <button type="submit" disabled={!ready} className="press h-8 shrink-0 rounded-full bg-ink px-4 text-[13px] font-medium text-ink-fg disabled:opacity-50">{connect.isPending ? '在接…' : '接上'}</button>
      <span className={cx('min-w-0 text-xs', connect.error ? 'text-danger' : 'text-muted')}>{connect.error ? `没接通：${(connect.error as Error).message}` : '接上后我会试一句，通了就往下走'}</span>
    </div>
  </form>
}

const PICKS = ['github', 'gmail', 'rss', 'telegram']

function SourceStep({ onDone }: { onDone(): void }) {
  const sources = (useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[] }>('/sources') }).data?.sources ?? [])
    .filter(s => PICKS.includes(s.id)).sort((a, b) => PICKS.indexOf(a.id) - PICKS.indexOf(b.id))
  return <div>
    <div className="text-xs text-muted">有变化我才会说，没变化不打扰你</div>
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      {sources.map(s => <button key={s.id} onClick={() => { onDone(); go(`/settings/sources/${encodeURIComponent(s.id)}`) }}
        className="press flex items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-left text-sm hover:border-faint">
        <SourceIcon source={s.id} size={16} className="shrink-0" /><span className="truncate">{s.title}</span>
      </button>)}
    </div>
    <p className="mt-2.5 text-[11px] text-faint">点一个会打开它的设置页，授权完回到主聊就好。以后在 设置 · 来源 里也能加。</p>
  </div>
}

function ProactiveStep({ onDone }: { onDone(): void }) {
  const qc = useQueryClient()
  const proactive = useQuery({ queryKey: ['proactive'], queryFn: () => api.get<{ settings: ProactiveSettings }>('/settings/proactive') }).data?.settings
  const save = useMutation({
    mutationFn: (mode: ProactiveSettings['mode']) => api.put('/settings/proactive', { ...proactive!, mode }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['proactive'] }); onDone() },
  })
  const options: { id: ProactiveSettings['mode']; label: string; sub: string }[] = [
    { id: 'observe', label: '只留意', sub: '看到了告诉你，做不做你说了算' },
    { id: 'auto', label: '主动去做', sub: '能做的先做好，要花钱或往外发的先问你' },
  ]
  return <div className="space-y-1.5">
    {options.map(o => <button key={o.id} disabled={!proactive || save.isPending} onClick={() => save.mutate(o.id)}
      className={cx('press flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left', proactive?.mode === o.id ? 'border-fg' : 'border-line hover:border-faint')}>
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{o.label}</span><span className="block text-xs text-muted">{o.sub}</span></span>
    </button>)}
    <p className="pt-1 text-[11px] text-faint">以后在 设置 · 主动 里随时改。</p>
  </div>
}

type Found = { kind: 'profile' | 'lesson'; text: string }
const KIND: Record<Found['kind'], string> = { profile: '关于你', lesson: '经验' }

/** Paste what another assistant remembers; it is sorted into 关于你 / 经验 and written only after 都记住 or a look through. */
function ImportStep({ onDone }: { onDone(): void }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [found, setFound] = useState<Found[] | null>(null)
  const [one, setOne] = useState(false)
  const preview = useMutation({ mutationFn: () => api.post<{ items: Found[] }>('/memories/import/preview', { text }), onSuccess: r => setFound(r.items) })
  const save = useMutation({ mutationFn: (items: Found[]) => api.post<{ added: number; existing: number }>('/memories/import', { items }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['memories'] }); onDone() } })
  const lines = text.split(/\r?\n/).filter(l => l.trim()).length
  const count = (k: Found['kind']) => found?.filter(f => f.kind === k).length ?? 0
  return <div>
    <p className="text-xs leading-5 text-muted">在 ChatGPT 或 Claude 里说「把你记得的关于我的事都列出来」，整段贴到这里。</p>
    <textarea value={text} onChange={e => { setText(e.target.value); setFound(null); setOne(false) }} aria-label="别的 AI 记得的事"
      placeholder={'- 我在上海工作，做产品经理\n- 喜欢简短的回答，先给结论'} className="mt-2 min-h-28 w-full rounded-xl border border-line bg-panel px-3 py-2 text-[13px] leading-6 outline-none placeholder:text-faint focus:border-faint" />
    {lines > 0 && !found && <div className="-mt-1 text-[11px] text-faint">已贴入 {lines} 行</div>}
    {found && (found.length ? <div className="anim-rise mt-2 rounded-xl bg-accent-soft px-3.5 py-2.5">
      <div className="text-[13px] font-medium text-accent">整理出 {found.length} 条：{(['profile', 'lesson'] as const).filter(count).map(k => `${KIND[k]} ${count(k)}`).join(' · ')}</div>
      <div className="mt-0.5 text-[11px] text-muted">和已有的重复的会合并；你确认后才写进记忆。</div>
    </div> : <div className="mt-2 text-xs text-muted">没认出能记的内容，换一段试试，或者先跳过。</div>)}
    {found && one && found.length > 0 && <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">{found.map((f, n) => <li key={n} className="flex items-center gap-2 py-1 text-[13px]">
      <span className="shrink-0 rounded-full bg-sunken px-1.5 py-px text-[10px] text-muted">{KIND[f.kind]}</span>
      <span className="min-w-0 flex-1">{f.text}</span>
      <button onClick={() => setFound(found.filter((_, m) => m !== n))} aria-label={`不要「${f.text}」`} className="press shrink-0 rounded-full px-2 py-0.5 text-[11px] text-faint hover:bg-sunken hover:text-fg">不要</button>
    </li>)}</ul>}
    <div className="mt-3 flex items-center gap-1.5">
      {!found ? <button onClick={() => preview.mutate()} disabled={!text.trim() || preview.isPending} className="press h-8 rounded-full bg-ink px-4 text-[13px] font-medium text-ink-fg disabled:opacity-50">{preview.isPending ? '在整理…' : '整理一下'}</button>
        : found.length > 0 && <>
          <button onClick={() => save.mutate(found)} disabled={save.isPending} className="press h-8 rounded-full bg-ink px-4 text-[13px] font-medium text-ink-fg disabled:opacity-50">{one ? `记住这 ${found.length} 条` : '都记住'}</button>
          {!one && <button onClick={() => setOne(true)} className="press h-8 rounded-full border border-line px-4 text-[13px] hover:border-faint">一条条看</button>}
        </>}
      {(preview.error || save.error) && <span className="ml-2 text-xs text-danger">{((preview.error || save.error) as Error).message}</span>}
    </div>
  </div>
}
