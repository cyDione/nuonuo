/**
 * 插件 (Figma 26): third-party plugins. 安装插件 opens a box that takes a GitHub address, an npm name, a .tgz URL or a
 * folder; each plugin's ⋯ holds 更新 / 重新加载 / 卸载. A plugin arrives switched off and runs only once switched on.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ellipsis, FolderOpen, LoaderCircle, Plus, Puzzle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type PluginInfo } from '../api'
import { desktop } from '../shell'
import { cx } from '../ui'
import { Btn, Page, Pill, Row, Section, TextInput, Toggle } from './kit'
import { tx } from '../i18n'

/** Where a plugin came from, in a word: the same reading of the address as the service's. */
export function originLabel(origin?: string): string | undefined {
  if (!origin) return undefined
  const s = origin.trim()
  if (/^(~|\/|\.\.?\/|[A-Za-z]:[\\/])/.test(s)) return tx('来自文件夹')
  if (s.startsWith('github:') || /^https?:\/\/github\.com\//i.test(s) || /^[\w.-]+\/[\w.-]+(#.+)?$/.test(s)) return tx('来自 GitHub')
  if (/^https?:\/\//i.test(s)) return tx('来自网址')
  return tx('来自 npm')
}

/** Closes on a click outside `ref` or on Esc. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('pointerdown', onDown)
    addEventListener('keydown', onKey)
    return () => { removeEventListener('pointerdown', onDown); removeEventListener('keydown', onKey) }
  }, [open, close])
  return ref
}

function InstallButton({ onInstalled }: { onInstalled(id: string): void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState('')
  const ref = useDismiss(open, () => setOpen(false))
  const install = useMutation({
    mutationFn: (s: string) => api.post<{ plugin: PluginInfo }>('/plugins/install', { source: s }),
    onSuccess: ({ plugin }) => { setSource(''); setOpen(false); onInstalled(plugin.id) },
    onSettled: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })
  const submit = (s: string) => { if (s.trim() && !install.isPending) install.mutate(s.trim()) }
  const pick = async () => { const dir = await desktop?.pickFolder?.(); if (dir) { setSource(dir); submit(dir) } }
  return <div ref={ref} className="relative">
    <Btn tone="ink" onClick={() => setOpen(o => !o)} aria-expanded={open}><Plus size={14} />{tx('安装插件')}</Btn>
    {open && <div className="absolute top-[calc(100%+8px)] right-0 z-20 w-[360px] max-w-[calc(100vw-32px)] space-y-2.5 rounded-[14px] border border-line bg-card p-3.5 shadow-[0_12px_32px_rgb(0_0_0/0.12)]">
      <form onSubmit={e => { e.preventDefault(); submit(source) }} className="space-y-2.5">
        <TextInput autoFocus value={source} onChange={e => setSource(e.target.value)} disabled={install.isPending} aria-label={tx('插件地址')}
          placeholder={tx('GitHub 地址、npm 包名或文件夹路径')} className="w-full" />
        {install.error && <p className="text-xs text-danger">{(install.error as Error).message}</p>}
        <div className="flex items-center gap-2">
          {desktop?.pickFolder && <Btn onClick={pick} disabled={install.isPending}><FolderOpen size={14} />{tx('选择文件夹…')}</Btn>}
          <Btn tone="ink" type="submit" className="ml-auto" disabled={!source.trim() || install.isPending}>
            {install.isPending ? <><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />{tx('正在安装…')}</> : tx('安装')}
          </Btn>
        </div>
      </form>
    </div>}
  </div>
}

function MoreMenu({ plugin, onError }: { plugin: PluginInfo; onError(message: string | undefined): void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const run = useMutation({
    mutationFn: (action: 'update' | 'reload' | 'uninstall') => action === 'uninstall' ? api.del(`/plugins/${plugin.id}`) : api.post(`/plugins/${plugin.id}/${action}`),
    onMutate: () => { setOpen(false); onError(undefined) },
    onError: error => onError((error as Error).message),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['plugins'] }); qc.invalidateQueries({ queryKey: ['sources'] }); qc.invalidateQueries({ queryKey: ['mcp'] }) },
  })
  const item = (label: string, icon: ReactNode, onClick: () => void, danger?: boolean, disabled?: boolean) =>
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled}
      className={cx('flex h-[32px] w-full items-center gap-2 rounded-[8px] px-2 text-left text-[13px] hover:bg-sunken disabled:opacity-40 disabled:hover:bg-transparent', danger && 'text-danger')}>
      {icon}{label}</button>
  return <div ref={ref} className="relative">
    <button type="button" onClick={() => setOpen(o => !o)} aria-label={tx('{0} 的更多操作', plugin.name)} aria-haspopup="menu" aria-expanded={open} disabled={run.isPending}
      className={cx('flex size-7 items-center justify-center rounded-[8px] text-muted hover:bg-line hover:text-fg', open && 'bg-line text-fg')}>
      {run.isPending ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /> : <Ellipsis size={16} />}
    </button>
    {open && <div role="menu" className="absolute top-[calc(100%+6px)] right-0 z-20 w-[168px] space-y-0.5 rounded-[12px] border border-line bg-card p-1.5 shadow-[0_10px_28px_rgb(0_0_0/0.12)]">
      {item(tx('更新'), <RefreshCw size={15} />, () => run.mutate('update'), false, !plugin.origin)}
      {item(tx('重新加载'), <RotateCcw size={15} />, () => run.mutate('reload'), false, !plugin.enabled)}
      <div className="mx-1 my-1 h-px bg-line" />
      {item(tx('卸载'), <Trash2 size={15} />, () => { if (confirm(tx('卸载「{0}」？\n\n会删除插件文件，以及它提供的来源的设置。', plugin.name))) run.mutate('uninstall') }, true)}
    </div>}
  </div>
}

export function Plugins() {
  const qc = useQueryClient()
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.get<{ plugins: PluginInfo[]; dir: string; sandbox?: boolean }>('/plugins') })
  const toggle = useMutation({
    mutationFn: (p: PluginInfo) => api.post(`/plugins/${p.id}`, { enabled: !p.enabled }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['plugins'] }); qc.invalidateQueries({ queryKey: ['sources'] }); qc.invalidateQueries({ queryKey: ['mcp'] }) },
  })
  const [fresh, setFresh] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const external = (plugins.data?.plugins ?? []).filter(p => !p.builtIn)
  const dir = plugins.data?.dir ?? ''
  const warning = (name: string) => plugins.data?.sandbox === false
    ? tx('启用「{0}」？\n\n插件沙箱已关闭，插件代码会以本机服务的权限运行，只启用你信任的插件。', name)
    : tx('启用「{0}」？\n\n插件会在单独的受限进程里运行，只能读写自己的文件夹，也拿不到你的密钥。仍然只建议启用你信任的插件。', name)
  const openFolder = async () => {
    if (desktop?.reveal) { await desktop.reveal(dir); return }
    await navigator.clipboard?.writeText(dir).catch(() => {})
    setCopied(true)
  }
  const error = (toggle.error as Error | null)?.message ?? actionError
  return <Page title={tx('插件')} action={<InstallButton onInstalled={setFresh} />}>
    <Section title={tx('第三方插件')} foot={<>{tx('打开开关才会运行插件代码。内置的 Telegram、飞书、Discord 和 Gmail 在「来源」里。')}{error && <span className="block text-danger">{error}</span>}</>}>
      {external.map(p => { const failed = p.enabled && !p.loaded
        const sub = [p.version && `v${p.version}`, failed ? tx('加载失败：{0}', p.error ?? tx('原因不明')) : originLabel(p.origin) ?? p.description,
          p.sources.length ? tx('提供来源：{0}', p.sources.join('、')) : '', p.mcpServers.length ? tx('MCP：{0}', p.mcpServers.join('、')) : '',
          p.tools.length ? tx('{0} 个工具', p.tools.length) : '', p.skills.length ? tx('{0} 件会做的事', p.skills.length) : '', ...(p.notes ?? [])].filter(Boolean).join(' · ')
        return <Row key={p.id} icon={<Puzzle size={18} />} label={p.name} sub={<span className="line-clamp-2">{sub}</span>}>
          {failed ? <Pill tone="danger">{tx('加载失败')}</Pill> : fresh === p.id && !p.enabled && <Pill tone="accent">{tx('刚装好')}</Pill>}
          <Toggle label={tx('启用 {0}', p.name)} checked={p.enabled} disabled={toggle.isPending}
            onChange={() => { if (p.enabled || confirm(warning(p.name))) { setFresh(undefined); toggle.mutate(p) } }} />
          <MoreMenu plugin={p} onError={setActionError} />
        </Row> })}
      {plugins.isSuccess && !external.length && <Row label={tx('还没有第三方插件')} sub={tx('写法见仓库里的 docs/04-plugin-sdk.md 和 examples/plugins/rss-watch。')} />}
      {dir && <button type="button" onClick={openFolder} className="flex min-h-[44px] w-full items-center gap-3 text-left text-sm text-muted hover:text-fg">
        <FolderOpen size={18} />{desktop?.reveal ? tx('打开插件文件夹') : copied ? tx('已复制路径：{0}', dir) : tx('复制插件文件夹的路径')}
      </button>}
    </Section>
  </Page>
}
