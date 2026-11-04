import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type MemoryState } from '../api'
import { Button, Card } from '../ui'

export function MemoryPage() {
  const memory = useQuery({ queryKey: ['memory'], queryFn: () => api.get<MemoryState>('/memory') })
  if (!memory.data) return null
  return <div className="space-y-3">
    <Editor title="关于你" hint="智能体记住的你的事实与偏好，每次对话都会带上。" layer="user" content={memory.data.user} />
    <Editor title="智能体的经验" hint="做事过程中验证过、以后用得上的经验。" layer="agent" content={memory.data.agent} />
    {memory.data.projects.map(p => <Editor key={p.name} title={`项目：${p.name}`} hint="属于这个项目的任务会带上它。" layer="project" project={p.name} content={p.content} />)}
    {!memory.data.projects.length && <p className="px-1 text-xs text-faint">还没有项目记忆。GitHub 任务按仓库自动归入项目；也可以对智能体说「记住，在 X 项目里……」。</p>}
  </div>
}

function Editor({ title, hint, layer, project, content }: { title: string; hint: string; layer: 'user' | 'agent' | 'project'; project?: string; content: string }) {
  const qc = useQueryClient()
  const [text, setText] = useState(content)
  useEffect(() => setText(content), [content])
  const save = useMutation({ mutationFn: () => api.put('/memory', { layer, ...(project ? { project } : {}), content: text }), onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }) })
  return <Card className="p-4">
    <div className="text-sm font-medium">{title}</div>
    <div className="mt-0.5 text-xs text-muted">{hint}</div>
    <textarea className="mt-3 min-h-40 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-accent"
      value={text} placeholder="（空）" onChange={e => setText(e.target.value)} />
    {text !== content && <div className="mt-2 flex justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={() => setText(content)}>还原</Button>
      <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>保存</Button>
    </div>}
  </Card>
}
