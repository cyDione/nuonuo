/**
 * 「它」: who the assistant is (Figma "v4 · 桌面端" → 它). A stage with its face (it watches the pointer), its name and a few
 * words about its character; then three cards — 个性, 灵魂 (the standing instructions) and 记忆 — in slowly drifting
 * gradients that lean toward the pointer. The open card's page sits underneath.
 */
import { useQuery } from '@tanstack/react-query'
import { Brain, Heart, Pencil, Sparkles, type LucideIcon } from 'lucide-react'
import { api, type InstructionsState } from './api'
import { Avatar, usePersona } from './persona'
import type { MeTab } from './route'
import { InstructionsPage } from './settings/Instructions'
import { MemoryPage } from './settings/MemoryPage'
import { PersonaPage } from './settings/PersonaPage'
import { useTilt } from './shell'
import { cx } from './ui'

interface Memories { memories: { status: 'active' | 'pending'; kind: string }[]; kinds: { id: string; label: string }[] }

const day = (at?: number) => { if (!at) return ''; const d = new Date(at); return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}` }
/** A few words from the personality, for the little tags under the name. */
const traits = (text: string) => text.split(/[，,；;、。.!！\n]/).map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 10).slice(0, 4)
const TILTS = [-2.5, 2, -1.5, 2.5]

export function MePage({ tab }: { tab: MeTab }) {
  const persona = usePersona()
  const memories = useQuery({ queryKey: ['memories'], queryFn: () => api.get<Memories>('/memories') }).data
  const instructions = useQuery({ queryKey: ['instructions'], queryFn: () => api.get<InstructionsState>('/instructions') }).data
  const active = memories?.memories.filter(m => m.status === 'active') ?? []
  const pending = memories?.memories.filter(m => m.status === 'pending').length ?? 0
  const rules = instructions ? instructions.sections.map(s => instructions.current.sections[s.id]).flatMap(t => t.split('\n')).map(t => t.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean) : []
  const tags = traits(persona.personality)
  const stage = useTilt<HTMLDivElement>(1.5)

  return <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-4xl space-y-5 px-4 pt-2 pb-10 md:px-8">
      <div ref={stage} className="flow tilt anim-rise flex items-center gap-7 rounded-[28px] px-8 py-8 max-sm:flex-col max-sm:items-start max-sm:gap-4 max-sm:px-5">
        <span className="relative shrink-0"><Avatar persona={persona} size={132} mood="happy" track /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate font-display text-[34px] leading-tight font-semibold">{persona.name}</h1>
            <a href="#/me/persona" aria-label="编辑名字和样子" title="编辑" className="press flex size-8 items-center justify-center rounded-full bg-card/70 text-fg/70 hover:bg-card hover:text-fg"><Pencil size={14} /></a>
          </div>
          <p className="mt-1.5 text-sm tabular-nums opacity-70">
            记得 {active.length} 件事{instructions?.current.version ? ` · 说明第 ${instructions.current.version} 版` : ''}{pending ? ` · ${pending} 条等你确认` : ''}
          </p>
          {tags.length > 0 && <div className="mt-4 flex flex-wrap gap-2">
            {tags.map((t, i) => <span key={t} className="tag rounded-xl bg-card/80 px-3 py-1.5 text-[13px] font-medium text-fg shadow-[var(--shadow-sheet)] backdrop-blur" style={{ ['--r' as string]: `${TILTS[i]}deg`, ['--i' as string]: i }}>{t}</span>)}
          </div>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MeCard tab="persona" active={tab === 'persona'} icon={Heart} title="个性" tone="a" date={day(Date.now())}>
          <p className="line-clamp-3">{persona.personality || '还没写它的性格。点开告诉它该怎么说话。'}</p>
        </MeCard>
        <MeCard tab="soul" active={tab === 'soul'} icon={Sparkles} title="灵魂" tone="b" date={instructions?.current.version ? `第 ${instructions.current.version} 版 · ${day(instructions.current.at)}` : '还没写'}>
          {rules.length ? <ol className="list-decimal space-y-0.5 pl-4">{rules.slice(0, 3).map((r, i) => <li key={i} className="truncate">{r}</li>)}</ol> : <p>做事的规矩：怎么沟通、能做什么、交付什么。</p>}
        </MeCard>
        <MeCard tab="memory" active={tab === 'memory'} icon={Brain} title="记忆" tone="c" date={`${active.length} 条`} badge={pending ? `${pending} 条等你确认` : undefined}>
          <p className="leading-6">{memories?.kinds.map(k => `${k.label} ${active.filter(m => m.kind === k.id).length}`).join(' · ') || '它记住的关于你的事'}</p>
        </MeCard>
      </div>

      <div>
        {tab === 'persona' ? <PersonaPage /> : tab === 'soul' ? <InstructionsPage /> : <MemoryPage />}
      </div>
    </div>
  </div>
}

function MeCard({ tab, active, icon: Icon, title, tone, date, badge, children }: { tab: MeTab; active: boolean; icon: LucideIcon; title: string; tone: 'a' | 'b' | 'c'; date: string; badge?: string | undefined; children: React.ReactNode }) {
  const ref = useTilt<HTMLAnchorElement>(4)
  return <a ref={ref} href={`#/me/${tab}`} data-tone={tone} aria-current={active ? 'page' : undefined}
    className={cx('flow tilt anim-rise group flex min-h-40 flex-col rounded-[22px] p-4 text-[13px] transition-[box-shadow,outline-color] outline-2 -outline-offset-2',
      active ? 'outline-accent/60' : 'outline-transparent')}>
    <span className="flex items-center gap-2">
      <Icon size={16} className="opacity-80" />
      <span className="font-display text-lg font-semibold">{title}</span>
      {badge && <span className="ml-auto rounded-full bg-sun px-2 text-[11px] leading-5 font-semibold text-[#121212]">{badge}</span>}
    </span>
    <span className="mt-2.5 flex-1 opacity-80">{children}</span>
    <span className="mt-3 font-mono text-[11px] tabular-nums opacity-55">{date}</span>
    <Icon size={88} strokeWidth={1.2} className="pointer-events-none absolute -right-3 -bottom-4 opacity-[0.09] transition-transform duration-500 ease-out group-hover:-rotate-6 group-hover:scale-105" aria-hidden />
  </a>
}
