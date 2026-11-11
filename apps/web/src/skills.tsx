/**
 * 会做的事 (Figma section 25, D2), in 它是谁: procedures the owner taught it. A switch turns each on or off; ones the
 * assistant wrote down from a chat wait switched off until the owner turns them on. 全部 opens the list to read, add,
 * change or delete them.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkle, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api, type Skill } from './api'
import { cx } from './ui'
import { tx } from './i18n'

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
    className={cx('press relative h-6 w-10 shrink-0 rounded-full transition-colors duration-150', on ? 'bg-ink' : 'bg-hero-2', disabled && 'opacity-50')}>
    <span className={cx('absolute top-0.5 left-0.5 size-5 rounded-full bg-panel shadow-sm transition-transform duration-200 ease-[var(--ease-out-strong)]', on && 'translate-x-4')} />
  </button>
}

const EMPTY = { name: '', when: '', steps: '' }

export function SkillsSection({ Head, LinkBtn }: { Head: React.ComponentType<{ title: string; count?: number | string | undefined; action?: React.ReactNode }>; LinkBtn: React.ComponentType<{ onClick(): void; children: React.ReactNode }> }) {
  const qc = useQueryClient()
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api.get<{ skills: Skill[] }>('/skills') }).data?.skills ?? []
  const done = () => qc.invalidateQueries({ queryKey: ['skills'] })
  const patch = useMutation({ mutationFn: (v: { id: string } & Partial<Skill>) => api.patch(`/skills/${v.id}`, { ...v, id: undefined }), onSettled: done,
    onMutate: v => qc.setQueryData<{ skills: Skill[] }>(['skills'], old => old && { skills: old.skills.map(s => s.id === v.id ? { ...s, ...v } : s) }) })
  const create = useMutation({ mutationFn: (v: typeof EMPTY) => api.post('/skills', v), onSuccess: () => { setForm(null); done() } })
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/skills/${id}`), onSuccess: done })
  const [all, setAll] = useState(false)
  const [form, setForm] = useState<(typeof EMPTY & { id?: string }) | null>(null)
  const shown = all ? skills : skills.slice(0, 3)
  const save = () => {
    if (!form) return
    if (form.id) patch.mutate({ id: form.id, name: form.name, when: form.when, steps: form.steps }, { onSuccess: () => setForm(null) })
    else create.mutate({ name: form.name, when: form.when, steps: form.steps })
  }
  const field = 'w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-faint'
  return <section className="border-t border-line pt-5">
    <Head title={tx('会做的事')} count={skills.length || undefined} action={<LinkBtn onClick={() => setAll(v => !v)}>{all ? tx('收起') : skills.length ? tx('全部') : tx('教它一件')}</LinkBtn>} />
    <div className="space-y-1">{shown.map(s => <div key={s.id} className="flex min-h-12 items-center gap-3">
      <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken', s.enabled ? 'text-fg' : 'text-faint')}><Sparkle size={15} /></span>
      <button onClick={() => all && setForm({ id: s.id, name: s.name, when: s.when, steps: s.steps })} className={cx('min-w-0 flex-1 text-left', !all && 'cursor-default')}>
        <span className={cx('block truncate text-sm font-medium', !s.enabled && 'text-faint')}>{s.name}</span>
        <span className="block truncate text-[11px] text-faint">{s.when}{!s.enabled && s.by === 'assistant' ? tx(' · 它记下的，等你打开') : !s.enabled ? tx(' · 停用了') : ''}</span>
      </button>
      {all && <button onClick={() => { if (confirm(tx('删掉「{0}」？', s.name))) remove.mutate(s.id) }} aria-label={tx('删掉 {0}', s.name)} className="press flex size-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-sunken hover:text-fg"><Trash2 size={13} /></button>}
      <Switch on={s.enabled} label={s.name} onChange={enabled => patch.mutate({ id: s.id, enabled })} />
    </div>)}</div>
    {all && !form && <button onClick={() => setForm({ ...EMPTY })} className="press mt-2 h-8 rounded-full border border-line px-3 text-[13px] hover:border-faint">{tx('教它一件新的')}</button>}
    {form && <form className="anim-rise mt-3 space-y-2" onSubmit={e => { e.preventDefault(); save() }}>
      <input autoFocus value={form.name} maxLength={20} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={tx('名字，比如 写周报')} aria-label={tx('名字')} className={field} />
      <input value={form.when} maxLength={120} onChange={e => setForm({ ...form, when: e.target.value })} placeholder={tx('什么时候用，比如 我说写周报的时候')} aria-label={tx('什么时候用')} className={field} />
      <textarea value={form.steps} onChange={e => setForm({ ...form, steps: e.target.value })} placeholder={tx('怎么做，一行一步\n- 先看这周的日历\n- 再按 本周 / 下周 / 风险 写')} aria-label={tx('怎么做')} className={cx(field, 'min-h-28 leading-6')} />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={() => setForm(null)} className="press h-8 rounded-full px-3 text-[13px] text-muted hover:bg-sunken">{tx('取消')}</button>
        <button type="submit" disabled={!form.name.trim() || !form.when.trim() || !form.steps.trim() || create.isPending || patch.isPending} className="press h-8 rounded-full bg-ink px-3.5 text-[13px] font-medium text-ink-fg disabled:opacity-50">{tx('保存')}</button>
      </div>
    </form>}
    <p className="mt-2.5 text-[11px] text-faint">{tx('聊天里说「以后这种事都这么做」，它就记成一件会做的事。')}</p>
  </section>
}
