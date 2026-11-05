/** Who the assistant is (Muse): the name, face and personality the owner gives it. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Persona } from '../api'
import { Avatar, isMascot, Mascot, MASCOT } from '../persona'
import { Button, Card, cx, Field, Input } from '../ui'

const AVATARS = ['🦊', '🐱', '🐼', '🦉', '🐙', '🌱', '🌙', '☀️', '🍀', '🎧', '🧭', '🪐', '🐳', '🦄', '🤖']
const COLORS = ['#e9845a', '#5db49c', '#f2be45', '#ef7a8f', '#d0583a', '#8a7a6a', '#3f8f9c', '#5c5c5c']
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
    <Card className="flex items-center gap-6 p-6 max-sm:flex-col max-sm:items-start">
      <span className="relative flex size-36 shrink-0 items-center justify-center overflow-hidden rounded-[28px] bg-hero"><span className="glow-corner pointer-events-none absolute -right-10 -bottom-12 size-40 rounded-full" aria-hidden /><Avatar persona={form} size={104} mood="happy" track className="relative text-fg" /></span>
      <div className="min-w-0 flex-1 space-y-3">
        <Field label="名字"><div className="w-56"><Input value={form.name} maxLength={24} onChange={e => setForm({ ...form, name: e.target.value })} /></div></Field>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted">头像</span>
          <div className="flex flex-wrap gap-1">
            <button onClick={() => setForm({ ...form, avatar: MASCOT })} aria-label="角色" title="默认角色" className={cx('press flex size-9 items-center justify-center rounded-xl', isMascot(form) ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-sunken')}><Mascot color={form.color} size={26} /></button>
            {AVATARS.map(a => <button key={a} onClick={() => setForm({ ...form, avatar: a })} className={cx('press size-9 rounded-xl text-lg', form.avatar === a ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-sunken')}>{a}</button>)}
            <div className="w-20"><Input value={isMascot(form) ? '' : form.avatar} maxLength={4} onChange={e => setForm({ ...form, avatar: e.target.value })} placeholder="自定义" className="h-9 text-center" /></div>
          </div>
        </div>
        <div className="flex gap-1.5">{COLORS.map(c => <button key={c} onClick={() => setForm({ ...form, color: c })} aria-label={c}
          className={cx('press size-7 rounded-full', form.color === c && 'ring-2 ring-offset-2 ring-offset-panel')} style={{ background: c, ['--tw-ring-color' as string]: c }} />)}</div>
      </div>
    </Card>
    <Card className="space-y-2 p-5">
      <Field label="性格" hint="它说话的样子。每条消息都会按这个来；怎么做事、交付什么，写在「说明」里。">
        <textarea className="min-h-28 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm leading-6 outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-4 focus:ring-accent/15 focus-visible:outline-none"
          value={form.personality} onChange={e => setForm({ ...form, personality: e.target.value })} placeholder="比如：说话直接、简短，像一个靠谱的同事" />
      </Field>
      <div className="flex flex-wrap gap-1.5">{EXAMPLES.map(x => <button key={x} onClick={() => setForm({ ...form, personality: x })} className="press rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-fg/30 hover:text-fg">{x}</button>)}</div>
    </Card>
    <div className="flex justify-end gap-2">
      {dirty && <Button size="sm" variant="ghost" onClick={() => setForm(data.persona)}>还原</Button>}
      <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(form)}>保存</Button>
    </div>
  </div>
}
