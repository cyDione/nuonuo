/**
 * 安全和执行 (Figma v7, 23 · I; was 规则与审核 + 执行环境): how many things run at once, command timeouts, the Docker sandbox,
 * blocked commands, and the regex shortcuts the reviewer applies before thinking. The rules in your own words and who decides
 * live in the right pane's 权限; the record of every decision in 数据和隐私 · 原始记录.
 * 执行环境 (Figma 32): whether commands run on the cloud computer (default when one is connected) or on this machine, the
 * computer's state with 叫醒, and the browsers 糯糯 has open there. Provider settings (API key, machine) stay in 插件.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Cloud, Globe, Puzzle } from 'lucide-react'
import { api, type ComputerBrowser, type ComputerView, type ExecutionSettings, type ReviewSettings } from '../api'
import { Area, Block, Btn, Choice, NumberInput, Page, Pill, Row, SaveBar, Section, TextInput } from './kit'
import { tx } from '../i18n'

export function Execution() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['execution'], queryFn: () => api.get<{ settings: ExecutionSettings; defaults: ExecutionSettings }>('/settings/execution') })
  const [base, setDraft] = useState<ExecutionSettings | null>(null)
  const [blocked, setBlocked] = useState('')
  useEffect(() => { if (query.data) { setDraft(query.data.settings); setBlocked(query.data.settings.blockedCommands.join('\n')) } }, [query.data])
  const save = useMutation({ mutationFn: (s: ExecutionSettings) => api.put('/settings/execution', s), onSuccess: () => qc.invalidateQueries({ queryKey: ['execution'] }) })
  if (!base || !query.data) return <Page title={tx('安全和执行')}><div /></Page>
  const draft = { ...base, blockedCommands: blocked.split(/\s+/).filter(Boolean) }
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data.settings)
  const num = (k: 'maxWorkers' | 'foregroundSeconds' | 'timeoutMinutes') => ({ value: draft[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: Number(e.target.value) }) })
  const sandbox = (patch: Partial<ExecutionSettings['sandbox']>) => setDraft({ ...draft, sandbox: { ...draft.sandbox, ...patch } })
  return <Page title={tx('安全和执行')}>
    <Environment value={draft.environment ?? 'auto'} onChange={environment => setDraft({ ...draft, environment })} />
    <Section title={tx('任务')} foot={tx('每件事有自己的工作目录。它能碰哪些已有的文件夹，在右侧栏「权限」里管。')}>
      <Row label={tx('同时执行的任务数')} sub={tx('另外总给你的消息留 1 个名额')}><NumberInput min={1} max={16} {...num('maxWorkers')} aria-label={tx('同时执行的任务数')} /></Row>
      <Row label={tx('命令转到后台前等多久')} sub={tx('超过后命令在后台继续，任务先忙别的')}><NumberInput min={1} max={600} suffix={tx('秒')} className="w-[96px]" {...num('foregroundSeconds')} aria-label={tx('命令转到后台前等多久')} /></Row>
      <Row label={tx('单条命令最多跑多久')}><NumberInput min={1} suffix={tx('分钟')} className="w-[108px]" {...num('timeoutMinutes')} aria-label={tx('单条命令最多跑多久')} /></Row>
    </Section>
    <Section title={tx('Docker 沙箱')} foot={tx('在容器里跑任务的命令，容器只看得到任务自己的目录。')}>
      <Row label={tx('在沙箱里跑')}>
        <Choice label={tx('在沙箱里跑')} value={draft.sandbox.mode} onChange={mode => sandbox({ mode })} options={[{ id: 'off', label: tx('关闭') }, { id: 'external', label: tx('外部来的任务') }, { id: 'all', label: tx('所有任务') }]} />
      </Row>
      <Row label={tx('镜像')}><TextInput className="font-mono" value={draft.sandbox.image} onChange={e => sandbox({ image: e.target.value })} /></Row>
      <Row label={tx('网络')}><Choice label={tx('网络')} value={draft.sandbox.network} onChange={network => sandbox({ network })} options={[{ id: 'bridge', label: tx('允许联网') }, { id: 'none', label: tx('断网') }]} /></Row>
    </Section>
    <Section title={tx('禁止的命令')} foot={tx('按命令名拦下，防明显的误操作；这不是安全边界，真正的把关在右侧栏「权限」的规则里。')}>
      <Block>
        <div className="mb-2.5 text-sm">{tx('每行一个命令名')}</div>
        <Area className="font-mono" value={blocked} onChange={e => setBlocked(e.target.value)} />
      </Block>
    </Section>
    <SaveBar dirty={dirty} pending={save.isPending} error={save.error} onReset={() => { setDraft(query.data!.settings); setBlocked(query.data!.settings.blockedCommands.join('\n')) }} onSave={() => save.mutate(draft)} />
    <Patterns />
  </Page>
}

/** 执行环境: the choice, each cloud computer with its state, and 糯糯's browsers on it. */
function Environment({ value, onChange }: { value: 'auto' | 'local'; onChange(v: 'auto' | 'local'): void }) {
  const list = useQuery({ queryKey: ['computers'], queryFn: () => api.get<{ computers: ComputerView[] }>('/computers'), refetchInterval: 30_000 })
  if (!list.data) return null
  const computers = list.data.computers
  if (!computers.length) return <Section title={tx('执行环境')} foot={tx('云电脑是糯糯自己的一台云端 Linux 机器：上网、装软件、跑 docker，同时开好几个浏览器都在那边做。')}>
    <Row label={tx('命令在哪里跑')} sub={tx('还没有云电脑：装一个云电脑插件（比如 Instabox），糯糯就有自己的机器')}>
      <Choice label={tx('命令在哪里跑')} value="local" onChange={() => {}} options={[{ id: 'auto', label: tx('云电脑') }, { id: 'local', label: tx('本机') }]} className="pointer-events-none opacity-60" />
    </Row>
    <Row href="#/settings/plugins" icon={<Puzzle size={17} />} label={tx('装一个云电脑插件')} sub={<>{tx('在「插件 → 安装插件」里填')} <span className="font-mono">cyDione/nuonuo/tree/main/plugins/instabox</span></>} />
  </Section>
  return <Section title={tx('执行环境')} foot={tx('云电脑空闲时会自己休眠，用之前糯糯会先叫醒它。API key 和用哪台机器在「插件」里对应插件的设置里改。')}>
    <Row label={tx('命令在哪里跑')} sub={value === 'local' ? tx('任务的命令在你的电脑上跑；需要上网、docker 时还能用云电脑') : tx('任务的命令默认在云电脑上跑：能上网、用 docker，碰不到你的文件夹')}>
      <Choice label={tx('命令在哪里跑')} value={value} onChange={onChange} options={[{ id: 'auto', label: tx('云电脑') }, { id: 'local', label: tx('本机') }]} />
    </Row>
    {computers.map(c => <Computer key={c.id} computer={c} />)}
  </Section>
}

function Computer({ computer: c }: { computer: ComputerView }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const wake = useMutation({ mutationFn: () => api.post(`/computers/${encodeURIComponent(c.id)}/wake`, {}), onSettled: () => qc.invalidateQueries({ queryKey: ['computers'] }) })
  const ready = c.state === 'ready'
  const browsers = useQuery({ queryKey: ['computer-browsers', c.id], queryFn: () => api.get<{ browsers: ComputerBrowser[]; asleep?: boolean }>(`/computers/${encodeURIComponent(c.id)}/browsers`), enabled: ready, refetchInterval: open ? 15_000 : false })
  const close = useMutation({ mutationFn: (name: string) => api.post(`/computers/${encodeURIComponent(c.id)}/browsers/${encodeURIComponent(name)}/close`, {}), onSettled: () => qc.invalidateQueries({ queryKey: ['computer-browsers', c.id] }) })
  const minutes = c.retryAfterSeconds ? Math.max(1, Math.ceil(c.retryAfterSeconds / 60)) : 0
  const status = wake.isPending || c.state === 'waking' ? <Pill tone="warn">{tx('正在叫醒')}</Pill>
    : ready ? <Pill tone="ok">{tx('在线')}</Pill>
    : c.state === 'unconfigured' ? <><Pill tone="danger">{tx('还没设置好')}</Pill><a href="#/settings/plugins" className="inline-flex h-[28px] items-center rounded-[8px] border border-line bg-card px-3 text-[13px] font-medium hover:border-faint">{tx('去设置')}</a></>
    : minutes ? <Pill tone="warn">{tx('冷却中 · {0} 分钟后可用', minutes)}</Pill>
    : c.state === 'error' ? <><Pill tone="danger">{tx('连不上')}</Pill><Btn onClick={() => wake.mutate()}>{tx('重试')}</Btn></>
    : <><Pill>{c.state === 'off' ? tx('关机') : tx('休眠中')}</Pill><Btn onClick={() => wake.mutate()}>{tx('叫醒')}</Btn></>
  const sub = c.state === 'unconfigured' || c.state === 'error' ? (wake.error as Error | null)?.message ?? c.detail ?? tx('在插件设置里填上 API key')
    : [c.name, tx('糯糯的空间 {0}', c.workspace)].filter(Boolean).join(' · ')
  const list = browsers.data?.browsers ?? []
  const tabs = list.reduce((n, b) => n + b.tabs.length, 0)
  return <>
    <Row icon={<Cloud size={17} />} label={c.title} sub={<span className="line-clamp-1">{sub}</span>}>{status}</Row>
    {c.state !== 'unconfigured' && <>
      <button type="button" onClick={() => ready && setOpen(o => !o)} aria-expanded={ready ? open : undefined} disabled={!ready}
        className="flex min-h-[52px] w-full items-center gap-3 py-2.5 text-left disabled:cursor-default">
        <span className="flex size-5 shrink-0 items-center justify-center"><Globe size={17} /></span>
        <span className="min-w-0 flex-1"><span className="block text-sm">{tx('糯糯的浏览器')}</span><span className="mt-0.5 block text-xs text-muted">{tx('无头运行，不会出现在你的桌面上')}</span></span>
        <span className="shrink-0 text-[13px] text-muted">{!ready ? tx('机器醒着时才看得到') : browsers.isLoading ? '…' : list.length ? tx('{0} 个浏览器 · {1} 个标签页', list.length, tabs) : tx('没有开着的')}</span>
        {ready && (open ? <ChevronDown size={16} className="shrink-0 text-faint" /> : <ChevronRight size={16} className="shrink-0 text-faint" />)}
      </button>
      {open && ready && list.map(b => <Block key={b.name} className="pl-8">
        <div className="flex items-center gap-2">
          <Globe size={14} className="shrink-0 text-muted" />
          <span className="font-mono text-[13px]">{b.name}</span>
          <span className="text-xs text-faint">{tx('{0} 个标签页', b.tabs.length)}</span>
          <span className="flex-1" />
          <Btn onClick={() => close.mutate(b.name)} disabled={close.isPending && close.variables === b.name}>{tx('关闭')}</Btn>
        </div>
        {b.tabs.map(t => <div key={t.name} className="mt-1.5 flex min-w-0 items-baseline gap-2 pl-[22px] text-xs">
          <span className="shrink-0 font-mono text-faint">{t.name}</span>
          <span className="truncate">{t.title || t.url}</span>
          <span className="truncate font-mono text-faint">{t.url}</span>
        </div>)}
      </Block>)}
    </>}
  </>
}

const lines = (v: string) => v.split('\n').map(s => s.trim()).filter(Boolean)

/** 审核捷径: regexes that allow or block before the reviewer thinks about it. For technical users; closed by default. */
function Patterns() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['review'], queryFn: () => api.get<{ settings: ReviewSettings; defaults: ReviewSettings }>('/settings/review') })
  const saved = query.data?.settings
  const [draft, setDraft] = useState<{ allow: string; deny: string } | null>(null)
  const [open, setOpen] = useState<'allow' | 'deny' | null>(null)
  const text = (s: Pick<ReviewSettings, 'allow' | 'deny'>) => ({ allow: s.allow.join('\n'), deny: s.deny.join('\n') })
  useEffect(() => { if (saved) setDraft(text(saved)) }, [JSON.stringify(saved && text(saved))])
  const save = useMutation({ mutationFn: (s: ReviewSettings) => api.put('/settings/review', s), onSuccess: () => qc.invalidateQueries({ queryKey: ['review'] }) })
  if (!saved || !draft) return null
  const next = { ...saved, allow: lines(draft.allow), deny: lines(draft.deny) }
  const dirty = JSON.stringify(text(next)) !== JSON.stringify(text(saved))
  const regex = (key: 'allow' | 'deny', label: string) => <>
    <Row label={label} sub={tx('正则，每行一条')} onClick={() => setOpen(o => (o === key ? null : key))}><span className="text-[13px] text-muted">{tx('{0} 条', lines(draft[key]).length)}</span></Row>
    {open === key && <Block><Area className="font-mono" value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })}
      placeholder={key === 'allow' ? '^git push origin nuonuo/' : 'push .*\\b(main|master)\\b'} /></Block>}
  </>
  return <>
    <Section title={tx('审核捷径')} foot={tx('命令对上这些正则时不再交给审核模型。读取密码和密钥的命令一律禁止，不能改。')}>
      {regex('allow', tx('直接放行'))}
      {regex('deny', tx('直接拦截'))}
    </Section>
    <SaveBar dirty={dirty} pending={save.isPending} error={save.error} onReset={() => setDraft(text(saved))} onSave={() => save.mutate(next)} />
  </>
}
