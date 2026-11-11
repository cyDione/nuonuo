/** 执行环境 (Figma 21 · 07): how many things run at once, command timeouts, the Docker sandbox, and blocked commands. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type ExecutionSettings } from '../api'
import { Area, Block, Choice, NumberInput, Page, Row, SaveBar, Section, TextInput } from './kit'

export function Execution() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['execution'], queryFn: () => api.get<{ settings: ExecutionSettings; defaults: ExecutionSettings }>('/settings/execution') })
  const [base, setDraft] = useState<ExecutionSettings | null>(null)
  const [blocked, setBlocked] = useState('')
  useEffect(() => { if (query.data) { setDraft(query.data.settings); setBlocked(query.data.settings.blockedCommands.join('\n')) } }, [query.data])
  const save = useMutation({ mutationFn: (s: ExecutionSettings) => api.put('/settings/execution', s), onSuccess: () => qc.invalidateQueries({ queryKey: ['execution'] }) })
  if (!base || !query.data) return <Page title="执行环境"><div /></Page>
  const draft = { ...base, blockedCommands: blocked.split(/\s+/).filter(Boolean) }
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data.settings)
  const num = (k: 'maxWorkers' | 'foregroundSeconds' | 'timeoutMinutes') => ({ value: draft[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: Number(e.target.value) }) })
  const sandbox = (patch: Partial<ExecutionSettings['sandbox']>) => setDraft({ ...draft, sandbox: { ...draft.sandbox, ...patch } })
  return <Page title="执行环境">
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
    <Section title="禁止的命令" foot="按命令名拦下，防明显的误操作；这不是安全边界，真正的把关在「规则与审核」。">
      <Block>
        <div className="mb-2.5 text-sm">每行一个命令名</div>
        <Area className="font-mono" value={blocked} onChange={e => setBlocked(e.target.value)} />
      </Block>
    </Section>
    <SaveBar dirty={dirty} pending={save.isPending} error={save.error} onReset={() => { setDraft(query.data!.settings); setBlocked(query.data!.settings.blockedCommands.join('\n')) }} onSave={() => save.mutate(draft)} />
  </Page>
}
