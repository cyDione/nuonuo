import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Plus, Trash2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { api, type Preset, type Price, type Provider } from '../api'
import { Badge, Button, Card, Empty, Field, Input, Modal } from '../ui'
import { useCatalog, useModelOptions, useProviders } from './hooks'

const KIND_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Gemini', deepseek: 'DeepSeek', 'openai-compatible': 'OpenAI 兼容', typesafe: 'TypeSafe（决策模型）' }

export function Providers() {
  const providers = useProviders()
  const [adding, setAdding] = useState(false)
  const list = providers.data?.providers ?? []
  return <>
    <div className="flex justify-end"><Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} />添加供应商</Button></div>
    {providers.isSuccess && list.length === 0 && <Card><Empty icon={<KeyRound size={28} />} title="还没有模型供应商">
      添加至少一个供应商（例如 Anthropic、OpenAI，或本地的 Ollama），然后到「分层模型」为主 Agent 选择模型。</Empty></Card>}
    <div className="space-y-3">{list.map(p => <ProviderCard key={p.id} p={p} />)}</div>
    {adding && <AddProvider onClose={() => setAdding(false)} />}
  </>
}

function ProviderCard({ p }: { p: Provider }) {
  const qc = useQueryClient()
  const [modal, setModal] = useState<'key' | 'prices' | null>(null)
  const remove = useMutation({ mutationFn: () => api.del(`/providers/${p.id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['providers'] }); qc.invalidateQueries({ queryKey: ['roles'] }) } })
  // Jev via a gateway: the decisions endpoint is found automatically; this pins it when the gateway uses another path.
  const decisions = useMutation({ mutationFn: (url: string) => api.patch(`/providers/${p.id}`, { options: { ...p.options, decisionsUrl: url || undefined } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }) })
  const editDecisions = () => {
    const url = prompt('Jev 决策接口的完整地址（留空则自动查找 /systemone、/decisions 等常见路径）', p.options.decisionsUrl ?? '')
    if (url !== null) decisions.mutate(url.trim())
  }
  return <Card className="p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2"><span className="font-medium">{p.name}</span><Badge>{KIND_LABEL[p.kind]}</Badge></div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {p.baseUrl && <span className="font-mono">{p.baseUrl}</span>}
          <span>{p.keyEnv ? <>环境变量 <span className="font-mono">{p.keyEnv}</span>{p.hasKey ? <> · <span className="font-mono">{p.keyHint}</span></> : ' · 当前未设置'}</>
            : p.hasKey ? <>密钥 <span className="font-mono">{p.keyHint}</span></> : '未设置密钥'}</span>
          {p.options.decisionsUrl && <span>决策接口 <span className="font-mono">{p.options.decisionsUrl}</span></span>}
          {p.options.prices && Object.keys(p.options.prices).length > 0 && <span>已填 {Object.keys(p.options.prices).length} 个模型价格</span>}
        </div>
      </div>
      <div className="flex gap-1.5">
        {!p.keyEnv && <Button size="sm" onClick={() => setModal('key')}>更换密钥</Button>}
        <Button size="sm" onClick={() => setModal('prices')}>价格</Button>
        {p.kind === 'openai-compatible' && <Button size="sm" onClick={editDecisions}>Jev 接口</Button>}
        <Button size="sm" variant="danger" onClick={() => { if (confirm(`删除「${p.name}」？使用它的分层配置会一并移除该模型，密钥也会从钥匙串删除。`)) remove.mutate() }}><Trash2 size={13} /></Button>
      </div>
    </div>
    <TestRow p={p} />
    {modal === 'key' && <KeyModal p={p} onClose={() => setModal(null)} />}
    {modal === 'prices' && <PricesModal p={p} onClose={() => setModal(null)} />}
  </Card>
}

function TestRow({ p }: { p: Provider }) {
  const { models, error, loading } = useModelOptions(p)
  const [model, setModel] = useState('')
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; latencyMs: number; text?: string; error?: string }>('/models/test', { providerId: p.id, model: model || models[0] }) })
  const listId = `models-${p.id}`
  return <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
    <span className="text-xs text-muted">连通测试</span>
    <Input list={listId} value={model} onChange={e => setModel(e.target.value)} placeholder={models[0] ?? '模型 id'} className="h-7 max-w-64 text-xs" />
    <datalist id={listId}>{models.map(m => <option key={m} value={m} />)}</datalist>
    <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending || !(model || models[0])}>
      {test.isPending ? <Loader2 size={13} className="animate-spin" /> : '测试'}
    </Button>
    {loading && <span className="text-xs text-faint">读取模型列表…</span>}
    {!loading && error && <span className="text-xs text-faint" title={error}>未能读取模型列表，可手动输入</span>}
    {test.data && (test.data.ok
      ? <span className="flex items-center gap-1 text-xs text-ok"><CheckCircle2 size={13} />{test.data.latencyMs} ms · {test.data.text}</span>
      : <span className="flex items-center gap-1 text-xs text-danger" title={test.data.error}><XCircle size={13} />{test.data.error?.slice(0, 120)}</span>)}
  </div>
}

function AddProvider({ onClose }: { onClose(): void }) {
  const qc = useQueryClient()
  const catalog = useCatalog()
  const [preset, setPreset] = useState<Preset | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const create = useMutation({
    mutationFn: () => api.post('/providers', { kind: preset!.kind, name: name || preset!.label, baseUrl: baseUrl || null, apiKey: apiKey || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['providers'] }); onClose() },
  })
  const pick = (p: Preset) => { setPreset(p); setName(p.label); setBaseUrl(p.baseUrl ?? '') }
  const compatible = preset?.kind === 'openai-compatible'
  return <Modal title={preset ? `添加 ${preset.label}` : '选择供应商'} onClose={onClose} footer={preset && <>
    <Button variant="ghost" onClick={() => setPreset(null)}>返回</Button>
    <Button variant="primary" disabled={create.isPending || (preset.keyRequired && !apiKey) || (compatible && !baseUrl)} onClick={() => create.mutate()}>保存</Button>
  </>}>
    {!preset && <div className="grid grid-cols-2 gap-2">
      {catalog.data?.presets.map(p => <button key={p.id} onClick={() => pick(p)} className="rounded-lg border border-line px-3 py-2.5 text-left text-sm hover:border-accent">
        <div className="font-medium">{p.label}</div><div className="text-xs text-faint">{KIND_LABEL[p.kind]}</div>
      </button>)}
    </div>}
    {preset && <>
      <Field label="名称"><Input value={name} onChange={e => setName(e.target.value)} /></Field>
      {compatible && <Field label="Base URL" hint="OpenAI 兼容接口的地址，通常以 /v1 结尾"><Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://…/v1" /></Field>}
      <Field label={preset.keyRequired ? 'API key' : 'API key（本地服务可留空）'}
        hint={preset.docsUrl && <a href={preset.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent">获取 API key <ExternalLink size={11} /></a>}>
        <Input type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" />
      </Field>
      {create.error && <p className="text-sm text-danger">{(create.error as Error).message}</p>}
    </>}
  </Modal>
}

function KeyModal({ p, onClose }: { p: Provider; onClose(): void }) {
  const qc = useQueryClient()
  const [apiKey, setApiKey] = useState('')
  const save = useMutation({ mutationFn: (key: string | null) => api.patch(`/providers/${p.id}`, { apiKey: key }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['providers'] }); qc.invalidateQueries({ queryKey: ['models', p.id] }); onClose() } })
  return <Modal title={`更换密钥 · ${p.name}`} onClose={onClose} footer={<>
    {p.hasKey && <Button variant="danger" onClick={() => save.mutate(null)}>移除密钥</Button>}
    <Button variant="primary" disabled={!apiKey || save.isPending} onClick={() => save.mutate(apiKey)}>保存</Button>
  </>}>
    <Field label="新的 API key"><Input type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} autoFocus /></Field>
  </Modal>
}

function PricesModal({ p, onClose }: { p: Provider; onClose(): void }) {
  const qc = useQueryClient()
  const { models } = useModelOptions(p)
  const [rows, setRows] = useState<(Price & { model: string })[]>(() => Object.entries(p.options.prices ?? {}).map(([model, price]) => ({ model, ...price })))
  const save = useMutation({
    mutationFn: () => api.patch(`/providers/${p.id}`, { options: { ...p.options, prices: Object.fromEntries(rows.filter(r => r.model.trim()).map(({ model, ...price }) => [model.trim(), price])) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['providers'] }); onClose() },
  })
  const set = (i: number, patch: Partial<Price & { model: string }>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const num = (v: string) => (v === '' ? undefined : Number(v))
  return <Modal title={`模型价格 · ${p.name}`} onClose={onClose} footer={<Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>保存</Button>}>
    <p className="text-xs text-muted">单位：美元 / 百万 token。只用于用量页的费用估算。缓存读写留空时按输入价计。</p>
    <datalist id={`price-models-${p.id}`}>{models.map(m => <option key={m} value={m} />)}</datalist>
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_70px_70px_70px_24px] gap-1.5 text-[11px] text-faint"><span>模型</span><span>输入</span><span>输出</span><span>缓存读</span><span /></div>
      {rows.map((r, i) => <div key={i} className="grid grid-cols-[1fr_70px_70px_70px_24px] items-center gap-1.5">
        <Input list={`price-models-${p.id}`} className="h-8 text-xs" value={r.model} onChange={e => set(i, { model: e.target.value })} />
        <Input className="h-8 text-xs" type="number" min={0} step="any" value={r.input ?? ''} onChange={e => set(i, { input: num(e.target.value) })} />
        <Input className="h-8 text-xs" type="number" min={0} step="any" value={r.output ?? ''} onChange={e => set(i, { output: num(e.target.value) })} />
        <Input className="h-8 text-xs" type="number" min={0} step="any" value={r.cacheRead ?? ''} onChange={e => set(i, { cacheRead: num(e.target.value) })} />
        <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} className="text-faint hover:text-danger"><Trash2 size={14} /></button>
      </div>)}
      <Button size="sm" onClick={() => setRows(rs => [...rs, { model: '' }])}><Plus size={13} />添加一行</Button>
    </div>
  </Modal>
}
