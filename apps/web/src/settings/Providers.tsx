/**
 * 模型供应商 (Figma 21 · 08): the providers and whether each answers; the open one below — name, address, key, a
 * connection test and prices. Adding one picks a preset, then asks only what that preset needs.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type Preset, type Price, type Provider } from '../api'
import { go } from '../route'
import { Block, Btn, NumberInput, Page, Pill, Row, Section, TextInput } from './kit'
import { modelTag, useCatalog, useModelOptions, useProviders, type ModelType } from './hooks'
import { tx } from '../i18n'

const host = (url: string | null) => (url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
const keyWhere = (p: Provider) => p.keyEnv ? tx('环境变量 {0}', p.keyEnv) : p.hasKey ? tx('密钥在钥匙串里') : tx('没有密钥')

/** How many of a provider's models are of each type, chat first: " · 对话 12 · 向量 2 · 决策模型 1". Nothing when all are chat. */
function breakdown(types: Record<string, ModelType>): string {
  const counts = new Map<ModelType, number>()
  for (const t of Object.values(types)) counts.set(t, (counts.get(t) ?? 0) + 1)
  if (![...counts.keys()].some(t => t !== 'chat')) return ''
  const order: ModelType[] = ['chat', 'embedding', 'rerank', 'decision', 'image', 'audio', 'video']
  return order.filter(t => counts.has(t)).map(t => ` · ${t === 'chat' ? tx('对话') : modelTag(t)} ${counts.get(t)}`).join('')
}

export function Providers({ item }: { item?: string }) {
  const providers = useProviders()
  const [adding, setAdding] = useState(false)
  const list = providers.data?.providers ?? []
  const open = item ? list.find(p => p.id === item) : undefined
  return <Page title={tx('模型供应商')} action={<Btn tone="ink" className="h-[32px] rounded-[10px]" onClick={() => { setAdding(true); if (item) go('/settings/providers') }}><Plus size={15} />{tx('添加')}</Btn>}>
    <Section foot={tx('API key 存在系统钥匙串里（或加密文件），不进数据库、不进模型上下文，也不会传给任务的命令行。')}>
      {list.map(p => <ProviderRow key={p.id} p={p} />)}
      {providers.isSuccess && !list.length && <Row label={tx('还没有模型供应商')} sub={tx('先加一个（Anthropic、OpenAI，或本机的 Ollama），再到「分层模型」给主 Agent 选模型。')} />}
    </Section>
    {adding && !open && <AddProvider onDone={id => { setAdding(false); if (id) go(`/settings/providers/${id}`) }} />}
    {open && <ProviderDetail key={open.id} p={open} />}
  </Page>
}

function ProviderRow({ p }: { p: Provider }) {
  const kinds = useCatalog().data?.kinds
  const live = useModelOptions(p)
  const state = p.kind === 'typesafe' ? null : live.loading ? <Pill>{tx('在试')}</Pill> : live.error ? <Pill tone="danger">{tx('连不上')}</Pill> : live.models.length ? <Pill tone="ok">{tx('连得上')}</Pill> : null
  return <Row href={`#/settings/providers/${p.id}`} icon={<KeyRound size={18} />} label={p.name}
    sub={<span className="line-clamp-1">{[kinds?.[p.kind] && tx(kinds[p.kind].label), host(p.baseUrl), p.kind === 'typesafe' ? tx('只给审核用') : keyWhere(p)].filter(Boolean).join(' · ')}</span>}>
    {p.keyEnv && !p.hasKey ? <span className="text-[13px] text-faint">{tx('没设置')}</span> : state}
  </Row>
}

function ProviderDetail({ p }: { p: Provider }) {
  const qc = useQueryClient()
  const live = useModelOptions(p)
  const [name, setName] = useState(p.name)
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? '')
  const [decisions, setDecisions] = useState(p.options.decisionsUrl ?? '')
  const [key, setKey] = useState<string | null>(null)
  const [prices, setPrices] = useState(false)
  useEffect(() => { setName(p.name); setBaseUrl(p.baseUrl ?? ''); setDecisions(p.options.decisionsUrl ?? '') }, [p.name, p.baseUrl, p.options.decisionsUrl])
  const refresh = () => { qc.invalidateQueries({ queryKey: ['providers'] }); qc.invalidateQueries({ queryKey: ['models', p.id] }); qc.invalidateQueries({ queryKey: ['roles'] }) }
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/providers/${p.id}`, body), onSuccess: () => { refresh(); setKey(null) } })
  const remove = useMutation({ mutationFn: () => api.del(`/providers/${p.id}`), onSuccess: () => { refresh(); go('/settings/providers') } })
  const [tested, setTested] = useState<{ at: number; ok: boolean; latencyMs: number; error?: string } | null>(null)
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; latencyMs: number; error?: string }>('/models/test', { providerId: p.id, model: live.models[0] }),
    onSuccess: r => { setTested({ ...r, at: Date.now() }); live.refresh() },
  })
  const compatible = p.kind === 'openai-compatible' || p.kind === 'typesafe' || Boolean(p.baseUrl)
  const priced = Object.keys(p.options.prices ?? {}).length
  return <>
    <Section title={p.name} foot={patch.error || remove.error ? <span className="text-danger">{((patch.error ?? remove.error) as Error).message}</span> : undefined}>
      <Row label={tx('名称')}><TextInput value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== p.name && patch.mutate({ name: name.trim() })} /></Row>
      {compatible && <Row label="Base URL" sub={tx('自动补上 /v1')}><TextInput className="w-[300px] font-mono" value={baseUrl} placeholder="https://…/v1"
        onChange={e => setBaseUrl(e.target.value)} onBlur={() => baseUrl.trim() !== (p.baseUrl ?? '') && patch.mutate({ baseUrl: baseUrl.trim() || null })} /></Row>}
      {p.keyEnv ? <Row label="API key" sub={tx('从环境变量 {0} 读取{1}', p.keyEnv, p.hasKey ? ` · ${p.keyHint}` : tx('（现在没设置）'))} />
        : <Row label="API key" sub={p.hasKey ? tx('在钥匙串里 · {0}', p.keyHint) : tx('还没有密钥')}>
          {p.hasKey && <Btn tone="danger" onClick={() => { if (confirm(tx('从钥匙串删掉「{0}」的密钥？', p.name))) patch.mutate({ apiKey: null }) }}>{tx('移除密钥')}</Btn>}
          <Btn onClick={() => setKey(k => (k === null ? '' : null))}>{p.hasKey ? tx('更换密钥') : tx('填入密钥')}</Btn>
        </Row>}
      {key !== null && <Row label={tx('新的 API key')}>
        <TextInput type="password" autoComplete="off" autoFocus value={key} onChange={e => setKey(e.target.value)} placeholder="sk-…" />
        <Btn tone="ink" disabled={!key || patch.isPending} onClick={() => patch.mutate({ apiKey: key })}>{tx('保存')}</Btn>
      </Row>}
      {p.kind !== 'typesafe' && <Row label={tx('连通测试')} sub={test.isPending || live.loading ? tx('在试…')
        : tested ? (tested.ok ? `${tx('刚刚 · {0}ms · 读到 {1} 个模型', tested.latencyMs, live.models.length)}${breakdown(live.types)}` : <span className="text-danger">{tested.error?.slice(0, 160)}</span>)
        : live.error ? <span className="text-danger">{tx('读不到模型列表：{0}', live.error.slice(0, 160))}</span> : live.models.length ? `${tx('读到 {0} 个模型', live.models.length)}${breakdown(live.types)}` : tx('还没试过')}>
        <Btn disabled={test.isPending || !live.models.length} onClick={() => test.mutate()}>{tested ? tx('再测一次') : tx('测一次')}</Btn>
      </Row>}
      {p.kind === 'openai-compatible' && <Row label={tx('决策接口')} sub={tx('网关上的 Jev 决策接口；留空会自动找 /systemone、/decisions 等常见路径')}>
        <TextInput className="w-[260px] font-mono" value={decisions} placeholder={tx('自动查找')} onChange={e => setDecisions(e.target.value)}
          onBlur={() => decisions.trim() !== (p.options.decisionsUrl ?? '') && patch.mutate({ options: { ...p.options, decisionsUrl: decisions.trim() || undefined } })} />
      </Row>}
      <Row label={tx('价格')} sub={tx('美元 / 百万 token · {0}，用量页才算得出费用', priced ? tx('{0} 个模型填了价格', priced) : tx('还没填'))}><Btn onClick={() => setPrices(v => !v)}>{prices ? tx('收起') : tx('编辑价格')}</Btn></Row>
      {prices && <Prices p={p} onDone={() => setPrices(false)} />}
      <Row label={tx('删除这个供应商')} sub={tx('用到它的分层会去掉这个模型，密钥也从钥匙串删除')}>
        <Btn tone="danger" disabled={remove.isPending} onClick={() => { if (confirm(tx('删除「{0}」？', p.name))) remove.mutate() }}>{tx('删除')}</Btn>
      </Row>
    </Section>
  </>
}

function Prices({ p, onDone }: { p: Provider; onDone(): void }) {
  const qc = useQueryClient()
  const { models } = useModelOptions(p)
  const [rows, setRows] = useState<(Price & { model: string })[]>(() => Object.entries(p.options.prices ?? {}).map(([model, price]) => ({ model, ...price })))
  const save = useMutation({
    mutationFn: () => api.patch(`/providers/${p.id}`, { options: { ...p.options, prices: Object.fromEntries(rows.filter(r => r.model.trim()).map(({ model, ...price }) => [model.trim(), price])) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['providers'] }); onDone() },
  })
  const set = (i: number, patch: Partial<Price & { model: string }>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const num = (v: string) => (v === '' ? undefined : Number(v))
  const grid = 'grid grid-cols-[1fr_72px_72px_72px_24px] items-center gap-1.5'
  return <Block className="space-y-1.5">
    <datalist id={`price-models-${p.id}`}>{models.map(m => <option key={m} value={m} />)}</datalist>
    <div className={`${grid} text-xs text-faint`}><span>{tx('模型')}</span><span>{tx('输入')}</span><span>{tx('输出')}</span><span>{tx('缓存读')}</span><span /></div>
    {rows.map((r, i) => <div key={i} className={grid}>
      <TextInput list={`price-models-${p.id}`} className="w-full font-mono" value={r.model} onChange={e => set(i, { model: e.target.value })} />
      {(['input', 'output', 'cacheRead'] as const).map(k => <NumberInput key={k} className="w-full" min={0} step="any" value={r[k] ?? ''} onChange={e => set(i, { [k]: num(e.target.value) })} aria-label={k} />)}
      <button type="button" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} aria-label={tx('删掉这一行')} className="text-faint hover:text-danger"><Trash2 size={14} /></button>
    </div>)}
    <div className="flex items-center gap-2 pt-1">
      <Btn onClick={() => setRows(rs => [...rs, { model: '' }])}><Plus size={13} />{tx('加一行')}</Btn>
      {save.error && <span className="text-xs text-danger">{(save.error as Error).message}</span>}
      <span className="flex-1" />
      <Btn onClick={onDone}>{tx('取消')}</Btn>
      <Btn tone="ink" disabled={save.isPending} onClick={() => save.mutate()}>{tx('保存价格')}</Btn>
    </div>
  </Block>
}

/** 添加: pick a preset, then only what it needs. */
function AddProvider({ onDone }: { onDone(id?: string): void }) {
  const qc = useQueryClient()
  const catalog = useCatalog()
  const [preset, setPreset] = useState<Preset | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const create = useMutation({
    mutationFn: () => api.post<{ provider: Provider }>('/providers', { kind: preset!.kind, name: name || preset!.label, baseUrl: baseUrl || null, apiKey: apiKey || null }),
    onSuccess: r => { qc.invalidateQueries({ queryKey: ['providers'] }); onDone(r.provider?.id) },
  })
  const compatible = preset?.kind === 'openai-compatible' || preset?.kind === 'typesafe'
  if (!preset) return <Section title={tx('添加供应商')} foot={<button type="button" className="text-muted hover:text-fg" onClick={() => onDone()}>{tx('取消')}</button>}>
    <Block className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {catalog.data?.presets.map(p => <button key={p.id} type="button" onClick={() => { setPreset(p); setName(p.label); setBaseUrl(p.baseUrl ?? '') }}
        className="rounded-[10px] border border-line bg-card px-3 py-2.5 text-left hover:border-faint">
        <div className="text-sm font-medium">{p.label}</div><div className="text-xs text-faint">{catalog.data && tx(catalog.data.kinds[p.kind].label)}</div>
      </button>)}
    </Block>
  </Section>
  return <Section title={tx('添加 {0}', preset.label)}>
    <Row label={tx('名称')}><TextInput value={name} onChange={e => setName(e.target.value)} /></Row>
    {compatible && <Row label="Base URL" sub={tx('接口地址，通常以 /v1 结尾')}><TextInput className="w-[300px] font-mono" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://…/v1" /></Row>}
    <Row label="API key" sub={<>{preset.keyRequired ? tx('存进系统钥匙串') : tx('本机服务可以留空')}{preset.docsUrl && <a href={preset.docsUrl} target="_blank" rel="noreferrer" className="ml-1.5 inline-flex items-center gap-0.5 text-accent">{tx('去拿一个')}<ExternalLink size={11} /></a>}</>}>
      <TextInput type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" />
    </Row>
    <Block className="flex flex-wrap items-center justify-end gap-2">
      {create.error && <span className="mr-auto text-xs text-danger">{(create.error as Error).message}</span>}
      <Btn onClick={() => setPreset(null)}>{tx('换一个')}</Btn>
      <Btn onClick={() => onDone()}>{tx('取消')}</Btn>
      <Btn tone="ink" disabled={create.isPending || (preset.keyRequired && !apiKey) || (compatible && !baseUrl)} onClick={() => create.mutate()}>{tx('添加')}</Btn>
    </Block>
  </Section>
}
