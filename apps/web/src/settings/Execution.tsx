/**
 * 安全和执行 (Figma v7, 23 · I; was 规则与审核 + 执行环境): how many things run at once, command timeouts, the Docker sandbox,
 * blocked commands, and the regex shortcuts the reviewer applies before thinking. The rules in your own words and who decides
 * live in the right pane's 权限; the record of every decision in 数据和隐私 · 原始记录.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type ExecutionSettings, type ReviewSettings } from '../api'
import { Area, Block, Choice, NumberInput, Page, Row, SaveBar, Section, TextInput } from './kit'

export function Execution() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['execution'], queryFn: () => api.get<{ settings: ExecutionSettings; defaults: ExecutionSettings }>('/settings/execution') })
  const [base, setDraft] = useState<ExecutionSettings | null>(null)
  const [blocked, setBlocked] = useState('')
  useEffect(() => { if (query.data) { setDraft(query.data.settings); setBlocked(query.data.settings.blockedCommands.join('\n')) } }, [query.data])
  const save = useMutation({ mutationFn: (s: ExecutionSettings) => api.put('/settings/execution', s), onSuccess: () => qc.invalidateQueries({ queryKey: ['execution'] }) })
  if (!base || !query.data) return <Page title="安全和执行"><div /></Page>
  const draft = { ...base, blockedCommands: blocked.split(/\s+/).filter(Boolean) }
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data.settings)
  const num = (k: 'maxWorkers' | 'foregroundSeconds' | 'timeoutMinutes') => ({ value: draft[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: Number(e.target.value) }) })
  const sandbox = (patch: Partial<ExecutionSettings['sandbox']>) => setDraft({ ...draft, sandbox: { ...draft.sandbox, ...patch } })
  return <Page title="安全和执行">
    <Section title="任务" foot="每件事有自己的工作目录。它能碰哪些已有的文件夹，在右侧栏「权限」里管。">
      <Row label="同时执行的任务数" sub="另外总给你的消息留 1 个名额"><NumberInput min={1} max={16} {...num('maxWorkers')} aria-label="同时执行的任务数" /></Row>
      <Row label="命令转到后台前等多久" sub="超过后命令在后台继续，任务先忙别的"><NumberInput min={1} max={600} suffix="秒" className="w-[96px]" {...num('foregroundSeconds')} aria-label="命令转到后台前等多久" /></Row>
      <Row label="单条命令最多跑多久"><NumberInput min={1} suffix="分钟" className="w-[108px]" {...num('timeoutMinutes')} aria-label="单条命令最多跑多久" /></Row>
    </Section>
    <Section title="Docker 沙箱" foot="在容器里跑任务的命令，容器只看得到任务自己的目录。">
      <Row label="在沙箱里跑">
        <Choice label="在沙箱里跑" value={draft.sandbox.mode} onChange={mode => sandbox({ mode })} options={[{ id: 'off', label: '关闭' }, { id: 'external', label: '外部来的任务' }, { id: 'all', label: '所有任务' }]} />
      </Row>
      <Row label="镜像"><TextInput className="font-mono" value={draft.sandbox.image} onChange={e => sandbox({ image: e.target.value })} /></Row>
      <Row label="网络"><Choice label="网络" value={draft.sandbox.network} onChange={network => sandbox({ network })} options={[{ id: 'bridge', label: '允许联网' }, { id: 'none', label: '断网' }]} /></Row>
    </Section>
    <Section title="禁止的命令" foot="按命令名拦下，防明显的误操作；这不是安全边界，真正的把关在右侧栏「权限」的规则里。">
      <Block>
        <div className="mb-2.5 text-sm">每行一个命令名</div>
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
    <Row label={label} sub="正则，每行一条" onClick={() => setOpen(o => (o === key ? null : key))}><span className="text-[13px] text-muted">{lines(draft[key]).length} 条</span></Row>
    {open === key && <Block><Area className="font-mono" value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })}
      placeholder={key === 'allow' ? '^git push origin super-assistant/' : 'push .*\\b(main|master)\\b'} /></Block>}
  </>
  return <>
    <Section title="审核捷径" foot="命令对上这些正则时不再交给审核模型。读取密码和密钥的命令一律禁止，不能改。">
      {regex('allow', '直接放行')}
      {regex('deny', '直接拦截')}
    </Section>
    <SaveBar dirty={dirty} pending={save.isPending} error={save.error} onReset={() => setDraft(text(saved))} onSave={() => save.mutate(next)} />
  </>
}
