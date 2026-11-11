/**
 * 分层模型 (Figma 21 · 09): which model each layer runs on, at a glance; a layer without its own follows the one above.
 * Opening a layer sets its backup models, reasoning, temperature, output and daily token and cost limits.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronLeft, Loader2, Plus, Trash2, XCircle } from 'lucide-react'
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
  return <Page title={tx('分层模型')}>
    <Section foot={tx('没配的层沿用上一层。点进一层可以设：备用模型、推理强度、温度、单次最大输出、每天的 token 和费用上限。')}>
      {specs.map(s => {
        const config = roles.data!.configs[s.id] ?? EMPTY
        const resolved = roles.data!.resolved[s.id]
        const own = config.chain[0]?.model
        const value = s.optional && !config.enabled ? <span className="text-[13px] text-faint">{tx('已关闭')}</span>
          : own ? <span className="font-mono text-[13px] font-medium">{own}{config.chain.length > 1 ? <span className="font-sans font-normal text-faint"> +{config.chain.length - 1}</span> : null}</span>
          : resolved ? <span className="text-[13px] text-faint">{tx('跟{0}一样', labelOf(resolved.source))}</span>
          : <span className="text-[13px] text-faint">{s.optional ? tx('已关闭') : tx('还没选')}</span>
        return <Row key={s.id} href={`#/settings/roles/${s.id}`} label={s.label} sub={<span className="line-clamp-1">{s.duty}{s.advice ? ` · ${s.advice}` : ''}</span>}>{value}</Row>
      })}
    </Section>
  </Page>
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
