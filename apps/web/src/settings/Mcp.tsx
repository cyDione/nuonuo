import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Server, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type McpServer, type McpStatus } from '../api'
import { Badge, Button, Card, Empty, Field, Input, Select } from '../ui'

const blank = (): McpServer => ({ name: '', enabled: true, transport: 'stdio', command: 'npx', args: [], env: {}, roles: ['worker'], review: true })
const kv = (o?: Record<string, string>) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
const parseKv = (s: string) => Object.fromEntries(s.split('\n').map(l => l.trim()).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))

export function Mcp() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['mcp'], queryFn: () => api.get<{ servers: McpServer[]; status: McpStatus[] }>('/settings/mcp'), refetchInterval: 10_000 })
  const [draft, setDraft] = useState<McpServer[] | null>(null)
  useEffect(() => { if (query.data && !draft) setDraft(query.data.servers) }, [query.data])
  const save = useMutation({ mutationFn: (servers: McpServer[]) => api.put<{ servers: McpServer[]; status: McpStatus[] }>('/settings/mcp', servers),
    onSuccess: d => { qc.setQueryData(['mcp'], d); setDraft(d.servers) } })
  if (!draft || !query.data) return null
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data.servers)
  const set = (i: number, patch: Partial<McpServer>) => setDraft(d => d!.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const statusOf = (name: string) => query.data!.status.find(s => s.name === name)
  return <>
    <div className="flex justify-end"><Button variant="primary" onClick={() => setDraft(d => [...d!, blank()])}><Plus size={16} />添加 MCP 服务</Button></div>
    {!draft.length && <Card><Empty icon={<Server size={28} />} title="还没有 MCP 服务">MCP 服务提供的工具会交给任务使用，例如文件系统、数据库、日历、Notion。</Empty></Card>}
    {draft.map((s, i) => {
      const st = statusOf(s.name)
      return <Card key={i} className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Server size={16} className="text-muted" />
          <div className="w-48"><Input className="h-8 font-mono text-xs" value={s.name} placeholder="名称（如 notion）" onChange={e => set(i, { name: e.target.value })} /></div>
          {st && <Badge tone={st.state === 'connected' ? 'ok' : st.state === 'error' ? 'danger' : 'neutral'}>{st.state === 'connected' ? `已连接 · ${st.tools.length} 个工具` : st.state === 'error' ? '连接失败' : st.state === 'connecting' ? '连接中' : '未启用'}</Badge>}
          <label className="ml-auto flex items-center gap-1.5 text-sm"><input type="checkbox" checked={s.enabled} onChange={e => set(i, { enabled: e.target.checked })} />启用</label>
          <button onClick={() => setDraft(d => d!.filter((_, j) => j !== i))} className="text-faint hover:text-danger" aria-label="删除"><Trash2 size={15} /></button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="连接方式"><Select value={s.transport} onChange={e => set(i, { transport: e.target.value as McpServer['transport'] })}><option value="stdio">本地命令（stdio）</option><option value="http">HTTP 地址</option></Select></Field>
          {s.transport === 'stdio' ? <>
            <Field label="命令"><Input className="font-mono text-xs" value={s.command ?? ''} onChange={e => set(i, { command: e.target.value })} placeholder="npx" /></Field>
            <Field label="参数（空格分隔）"><Input className="font-mono text-xs" value={(s.args ?? []).join(' ')} onChange={e => set(i, { args: e.target.value.split(' ').filter(Boolean) })} placeholder="-y @modelcontextprotocol/server-filesystem ~/notes" /></Field>
          </> : <Field label="URL"><Input className="font-mono text-xs" value={s.url ?? ''} onChange={e => set(i, { url: e.target.value })} placeholder="https://…/mcp" /></Field>}
        </div>
        <Field label={s.transport === 'stdio' ? '环境变量（每行 KEY=VALUE）' : '请求头（每行 Name=Value）'} hint="值可以写成 ${NAME}，从本机服务的环境变量读取，不必把密钥写进设置。">
          <textarea className="min-h-16 w-full rounded-xl border border-line bg-panel px-3 py-2 font-mono text-xs outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15 focus-visible:outline-none"
            value={kv(s.transport === 'stdio' ? s.env : s.headers)} onChange={e => set(i, s.transport === 'stdio' ? { env: parseKv(e.target.value) } : { headers: parseKv(e.target.value) })} />
        </Field>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={s.roles.includes('worker')} onChange={e => set(i, { roles: e.target.checked ? [...new Set([...s.roles, 'worker' as const])] : s.roles.filter(r => r !== 'worker') })} />任务（Worker）可用</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={s.roles.includes('router')} onChange={e => set(i, { roles: e.target.checked ? [...new Set([...s.roles, 'router' as const])] : s.roles.filter(r => r !== 'router') })} />主 Agent 可用</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={s.review} onChange={e => set(i, { review: e.target.checked })} />任务的调用先经过审核</label>
        </div>
        {st?.error && <p className="text-xs text-danger">{st.error}</p>}
        {st?.tools.length ? <p className="text-xs text-faint">工具：{st.tools.map(t => t.name).join('、')}</p> : null}
      </Card>
    })}
    {(dirty || save.error) && <div className="flex items-center justify-end gap-2">
      {save.error && <span className="mr-auto text-xs text-danger">{(save.error as Error).message}</span>}
      <Button size="sm" variant="ghost" onClick={() => setDraft(query.data!.servers)}>还原</Button>
      <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate(draft)}>保存并连接</Button>
    </div>}
  </>
}
