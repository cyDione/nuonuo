/**
 * 安全和执行 (Figma v7, 23 · I; was 规则与审核 + 执行环境): how many things run at once, command timeouts, the Docker sandbox,
 * blocked commands, and the regex shortcuts the reviewer applies before thinking. The rules in your own words and who decides
 * live in the right pane's 权限; the record of every decision in 数据和隐私 · 原始记录.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type ExecutionSettings, type ReviewSettings } from '../api'
import { Area, Block, Choice, NumberInput, Page, Row, SaveBar, Section, TextInput } from './kit'
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
