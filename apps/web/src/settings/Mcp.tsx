/** MCP 工具 (Figma 21 · 05): MCP services whose tools go to its work. The list with each one's state, the open one below. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type McpServer, type McpStatus } from '../api'
import { usePersona } from '../persona'
import { Area, Block, Btn, Choice, Page, Pill, Row, Section, TextInput, Toggle } from './kit'
import { tx } from '../i18n'

const blank = (): McpServer => ({ name: '', enabled: true, transport: 'stdio', command: 'npx', args: [], env: {}, roles: ['worker'], review: true })
const kv = (o?: Record<string, string>) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
const parseKv = (s: string) => Object.fromEntries(s.split('\n').map(l => l.trim()).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const STATE: Record<McpStatus['state'], { tone: 'ok' | 'danger' | 'warn' | 'neutral'; label: string }> = {
  connected: { tone: 'ok', label: tx('已连接') }, error: { tone: 'danger', label: tx('出错') }, connecting: { tone: 'warn', label: tx('连接中') }, off: { tone: 'neutral', label: tx('没打开') },
}
const where = (s: McpServer) => s.transport === 'http' ? `HTTP · ${(s.url ?? '').replace(/^https?:\/\//, '')}` : tx('本地命令 · {0}', [s.command, ...(s.args ?? [])].filter(Boolean).join(' '))

export function Mcp({ item }: { item?: string }) {
  const qc = useQueryClient()
  const persona = usePersona()
  const query = useQuery({ queryKey: ['mcp'], queryFn: () => api.get<{ servers: McpServer[]; status: McpStatus[] }>('/settings/mcp'), refetchInterval: 10_000 })
  const [draft, setDraft] = useState<McpServer[] | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  useEffect(() => {
    if (!query.data || draft) return
    setDraft(query.data.servers)
    const i = item ? query.data.servers.findIndex(s => s.name === item) : 0
    if (i >= 0 && query.data.servers.length) setSel(i)
  }, [query.data])
  const save = useMutation({ mutationFn: (servers: McpServer[]) => api.put<{ servers: McpServer[]; status: McpStatus[] }>('/settings/mcp', servers),
    onSuccess: d => { qc.setQueryData(['mcp'], d); setDraft(d.servers) } })
  if (!draft || !query.data) return <Page title={tx('MCP 工具')}><div /></Page>
  const saved = query.data.servers
  const statusOf = (name: string) => query.data!.status.find(s => s.name === name)
  const set = (patch: Partial<McpServer>) => setDraft(d => d!.map((s, j) => (j === sel ? { ...s, ...patch } : s)))
  const role = (r: 'worker' | 'router', on: boolean) => { const s = draft[sel!]!; set({ roles: on ? [...new Set([...s.roles, r])] : s.roles.filter(x => x !== r) }) }
  const s = sel !== null ? draft[sel] : undefined
  const st = s && statusOf(s.name)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  return <Page title={tx('MCP 工具')} action={<Btn tone="ink" className="h-[32px] rounded-[10px]" onClick={() => { setDraft(d => [...d!, blank()]); setSel(draft.length) }}><Plus size={15} />{tx('添加')}</Btn>}>
    <Section foot={tx('接入 MCP 服务，它们的工具会交给任务用。会对外产生影响的服务，建议保留「先经过审核」。')}>
      {draft.map((x, i) => { const status = statusOf(x.name); const state = status && STATE[status.state]
        return <Row key={i} icon={<Server size={18} />} label={x.name || tx('新的服务')} onClick={() => setSel(i)}
          sub={<span className="line-clamp-1">{status?.state === 'error' ? tx('没连上，点进去看原因') : where(x)}</span>}>
          {i === sel && <span className="text-xs text-faint">{tx('正在看')}</span>}
          {state ? <Pill tone={state.tone}>{state.label}</Pill> : <Pill>{tx('没保存')}</Pill>}
        </Row> })}
      {!draft.length && <Row label={tx('还没有 MCP 服务')} sub={tx('比如文件系统、数据库、日历、Notion。点右上角「添加」。')} />}
    </Section>

    {s && <Section title={s.name || tx('新的服务')}>
      <Row label={tx('名称')}><TextInput className="font-mono" value={s.name} placeholder="notion" onChange={e => set({ name: e.target.value })} /></Row>
      <Row label={tx('启用')}><Toggle label={tx('启用')} checked={s.enabled} onChange={enabled => set({ enabled })} /></Row>
      <Row label={tx('连接方式')}><Choice label={tx('连接方式')} value={s.transport} onChange={transport => set({ transport })} options={[{ id: 'stdio', label: tx('本地命令') }, { id: 'http', label: tx('HTTP 地址') }]} /></Row>
      {s.transport === 'http'
        ? <Row label="URL"><TextInput className="w-[300px] font-mono" value={s.url ?? ''} placeholder="https://…/mcp" onChange={e => set({ url: e.target.value })} /></Row>
        : <>
          <Row label={tx('命令')}><TextInput className="font-mono" value={s.command ?? ''} placeholder="npx" onChange={e => set({ command: e.target.value })} /></Row>
          <Row label={tx('参数')} sub={tx('空格分隔')}><TextInput className="w-[300px] font-mono" value={(s.args ?? []).join(' ')} placeholder="-y @modelcontextprotocol/server-filesystem ~/notes" onChange={e => set({ args: e.target.value.split(' ').filter(Boolean) })} /></Row>
        </>}
      <Block>
        <div className="text-sm">{s.transport === 'stdio' ? tx('环境变量') : tx('请求头')}</div>
        <div className="mt-0.5 mb-2 text-xs text-muted">{tx('每行一个 KEY=VALUE；值可以写成 {0}，从本机服务的环境变量读，不用把密钥写进设置', '${NAME}')}</div>
        <Area className="min-h-[56px] font-mono" value={kv(s.transport === 'stdio' ? s.env : s.headers)} onChange={e => set(s.transport === 'stdio' ? { env: parseKv(e.target.value) } : { headers: parseKv(e.target.value) })} />
      </Block>
      <Row label={tx('任务可以用')}><Toggle label={tx('任务可以用')} checked={s.roles.includes('worker')} onChange={on => role('worker', on)} /></Row>
      <Row label={tx('{0}自己也可以用', persona.name)} sub={tx('主聊里直接调用')}><Toggle label={tx('主聊可以用')} checked={s.roles.includes('router')} onChange={on => role('router', on)} /></Row>
      <Row label={tx('调用前先经过审核')} sub={tx('会对外产生影响时建议打开')}><Toggle label={tx('调用前先经过审核')} checked={s.review} onChange={review => set({ review })} /></Row>
      {st && (st.error || st.tools.length > 0) && <Row label={st.error ? tx('没连上') : tx('{0} 个工具', st.tools.length)} sub={<span className={st.error ? 'text-danger' : ''}>{st.error ?? st.tools.map(t => t.name).join('、')}</span>} />}
      <Block className="flex flex-wrap items-center justify-end gap-2">
        {save.error && <span className="mr-auto text-xs text-danger">{(save.error as Error).message}</span>}
        <Btn tone="danger" onClick={() => { if (!s.name || confirm(tx('删除「{0}」？', s.name))) { setDraft(d => d!.filter((_, j) => j !== sel)); setSel(null) } }}>{tx('删除')}</Btn>
        {dirty && <Btn onClick={() => { setDraft(saved); setSel(null) }}>{tx('还原')}</Btn>}
        <Btn tone="ink" disabled={!dirty || save.isPending || draft.some(x => !x.name.trim())} onClick={() => save.mutate(draft)}>{tx('保存并连接')}</Btn>
      </Block>
    </Section>}
    {!s && dirty && <div className="flex justify-end gap-2"><Btn onClick={() => setDraft(saved)}>{tx('还原')}</Btn><Btn tone="ink" disabled={save.isPending} onClick={() => save.mutate(draft)}>{tx('保存')}</Btn></div>}
  </Page>
}
