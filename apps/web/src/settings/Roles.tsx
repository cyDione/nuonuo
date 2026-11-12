/**
 * 分层模型 (Figma 21 · 09, folded in §28): the main agent's model up front; every other layer follows it unless set under 高级选项.
 * Opening a layer sets its backup models, reasoning, temperature, output and daily token and cost limits.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Loader2, Plus, Settings2, Trash2, Undo2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ModelRef, type Provider, type RoleConfig, type RoleSpec, type RolesResponse } from '../api'
import { fmtNum, fmtUsd } from '../ui'
import { Block, Btn, Foot, NumberInput, Page, Row, SaveBar, Section, SelectInput, Toggle } from './kit'
import { modelTag, useCatalog, useModelOptions, useProviders } from './hooks'
import { ModelPicker } from './ModelPicker'
import { tx } from '../i18n'

const EMPTY: RoleConfig = { chain: [], enabled: true }
type Resolved = RolesResponse['resolved'][keyof RolesResponse['resolved']]

export function Roles({ item }: { item?: string }) {
  const catalog = useCatalog()
  const providers = useProviders()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') })
  if (!catalog.data || !roles.data || !providers.data) return <Page title={tx('分层模型')}><div /></Page>
  if (!providers.data.providers.length) return <Page title={tx('分层模型')}><Section><Row label={tx('还没有模型供应商')} sub={tx('先在「模型供应商」里加一个。')} href="#/settings/providers" /></Section></Page>
  const specs = catalog.data.roles
  const labelOf = (id: string) => specs.find(s => s.id === id)?.label ?? id
  const usable = (spec: RoleSpec) => providers.data!.providers.filter(p => p.kind !== 'typesafe' || spec.id === 'reviewer')
  const spec = item ? specs.find(s => s.id === item) : undefined
  if (spec) return <div className="space-y-4">
    <a href="#/settings/roles" className="inline-flex items-center gap-0.5 text-[13px] text-muted hover:text-fg"><ChevronLeft size={15} />{tx('分层模型')}</a>
    <RoleDetail key={spec.id} spec={spec} labelOf={labelOf} levels={catalog.data.reasoningLevels} config={roles.data.configs[spec.id] ?? EMPTY} resolved={roles.data.resolved[spec.id]} providers={usable(spec)} />
  </div>
  return <RoleList specs={specs} labelOf={labelOf} roles={roles.data} providers={usable(specs.find(s => s.id === 'router')!)} />
}

const ADVANCED_KEY = 'nuonuo.roles.advanced'
const readAdvanced = () => { try { return localStorage.getItem(ADVANCED_KEY) === '1' } catch { return false } }
const short = (label: string) => label.replace(/[（(].*[）)]$/, '').trim()

/**
 * Figma §28: only the main agent's model is shown; every other layer follows it unless set under 高级选项, which opens
 * in place (no motion on settings pages) and is remembered. Closed, it still names the layers that have their own model.
 */
function RoleList({ specs, labelOf, roles, providers }: { specs: RoleSpec[]; labelOf(id: string): string; roles: RolesResponse; providers: Provider[] }) {
  const qc = useQueryClient()
  const [advanced, setAdvanced] = useState(readAdvanced)
  const toggle = () => { const next = !advanced; setAdvanced(next); try { localStorage.setItem(ADVANCED_KEY, next ? '1' : '0') } catch { /* private mode */ } }
  const rest = specs.filter(s => s.id !== 'router')
  const language = rest.filter(s => s.kind === 'language')
  const special = rest.filter(s => s.kind !== 'language')
  const configOf = (id: string) => roles.configs[id as keyof RolesResponse['configs']] ?? EMPTY
  const own = (s: RoleSpec) => configOf(s.id).chain.length > 0 && configOf(s.id).enabled
  const overridden = rest.filter(own)
  const reset = useMutation({
    mutationFn: () => Promise.all(language.filter(own).map(s => api.put(`/roles/${s.id}`, clean({ ...configOf(s.id), chain: [] })))),
    onSettled: () => qc.invalidateQueries({ queryKey: ['roles'] }),
  })
  const routerConfig = configOf('router')
  const extras = [
    routerConfig.chain.length > 1 && tx('备用 {0} 个', routerConfig.chain.length - 1),
    routerConfig.reasoning && tx('推理 {0}', routerConfig.reasoning),
    (routerConfig.dailyTokenLimit || routerConfig.dailyCostLimitUsd) && tx('有上限'),
  ].filter(Boolean).join(' · ')

  const valueOf = (s: RoleSpec) => {
    const config = configOf(s.id)
    const resolved = roles.resolved[s.id]
    const model = config.chain[0]?.model
    if (s.optional && !config.enabled) return <span className="text-[13px] text-faint">{tx('已关闭')}</span>
    if (model) return <span className="font-mono text-[13px] font-medium">{model}{config.chain.length > 1 ? <span className="font-sans font-normal text-faint"> +{config.chain.length - 1}</span> : null}</span>
    if (resolved) return <span className="text-[13px] text-faint">{resolved.source === 'router' ? tx('跟主 Agent') : tx('跟{0}', short(labelOf(resolved.source)))}</span>
    if (s.optional && s.kind === 'language') return <span className="text-[13px] text-faint">{tx('主 Agent 兼做')}</span>
    return <span className="text-[13px] text-faint">{s.optional ? tx('没开') : tx('还没选')}</span>
  }
  const layerRow = (s: RoleSpec) => <Row key={s.id} href={`#/settings/roles/${s.id}`} label={s.label} sub={<span className="line-clamp-1">{s.duty}{s.advice ? ` · ${s.advice}` : ''}</span>}>{valueOf(s)}</Row>

  return <Page title={tx('分层模型')}>
    <Section title={tx('主 Agent')} foot={tx('所有层默认都用这个模型。')}>
      <MainModel config={routerConfig} providers={providers} />
      <Row href="#/settings/roles/router" label={tx('备用模型、推理强度、每天上限')} sub={tx('主模型出错时换备用的；不设就不限')}>
        <span className="text-[13px] text-faint">{extras || tx('没设')}</span>
      </Row>
    </Section>
    <section>
      <div className="rounded-2xl bg-sunken px-4">
        <button type="button" onClick={toggle} aria-expanded={advanced} className="flex min-h-[52px] w-full items-center gap-3 py-2.5 text-left hover:opacity-80">
          <span className="flex size-5 shrink-0 items-center justify-center text-fg"><Settings2 size={16} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{tx('高级选项')}</span>
            <span className="mt-0.5 block text-xs text-muted">
              {advanced ? tx('收起后，单独设置的层照样生效')
                : overridden.length ? tx('{0}单独设置了，其余跟主 Agent', overridden.map(s => short(s.label)).join('、'))
                : tx('给执行、审核、摘要等层单独选模型；开启向量、听写、朗读')}
            </span>
          </span>
          {!advanced && (overridden.length
            ? <span className="shrink-0 rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] text-muted">{tx('{0} 层单独设置', overridden.length)}</span>
            : <span className="shrink-0 text-[13px] text-faint">{tx('都跟主 Agent')}</span>)}
          {advanced ? <ChevronDown size={16} className="shrink-0 text-faint" /> : <ChevronRight size={16} className="shrink-0 text-faint" />}
        </button>
      </div>
    </section>
    {advanced && <>
      <section>
        <div className="mb-2 flex items-center gap-3">
          <h2 className="min-w-0 flex-1 text-[13px] text-muted">{tx('语言模型层')}</h2>
          {language.some(own) && <button type="button" disabled={reset.isPending} onClick={() => reset.mutate()} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg disabled:opacity-50">
            <Undo2 size={13} />{tx('全部改回跟随主 Agent')}</button>}
        </div>
        <div className="rounded-2xl bg-sunken px-4 [&>*+*]:border-t [&>*+*]:border-line">{language.map(layerRow)}</div>
        <Foot>{tx('点进一层可以单独选模型，也能设备用模型、推理强度、温度、每天上限。')}</Foot>
      </section>
      {special.length > 0 && <Section title={tx('要专门模型的层')} foot={tx('主 Agent 的聊天模型做不了这几件事，选上对应的模型才会开启。')}>{special.map(layerRow)}</Section>}
    </>}
  </Page>
}

/** The main agent's primary model, set in place; its backups, reasoning and limits stay on its own page. Saves once a model is named. */
function MainModel({ config, providers }: { config: RoleConfig; providers: Provider[] }) {
  const qc = useQueryClient()
  const first = config.chain[0] ?? { providerId: providers[0]?.id ?? '', model: '' }
  const [ref, setRef] = useState<ModelRef>(first)
  useEffect(() => setRef(first), [first.providerId, first.model])
  const provider = providers.find(p => p.id === ref.providerId)
  const options = useModelOptions(provider, 'router')
  const save = useMutation({
    mutationFn: (next: ModelRef) => api.put('/roles/router', clean({ ...config, chain: [next, ...config.chain.slice(1)] })),
    onSettled: () => qc.invalidateQueries({ queryKey: ['roles'] }),
  })
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; latencyMs: number; error?: string }>('/models/test', { ...ref, kind: 'language' }) })
  const model = ref.model.trim()
  const dirty = Boolean(model) && (ref.providerId !== first.providerId || model !== first.model)
  // A model picked from the provider's list saves at once; one typed by hand waits for 保存 so a half-typed id never runs.
  useEffect(() => { if (dirty && options.models.includes(model)) save.mutate({ providerId: ref.providerId, model }) }, [ref.providerId, model])
  const change = (next: ModelRef) => { setRef(next); test.reset() }
  return <Block>
    <div className="flex flex-wrap items-center gap-2">
      <SelectInput value={ref.providerId} onChange={e => change({ providerId: e.target.value, model: '' })} className="w-[150px]" aria-label={tx('供应商')}>
        {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </SelectInput>
      <ModelPicker className="min-w-48 flex-1" value={ref.model} onChange={model => change({ ...ref, model })} models={options.models} loading={options.loading}
        error={options.error} onRefresh={options.refresh} tag={m => modelTag(options.types[m])} />
      <Btn disabled={!ref.model || test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? <Loader2 size={13} className="animate-spin" /> : test.data ? (test.data.ok ? <><CheckCircle2 size={13} className="text-ok" />{test.data.latencyMs}ms</> : <XCircle size={13} className="text-danger" />) : tx('试一下')}
      </Btn>
      {dirty && !save.isPending && <Btn onClick={() => save.mutate({ providerId: ref.providerId, model })}>{tx('保存')}</Btn>}
    </div>
    {test.data && !test.data.ok && <div className="mt-1.5 text-xs whitespace-pre-line text-danger">{test.data.error?.slice(0, 400)}</div>}
    {save.error && <div className="mt-1.5 text-xs text-danger">{(save.error as Error).message}</div>}
  </Block>
}

function RoleDetail({ spec, labelOf, levels, config, resolved, providers }: { spec: RoleSpec; labelOf(id: string): string; levels: string[]; config: RoleConfig; resolved: Resolved; providers: Provider[] }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<RoleConfig>(config)
  useEffect(() => setDraft(config), [JSON.stringify(config)])
  const dirty = JSON.stringify(draft) !== JSON.stringify(config)
  const save = useMutation({ mutationFn: () => api.put(`/roles/${spec.id}`, clean(draft)), onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }) })
  const setChain = (chain: ModelRef[]) => setDraft(d => ({ ...d, chain }))
  const optNum = (k: 'temperature' | 'maxOutputTokens' | 'dailyTokenLimit' | 'dailyCostLimitUsd') => ({
    value: draft[k] ?? '', placeholder: k === 'temperature' || k === 'maxOutputTokens' ? tx('默认') : tx('不限'),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(d => ({ ...d, [k]: e.target.value === '' ? undefined : Number(e.target.value) })),
  })
  return <Page title={spec.label}>
    <p className="-mt-3 text-[13px] text-muted">{spec.duty}{spec.advice ? ` · ${spec.advice}` : ''}{resolved && resolved.today.tokens > 0 ? tx(' · 今天 {0} tokens{1}', fmtNum(resolved.today.tokens), resolved.today.costUsd ? `，${fmtUsd(resolved.today.costUsd)}` : '') : ''}</p>
    {spec.optional && <Section><Row label={tx('启用这一层')}><Toggle label={tx('启用这一层')} checked={draft.enabled} onChange={enabled => setDraft(d => ({ ...d, enabled }))} /></Row></Section>}
    <Section title={tx('模型')} foot={draft.chain.length > 1 ? tx('主模型出错或超出上限时，按顺序换备用的。') : undefined}>
      {draft.chain.map((ref, i) => <ChainRow key={i} index={i} value={ref} role={spec.id} kind={spec.kind} providers={providers}
        onChange={v => setChain(draft.chain.map((r, j) => (j === i ? v : r)))} onRemove={() => setChain(draft.chain.filter((_, j) => j !== i))} />)}
      {!draft.chain.length && <Row label={spec.inherits && !spec.optional ? tx('跟{0}一样', labelOf(spec.inherits)) : tx('还没选模型')} sub={spec.optional ? tx('配上模型才会启用这一层') : tx('想单独用一个模型就在下面选')} />}
      {draft.chain.length < 5 && providers.length > 0 && <button type="button" onClick={() => setChain([...draft.chain, { providerId: providers[0]!.id, model: '' }])}
        className="flex min-h-[44px] w-full items-center gap-2 text-left text-sm text-muted hover:text-fg"><Plus size={16} />{draft.chain.length ? tx('加一个备用模型') : tx('选一个模型')}</button>}
    </Section>
    <Section title={tx('参数和上限')}>
      {spec.kind === 'language' && <>
        <Row label={tx('推理强度')}><SelectInput value={draft.reasoning ?? ''} onChange={e => setDraft(d => ({ ...d, reasoning: e.target.value || undefined }))}>
          <option value="">{tx('默认')}</option>{levels.map(l => <option key={l} value={l}>{l}</option>)}</SelectInput></Row>
        <Row label={tx('温度')}><NumberInput min={0} max={2} step={0.1} {...optNum('temperature')} aria-label={tx('温度')} /></Row>
        <Row label={tx('单次最大输出')} sub="token"><NumberInput min={1} className="w-[100px]" {...optNum('maxOutputTokens')} aria-label={tx('单次最大输出')} /></Row>
      </>}
      <Row label={tx('每天的 token 上限')}><NumberInput min={1} className="w-[120px]" {...optNum('dailyTokenLimit')} aria-label={tx('每天的 token 上限')} /></Row>
      <Row label={tx('每天的费用上限')} sub={tx('美元；要在供应商里填了价格才算得出')}><NumberInput min={0} step="any" className="w-[100px]" {...optNum('dailyCostLimitUsd')} aria-label={tx('每天的费用上限')} /></Row>
    </Section>
    <SaveBar dirty={dirty} pending={save.isPending || draft.chain.some(r => !r.model.trim())} error={save.error} onReset={() => { setDraft(config); save.reset() }} onSave={() => save.mutate()} />
    {!dirty && save.isSuccess && <Foot>{tx('已保存。')}</Foot>}
  </Page>
}

function ChainRow({ index, value, role, kind, providers, onChange, onRemove }: { index: number; value: ModelRef; role: string; kind: RoleSpec['kind']; providers: Provider[]; onChange(v: ModelRef): void; onRemove(): void }) {
  const provider = providers.find(p => p.id === value.providerId)
  const options = useModelOptions(provider, role)
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; latencyMs: number; error?: string }>('/models/test', { ...value, kind }) })
  return <Block>
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-muted">{index === 0 ? tx('主模型') : tx('备用 {0}', index)}</span>
      <SelectInput value={value.providerId} onChange={e => onChange({ providerId: e.target.value, model: '' })} className="w-[150px]">
        {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </SelectInput>
      <ModelPicker className="min-w-48 flex-1" value={value.model} onChange={model => onChange({ ...value, model })} models={options.models} loading={options.loading}
        error={options.error} onRefresh={options.refresh} tag={m => modelTag(options.types[m])} />
      <Btn disabled={!value.model || test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? <Loader2 size={13} className="animate-spin" /> : test.data ? (test.data.ok ? <><CheckCircle2 size={13} className="text-ok" />{test.data.latencyMs}ms</> : <XCircle size={13} className="text-danger" />) : tx('试一下')}
      </Btn>
      <button type="button" onClick={onRemove} className="text-faint hover:text-danger" aria-label={tx('移除')}><Trash2 size={14} /></button>
    </div>
    {test.data && !test.data.ok && <div className="mt-1.5 pl-14 text-xs whitespace-pre-line text-danger">{test.data.error?.slice(0, 400)}</div>}
  </Block>
}

function clean(c: RoleConfig): RoleConfig {
  return Object.fromEntries(Object.entries({ ...c, chain: c.chain.map(r => ({ ...r, model: r.model.trim() })) })
    .filter(([, v]) => v !== undefined && !(typeof v === 'number' && Number.isNaN(v)))) as unknown as RoleConfig
}
