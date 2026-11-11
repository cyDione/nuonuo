/** 插件 (Figma 21 · 04): third-party plugins in the data directory's plugins/ folder; each runs only once switched on. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Puzzle } from 'lucide-react'
import { useState } from 'react'
import { api, type PluginInfo } from '../api'
import { desktop } from '../shell'
import { Page, Pill, Row, Section, Toggle } from './kit'
import { tx } from '../i18n'

export function Plugins() {
  const qc = useQueryClient()
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.get<{ plugins: PluginInfo[]; dir: string }>('/plugins') })
  const toggle = useMutation({
    mutationFn: (p: PluginInfo) => api.post(`/plugins/${p.id}`, { enabled: !p.enabled }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['plugins'] }); qc.invalidateQueries({ queryKey: ['sources'] }) },
  })
  const [copied, setCopied] = useState(false)
  const external = (plugins.data?.plugins ?? []).filter(p => !p.builtIn)
  const dir = plugins.data?.dir ?? ''
  const openFolder = async () => {
    if (desktop?.reveal) { await desktop.reveal(dir); return }
    await navigator.clipboard?.writeText(dir).catch(() => {})
    setCopied(true)
  }
  return <Page title={tx('插件')}>
    <Section title={tx('第三方插件')} foot={<>{tx('第三方插件放进数据目录的 plugins/ 文件夹，打开开关才会运行。内置的 Telegram 和 Gmail 在「来源」里。')}{toggle.error && <span className="block text-danger">{(toggle.error as Error).message}</span>}</>}>
      {external.map(p => { const failed = p.enabled && !p.loaded
        return <Row key={p.id} icon={<Puzzle size={18} />} label={p.name}
          sub={<span className="line-clamp-2">{[p.version && `v${p.version}`, failed ? tx('加载失败：{0}', p.error ?? tx('原因不明')) : p.description, p.sources.length ? tx('提供来源：{0}', p.sources.join('、')) : ''].filter(Boolean).join(' · ')}</span>}>
          {failed && <Pill tone="danger">{tx('加载失败')}</Pill>}
          <Toggle label={tx('启用 {0}', p.name)} checked={p.enabled} disabled={toggle.isPending}
            onChange={() => { if (p.enabled || confirm(tx('启用「{0}」？\n\n插件代码会以本机服务的权限运行，只启用你信任的插件。', p.name))) toggle.mutate(p) }} />
        </Row> })}
      {plugins.isSuccess && !external.length && <Row label={tx('还没有第三方插件')} sub={tx('写法见仓库里的 docs/04-plugin-sdk.md 和 examples/plugins/rss-watch。')} />}
      {dir && <button type="button" onClick={openFolder} className="flex min-h-[44px] w-full items-center gap-2 text-left text-sm text-muted hover:text-fg">
        <Plus size={16} />{desktop?.reveal ? tx('打开插件文件夹') : copied ? tx('已复制路径：{0}', dir) : tx('复制插件文件夹的路径')}
      </button>}
    </Section>
  </Page>
}
