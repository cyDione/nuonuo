import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type InstructionsState, type SectionId } from '../api'
import { Button, Card } from '../ui'

const HINT: Record<SectionId, string> = {
  communication: '例如：回复简短，别用客套话；结论先说；英文资料给我中文要点。',
  scope: '例如：我的仓库里可以直接开分支提 PR，但不要合并；不要替我发邮件。',
  delivery: '例如：写代码要附上怎么运行和测试结果；调研要列出处链接。',
}
const BY: Record<string, string> = { owner: '你', router: '智能体（按你的要求）', watchdog: 'Watchdog', system: '系统' }

export function InstructionsPage() {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['instructions'], queryFn: () => api.get<InstructionsState>('/instructions') }).data
  const [draft, setDraft] = useState<Record<SectionId, string> | null>(null)
  const [history, setHistory] = useState(false)
  useEffect(() => { if (data) setDraft(data.current.sections) }, [data?.current.version])
  const save = useMutation({ mutationFn: () => api.put('/instructions', draft), onSuccess: () => qc.invalidateQueries({ queryKey: ['instructions'] }) })
  const restore = useMutation({ mutationFn: (version: number) => api.post('/instructions/restore', { version }), onSuccess: () => qc.invalidateQueries({ queryKey: ['instructions'] }) })
  if (!data || !draft) return null
  const dirty = data.sections.some(s => draft[s.id] !== data.current.sections[s.id])
  return <div className="space-y-3">
    {data.sections.map(s => <Card key={s.id} className="p-4">
      <div className="text-sm font-medium">{s.label}</div>
      <textarea className="mt-2 min-h-24 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm leading-6 outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15 focus-visible:outline-none"
        value={draft[s.id]} placeholder={HINT[s.id]} onChange={e => setDraft({ ...draft, [s.id]: e.target.value })} />
    </Card>)}
    <div className="flex items-center gap-2">
      <span className="text-xs text-faint">{data.current.version ? `第 ${data.current.version} 版 · ${BY[data.current.by] ?? data.current.by} · ${new Date(data.current.at).toLocaleString()}` : '还没有写过说明'}</span>
      {data.history.length > 0 && <Button size="sm" variant="ghost" onClick={() => setHistory(v => !v)}><History size={13} />历史版本</Button>}
      <span className="flex-1" />
      {dirty && <Button size="sm" variant="ghost" onClick={() => setDraft(data.current.sections)}>还原</Button>}
      <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>保存为新版本</Button>
    </div>
    {history && <Card className="divide-y divide-line">
      {data.history.map(v => <div key={v.version} className="flex items-start gap-3 px-4 py-2.5 text-sm">
        <div className="min-w-0 flex-1">
          <div>第 {v.version} 版 <span className="text-xs text-faint">· {BY[v.by] ?? v.by} · {new Date(v.at).toLocaleString()}</span></div>
          {v.note && <div className="text-xs text-muted">{v.note}</div>}
          <div className="mt-1 line-clamp-2 text-xs text-faint">{data.sections.map(s => v.sections[s.id] && `${s.label}：${v.sections[s.id]}`).filter(Boolean).join(' ｜ ') || '（空）'}</div>
        </div>
        {v.version !== data.current.version && <Button size="sm" onClick={() => restore.mutate(v.version)} disabled={restore.isPending}>恢复</Button>}
      </div>)}
    </Card>}
  </div>
}
