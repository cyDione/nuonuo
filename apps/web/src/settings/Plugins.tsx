import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Package, Puzzle } from 'lucide-react'
import { api, type PluginInfo } from '../api'
import { Badge, Button, Card, Empty } from '../ui'

export function Plugins() {
  const qc = useQueryClient()
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.get<{ plugins: PluginInfo[]; dir: string }>('/plugins') })
  const toggle = useMutation({
    mutationFn: (p: PluginInfo) => api.post(`/plugins/${p.id}`, { enabled: !p.enabled }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['plugins'] }); qc.invalidateQueries({ queryKey: ['sources'] }) },
  })
  const list = plugins.data?.plugins ?? []
  const external = list.filter(p => !p.builtIn)
  return <>
    <div className="space-y-3">
      {list.filter(p => p.builtIn).map(p => <Row key={p.id} p={p} />)}
      {external.map(p => <Row key={p.id} p={p} action={<Button size="sm" variant={p.enabled ? 'secondary' : 'primary'} disabled={toggle.isPending}
        onClick={() => { if (p.enabled || confirm(`启用「${p.name}」？\n\n插件代码会以本机服务的权限运行，只启用你信任的插件。`)) toggle.mutate(p) }}>{p.enabled ? '停用' : '启用'}</Button>} />)}
    </div>
    {plugins.isSuccess && !external.length && <Card><Empty icon={<Puzzle size={28} />} title="还没有第三方插件">
      把插件文件夹放进 <code className="font-mono text-xs">{plugins.data.dir}</code>，刷新这个页面后启用。写法见仓库里的 docs/04-plugin-sdk.md 和 examples/plugins/rss-watch。</Empty></Card>}
    {toggle.error && <p className="text-sm text-danger">{(toggle.error as Error).message}</p>}
  </>
}

function Row({ p, action }: { p: PluginInfo; action?: React.ReactNode }) {
  return <Card className="flex flex-wrap items-start gap-3 p-4">
    <Package size={18} className="mt-0.5 text-muted" />
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        {p.version && <span className="font-mono text-xs text-faint">v{p.version}</span>}
        {p.builtIn ? <Badge>内置</Badge> : p.loaded ? <Badge tone="ok">已加载</Badge> : p.enabled ? <Badge tone="danger">加载失败</Badge> : <Badge>未启用</Badge>}
      </div>
      {p.description && <p className="mt-0.5 text-xs text-muted">{p.description}</p>}
      {p.sources.length > 0 && <p className="mt-1 text-xs text-faint">提供来源：{p.sources.join('、')}（在「来源」页配置）</p>}
      {p.dir && <p className="mt-1 truncate font-mono text-[11px] text-faint">{p.dir}</p>}
      {p.error && <p className="mt-1 text-xs text-danger">{p.error}</p>}
    </div>
    {action}
  </Card>
}
