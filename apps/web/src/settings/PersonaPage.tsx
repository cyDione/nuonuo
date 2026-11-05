/** Who the assistant is (Muse): the name, face and personality the owner gives it. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Persona } from '../api'
import { Avatar } from '../persona'
import { Button, Card, cx, Field, Input } from '../ui'

const AVATARS = ['✨', '🦊', '🐱', '🐼', '🦉', '🐙', '🌱', '🌙', '☀️', '🍀', '🎧', '🧭', '🪐', '🐳', '🦄', '🤖']
const COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b']
const EXAMPLES = ['说话直接、简短，像一个靠谱的同事；先说结论。', '温和耐心，会适当关心我的状态；不说套话。', '有点幽默，偶尔开个玩笑，但正事从不含糊。']

export function PersonaPage() {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona') }).data
  const [form, setForm] = useState<Persona | null>(null)
  useEffect(() => { if (data) setForm(data.persona) }, [data])
  const save = useMutation({ mutationFn: (p: Persona) => api.put('/persona', p), onSuccess: () => qc.invalidateQueries({ queryKey: ['persona'] }) })
  if (!data || !form) return null
  const dirty = JSON.stringify(form) !== JSON.stringify(data.persona)
  return <div className="space-y-3">
    <Card className="flex items-center gap-4 p-5">
      <Avatar persona={form} size={64} />
      <div className="min-w-0 flex-1 space-y-3">
        <Field label="名字"><div className="w-56"><Input value={form.name} maxLength={24} onChange={e => setForm({ ...form, name: e.target.value })} /></div></Field>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted">头像</span>
          <div className="flex flex-wrap gap-1">
            {AVATARS.map(a => <button key={a} onClick={() => setForm({ ...form, avatar: a })} className={cx('size-9 rounded-lg text-lg', form.avatar === a ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-sunken')}>{a}</button>)}
            <div className="w-20"><Input value={form.avatar} maxLength={4} onChange={e => setForm({ ...form, avatar: e.target.value })} placeholder="自定义" className="h-9 text-center" /></div>
          </div>
        </div>
        <div className="flex gap-1.5">{COLORS.map(c => <button key={c} onClick={() => setForm({ ...form, color: c })} aria-label={c}
          className={cx('size-6 rounded-full', form.color === c && 'ring-2 ring-offset-2 ring-offset-panel')} style={{ background: c, ['--tw-ring-color' as string]: c }} />)}</div>
      </div>
    </Card>
    <Card className="space-y-2 p-5">
      <Field label="性格" hint="它说话的样子。每条消息都会按这个来；怎么做事、交付什么，写在「说明」里。">
        <textarea className="min-h-28 w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm leading-6 outline-none focus:border-accent"
          value={form.personality} onChange={e => setForm({ ...form, personality: e.target.value })} placeholder="比如：说话直接、简短，像一个靠谱的同事" />
      </Field>
      <div className="flex flex-wrap gap-1.5">{EXAMPLES.map(x => <button key={x} onClick={() => setForm({ ...form, personality: x })} className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-fg">{x}</button>)}</div>
    </Card>
    <div className="flex justify-end gap-2">
      {dirty && <Button size="sm" variant="ghost" onClick={() => setForm(data.persona)}>还原</Button>}
      <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(form)}>保存</Button>
    </div>
  </div>
}
