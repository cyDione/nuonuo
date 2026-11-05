import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ModelRef, type Provider, type RoleConfig, type RoleSpec, type RolesResponse } from '../api'
import { Badge, Button, Card, DetailHeader, Field, Input, ListRow, Select, fmtNum, fmtUsd } from '../ui'
import { useCatalog, useModelOptions, useProviders } from './hooks'

const EMPTY: RoleConfig = { chain: [], enabled: true }

export function Roles({ item }: { item?: string }) {
  const catalog = useCatalog()
  const providers = useProviders()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') })
  if (!catalog.data || !roles.data || !providers.data) return null
  if (providers.data.providers.length === 0) return <Card className="p-5 text-sm text-muted">先在「模型供应商」中添加至少一个供应商。</Card>
  const specs = catalog.data.roles
  const props = (spec: RoleSpec) => ({ spec, specs, config: roles.data!.configs[spec.id] ?? EMPTY, resolved: roles.data!.resolved[spec.id], providers: providers.data!.providers })
  if (item) {
    const spec = specs.find(s => s.id === item)
    return spec ? <RoleDetail key={spec.id} {...props(spec)} levels={catalog.data.reasoningLevels} />
      : <Card className="p-5 text-sm text-muted">找不到这一层「{item}」。<a href="#/settings/roles" className="text-accent">返回分层模型</a></Card>
  }
  return <Card className="divide-y divide-line overflow-hidden">{specs.map(spec => {
    const { config, resolved, providers: ps } = props(spec)
    const model = resolved && (!spec.optional || config.enabled) ? `${ps.find(p => p.id === resolved.model.providerId)?.name ?? resolved.model.providerId} · ${resolved.model.model}` : null
    const fallbacks = config.chain.length > 1 ? ` · ${config.chain.length - 1} 个备用` : ''
    return <ListRow key={spec.id} href={`#/settings/roles/${spec.id}`} title={spec.label} badge={<RoleStatus spec={spec} specs={specs} config={config} resolved={resolved} />}
      detail={model ? <span className="font-mono">{model}{fallbacks}</span> : spec.duty}
      aside={resolved && resolved.today.tokens > 0 ? <>今日 {fmtNum(resolved.today.tokens)} tokens{resolved.today.costUsd ? <><br />{fmtUsd(resolved.today.costUsd)}</> : null}</> : null} />
  })}</Card>
}

type RoleProps = { spec: RoleSpec; specs: RoleSpec[]; config: RoleConfig; resolved: RolesResponse['resolved'][keyof RolesResponse['resolved']] }

function RoleStatus({ spec, specs, config, resolved }: RoleProps) {
  const labelOf = (id: string) => specs.find(s => s.id === id)?.label ?? id
  return !config.enabled && spec.optional ? <Badge>已关闭</Badge>
    : config.chain.length > 0 ? <Badge tone="accent">已配置</Badge>
    : resolved ? <Badge>沿用 {labelOf(resolved.source)}</Badge>
    : <Badge tone={spec.id === 'router' ? 'warn' : 'neutral'}>{spec.optional ? '未启用' : '未配置'}</Badge>
}

/** One tier's own settings page: its model chain, then parameters and budgets. */
function RoleDetail({ spec, specs, levels, config, resolved, providers }: RoleProps & { levels: string[]; providers: Provider[] }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<RoleConfig>(config)
  useEffect(() => setDraft(config), [JSON.stringify(config)])
  const dirty = JSON.stringify(draft) !== JSON.stringify(config)
  const save = useMutation({ mutationFn: () => api.put(`/roles/${spec.id}`, clean(draft)), onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }) })
  const labelOf = (id: string) => specs.find(s => s.id === id)?.label ?? id
  const setChain = (chain: ModelRef[]) => setDraft(d => ({ ...d, chain }))
  return <div className="space-y-4">
    <DetailHeader back="#/settings/roles" backLabel="分层模型" title={spec.label} badge={<RoleStatus spec={spec} specs={specs} config={draft} resolved={resolved} />}>
      {spec.duty} · <span className="text-faint">{spec.advice}</span>
    </DetailHeader>
    {resolved && <p className="text-xs text-faint">今日 {fmtNum(resolved.today.tokens)} tokens{resolved.today.costUsd ? ` · ${fmtUsd(resolved.today.costUsd)}` : ''}</p>}

    <Card className="p-4">
      <h3 className="text-sm font-medium">模型</h3>
      <p className="mt-0.5 text-xs text-muted">主模型失败时依次尝试备用模型。</p>
      <div className="mt-3 space-y-2">
        {draft.chain.map((ref, i) => <ChainRow key={i} index={i} value={ref} providers={providers}
          onChange={v => setChain(draft.chain.map((r, j) => (j === i ? v : r)))} onRemove={() => setChain(draft.chain.filter((_, j) => j !== i))} />)}
        {draft.chain.length === 0 && <p className="text-xs text-faint">{spec.inherits && !spec.optional ? `未单独配置时沿用「${labelOf(spec.inherits)}」。` : spec.optional ? '可选层：配置模型后启用。' : '请选择模型。'}</p>}
        {draft.chain.length < 5 && <Button size="sm" variant="ghost" onClick={() => setChain([...draft.chain, { providerId: providers[0]!.id, model: '' }])}>
          <Plus size={13} />{draft.chain.length === 0 ? '选择模型' : '添加备用模型'}</Button>}
      </div>
    </Card>

    <Card className="p-4">
      <h3 className="text-sm font-medium">参数与预算</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {spec.optional && <Field label="启用"><Select value={draft.enabled ? '1' : '0'} onChange={e => setDraft(d => ({ ...d, enabled: e.target.value === '1' }))}>
          <option value="1">启用</option><option value="0">关闭</option></Select></Field>}
        {spec.kind === 'language' && <>
          <Field label="推理强度"><Select value={draft.reasoning ?? ''} onChange={e => setDraft(d => ({ ...d, reasoning: e.target.value || undefined }))}>
            <option value="">默认</option>{levels.map(l => <option key={l} value={l}>{l}</option>)}</Select></Field>
          <Field label="温度"><Input type="number" min={0} max={2} step={0.1} value={draft.temperature ?? ''} placeholder="默认"
            onChange={e => setDraft(d => ({ ...d, temperature: e.target.value === '' ? undefined : Number(e.target.value) }))} /></Field>
          <Field label="单次最大输出 token"><Input type="number" min={1} value={draft.maxOutputTokens ?? ''} placeholder="默认"
            onChange={e => setDraft(d => ({ ...d, maxOutputTokens: e.target.value === '' ? undefined : Number(e.target.value) }))} /></Field>
        </>}
        <Field label="每日 token 上限"><Input type="number" min={1} value={draft.dailyTokenLimit ?? ''} placeholder="不限"
          onChange={e => setDraft(d => ({ ...d, dailyTokenLimit: e.target.value === '' ? undefined : Number(e.target.value) }))} /></Field>
        <Field label="每日费用上限（美元）" hint="需要在供应商中填写价格"><Input type="number" min={0} step="any" value={draft.dailyCostLimitUsd ?? ''} placeholder="不限"
          onChange={e => setDraft(d => ({ ...d, dailyCostLimitUsd: e.target.value === '' ? undefined : Number(e.target.value) }))} /></Field>
      </div>
    </Card>

    {(dirty || save.error) && <div className="sticky bottom-0 flex items-center justify-end gap-2 rounded-xl border border-line bg-panel px-4 py-3 shadow-sm">
      {save.error && <span className="mr-auto text-xs text-danger">{(save.error as Error).message}</span>}
      <Button size="sm" variant="ghost" onClick={() => { setDraft(config); save.reset() }}>还原</Button>
      <Button size="sm" variant="primary" disabled={save.isPending || draft.chain.some(r => !r.model.trim())} onClick={() => save.mutate()}>保存</Button>
    </div>}
  </div>
}

function ChainRow({ index, value, providers, onChange, onRemove }: { index: number; value: ModelRef; providers: Provider[]; onChange(v: ModelRef): void; onRemove(): void }) {
  const provider = providers.find(p => p.id === value.providerId)
  const { models } = useModelOptions(provider)
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; latencyMs: number; error?: string }>('/models/test', value) })
  const listId = `chain-${value.providerId}`
  return <div className="flex flex-wrap items-center gap-2">
    <span className="w-10 shrink-0 text-[11px] text-faint">{index === 0 ? '主模型' : `备用 ${index}`}</span>
    <div className="w-40 shrink-0"><Select value={value.providerId} onChange={e => onChange({ providerId: e.target.value, model: '' })} className="h-8 text-xs">
      {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select></div>
    <div className="min-w-48 flex-1"><Input list={listId} value={value.model} onChange={e => onChange({ ...value, model: e.target.value })} placeholder="模型 id" className="h-8 text-xs" /></div>
    <datalist id={listId}>{models.map(m => <option key={m} value={m} />)}</datalist>
    <Button size="sm" variant="ghost" disabled={!value.model || test.isPending} onClick={() => test.mutate()}>
      {test.isPending ? <Loader2 size={13} className="animate-spin" /> : test.data ? (test.data.ok ? <CheckCircle2 size={13} className="text-ok" /> : <XCircle size={13} className="text-danger" />) : '测试'}
    </Button>
    <button onClick={onRemove} className="text-faint hover:text-danger" aria-label="移除"><Trash2 size={14} /></button>
    {test.data && !test.data.ok && <div className="basis-full pl-12 text-xs text-danger">{test.data.error?.slice(0, 200)}</div>}
  </div>
}

function clean(c: RoleConfig): RoleConfig {
  return Object.fromEntries(Object.entries({ ...c, chain: c.chain.map(r => ({ ...r, model: r.model.trim() })) })
    .filter(([, v]) => v !== undefined && !(typeof v === "number" && Number.isNaN(v)))) as unknown as RoleConfig
}
