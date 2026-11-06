import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type ExecutionSettings } from '../api'
import { Button, Card, Field, Input } from '../ui'

export function Execution() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['execution'], queryFn: () => api.get<{ settings: ExecutionSettings; defaults: ExecutionSettings }>('/settings/execution') })
  const [draft, setDraft] = useState<ExecutionSettings | null>(null)
  useEffect(() => { if (query.data) setDraft(query.data.settings) }, [query.data])
  const save = useMutation({ mutationFn: (s: ExecutionSettings) => api.put('/settings/execution', s), onSuccess: () => qc.invalidateQueries({ queryKey: ['execution'] }) })
  if (!draft || !query.data) return null
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data.settings)
  const num = (k: keyof ExecutionSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: Number(e.target.value) })
  const lines = (v: string) => v.split('\n').map(s => s.trim()).filter(Boolean)
  return <Card className="space-y-4 p-5">
    <div className="grid gap-4 sm:grid-cols-3">
      <Field label="同时执行的任务数" hint="另外始终为你的消息保留 1 个名额"><Input type="number" min={1} max={16} value={draft.maxWorkers} onChange={num('maxWorkers')} /></Field>
      <Field label="命令转后台前等待（秒）" hint="超过后命令在后台继续，任务可以先处理别的"><Input type="number" min={1} max={600} value={draft.foregroundSeconds} onChange={num('foregroundSeconds')} /></Field>
      <Field label="单条命令上限（分钟）"><Input type="number" min={1} value={draft.timeoutMinutes} onChange={num('timeoutMinutes')} /></Field>
    </div>
    <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
      <Field label="Docker 沙箱" hint="在容器里执行任务的命令，容器只能看到任务目录">
        <select className="h-10 w-full rounded-xl border border-line bg-panel px-2.5 text-sm" value={draft.sandbox.mode}
          onChange={e => setDraft({ ...draft, sandbox: { ...draft.sandbox, mode: e.target.value as typeof draft.sandbox.mode } })}>
          <option value="off">关闭</option><option value="external">外部来源的任务（如 GitHub）</option><option value="all">所有任务</option>
        </select>
      </Field>
      <Field label="镜像"><Input className="font-mono text-xs" value={draft.sandbox.image} onChange={e => setDraft({ ...draft, sandbox: { ...draft.sandbox, image: e.target.value } })} /></Field>
      <Field label="网络">
        <select className="h-10 w-full rounded-xl border border-line bg-panel px-2.5 text-sm" value={draft.sandbox.network}
          onChange={e => setDraft({ ...draft, sandbox: { ...draft.sandbox, network: e.target.value as typeof draft.sandbox.network } })}>
          <option value="bridge">允许联网</option><option value="none">断网</option>
        </select>
      </Field>
    </div>
    <Field label="禁止的命令" hint="以空格分隔；按命令名拦截。这不是安全边界，只是防止明显的误操作。">
      <Input value={draft.blockedCommands.join(' ')} onChange={e => setDraft({ ...draft, blockedCommands: e.target.value.split(/\s+/).filter(Boolean) })} />
    </Field>
    {(dirty || save.error) && <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
      {save.error && <span className="mr-auto text-xs text-danger">{(save.error as Error).message}</span>}
      <Button size="sm" variant="ghost" onClick={() => setDraft(query.data!.settings)}>还原</Button>
      <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate(draft)}>保存</Button>
    </div>}
  </Card>
}
