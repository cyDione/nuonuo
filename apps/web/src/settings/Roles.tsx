import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ModelRef, type Provider, type RoleConfig, type RoleSpec, type RolesResponse } from '../api'
import { Badge, Button, Card, Field, Input, Select, cx, fmtNum, fmtUsd } from '../ui'
import { useCatalog, useModelOptions, useProviders } from './hooks'

const EMPTY: RoleConfig = { chain: [], enabled: true }

export function Roles() {
  const catalog = useCatalog()
  const providers = useProviders()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') })
  if (!catalog.data || !roles.data || !providers.data) return null
  if (providers.data.providers.length === 0) return <Card className="p-5 text-sm text-muted">先在「模型供应商」中添加至少一个供应商。</Card>
  return <div className="space-y-3">
    {catalog.data.roles.map(spec => <RoleCard key={spec.id} spec={spec} specs={catalog.data!.roles} levels={catalog.data!.reasoningLevels}
      config={roles.data!.configs[spec.id] ?? EMPTY} resolved={roles.data!.resolved[spec.id]} providers={providers.data!.providers} />)}
  </div>
}

function RoleCard({ spec, specs, levels, config, resolved, providers }: {
  spec: RoleSpec; specs: RoleSpec[]; levels: string[]; config: RoleConfig; resolved: RolesResponse['resolved'][keyof RolesResponse['resolved']]; providers: Provider[]
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<RoleConfig>(config)
  const [open, setOpen] = useState(false)
  useEffect(() => setDraft(config), [JSON.stringify(config)])
  const dirty = JSON.stringify(draft) !== JSON.stringify(config)
  const save = useMutation({ mutationFn: () => api.put(`/roles/${spec.id}`, clean(draft)), onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }) })
  const labelOf = (id: string) => specs.find(s => s.id === id)?.label ?? id
  const status = !draft.enabled && spec.optional ? <Badge>已关闭</Badge>
    : config.chain.length > 0 ? <Badge tone="accent">已配置</Badge>
    : resolved ? <Badge>沿用 {labelOf(resolved.source)}</Badge>
    : <Badge tone={spec.id === 'router' ? 'warn' : 'neutral'}>{spec.optional ? '未启用' : '未配置'}</Badge>

  const setChain = (chain: ModelRef[]) => setDraft(d => ({ ...d, chain }))
  return <Card className="p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <div className="flex items-center gap-2"><span className="font-medium">{spec.label}</span>{status}</div>
        <div className="mt-0.5 text-xs text-muted">{spec.duty} · <span className="text-faint">{spec.advice}</span></div>
      </div>
      {resolved && <div className="text-right text-xs text-faint">今日 {fmtNum(resolved.today.tokens)} tokens{resolved.today.costUsd ? ` · ${fmtUsd(resolved.today.costUsd)}` : ''}</div>}
    </div>

    <div className="mt-3 space-y-2">
      {draft.chain.map((ref, i) => <ChainRow key={i} index={i} value={ref} kind={spec.kind} providers={providers}
        onChange={v => setChain(draft.chain.map((r, j) => (j === i ? v : r)))} onRemove={() => setChain(draft.chain.filter((_, j) => j !== i))} />)}
      {draft.chain.length === 0 && <p className="text-xs text-faint">{spec.inherits && !spec.optional ? `未单独配置时沿用「${labelOf(spec.inherits)}」。` : spec.optional ? '可选层：配置模型后启用。' : '请选择模型。'}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {draft.chain.length < 5 && <Button size="sm" variant="ghost" onClick={() => setChain([...draft.chain, { providerId: providers[0]!.id, model: '' }])}>
          <Plus size={13} />{draft.chain.length === 0 ? '选择模型' : '添加备用模型'}</Button>}
        <button onClick={() => setOpen(v => !v)} className="flex items-center gap-1 text-xs text-muted hover:text-fg">
          高级 <ChevronDown size={13} className={cx('transition-transform', open && 'rotate-180')} /></button>
      </div>
    </div>

    {open && <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
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
    </div>}

    {(dirty || save.error) && <div className="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3">
      {save.error && <span className="mr-auto text-xs text-danger">{(save.error as Error).message}</span>}
      <Button size="sm" variant="ghost" onClick={() => { setDraft(config); save.reset() }}>还原</Button>
      <Button size="sm" variant="primary" disabled={save.isPending || draft.chain.some(r => !r.model.trim())} onClick={() => save.mutate()}>保存</Button>
    </div>}
  </Card>
}

function ChainRow({ index, value, kind, providers, onChange, onRemove }: { index: number; value: ModelRef; kind: RoleSpec['kind']; providers: Provider[]; onChange(v: ModelRef): void; onRemove(): void }) {
  const provider = providers.find(p => p.id === value.providerId)
  const { models } = useModelOptions(provider)
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; latencyMs: number; error?: string }>('/models/test', { ...value, kind }) })
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
    {test.data && !test.data.ok && <div className="basis-full whitespace-pre-line pl-12 text-xs text-danger">{test.data.error?.slice(0, 400)}</div>}
  </div>
}

function clean(c: RoleConfig): RoleConfig {
  return Object.fromEntries(Object.entries({ ...c, chain: c.chain.map(r => ({ ...r, model: r.model.trim() })) })
    .filter(([, v]) => v !== undefined && !(typeof v === "number" && Number.isNaN(v)))) as unknown as RoleConfig
}
