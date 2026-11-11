/**
 * The right pane (Figma v6, 81:1128 / 92:1057 / section 20): opened from 糯糯 in the sidebar. Its face and status line on
 * top, then an icon-only switch (Figma v7, section 23): 活动 (what waits for you, what it is doing, what comes next, what
 * it has done — the full history opens in place), 它是谁 (名字 · 角色 · 样子 · 性格 · 灵魂 · 记忆) and 权限 (what it may do
 * on its own, where, and the rules). These live only here, never in settings. 目标 lives only on its page (更多 → 目标).
 * On narrower windows the same pane opens as a drawer, and on phones as a sheet from the bottom.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, ChevronDown, CreditCard, Folder, Globe, Lock, Plus, Send, Shield, ShieldCheck, Smile, Trash2, X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type AuditEntry, type ExecutionSettings, type InstructionsState, type Level, type Persona, type ReviewSettings, type Routine, type Ticket } from './api'
import { openActivity, openTask, useActivityOpen, useLive } from './live'
import { Avatar, isMascot, Mascot, MASCOT, statusLine, usePersona } from './persona'
import { go } from './route'
import { InstructionsPage } from './settings/Instructions'
import { MemoryPage } from './settings/MemoryPage'
import { needsOwner, useTickets } from './tasks'
import { cx, IconButton, Modal, Seg } from './ui'
import { usePresence } from './shell'

export type PaneTab = 'activity' | 'who' | 'permissions'
let tab: PaneTab = 'activity'
const tabListeners = new Set<() => void>()
export function setPaneTab(next: PaneTab) { tab = next; for (const l of tabListeners) l() }
const usePaneTab = () => useSyncExternalStore(l => { tabListeners.add(l); return () => tabListeners.delete(l) }, () => tab)

const TABS: { id: PaneTab; label: React.ReactNode }[] = [
  { id: 'activity', label: <span className="flex items-center" title="活动"><Activity size={17} aria-label="活动" /></span> },
  { id: 'who', label: <span className="flex items-center" title="它是谁"><Smile size={17} aria-label="它是谁" /></span> },
  { id: 'permissions', label: <span className="flex items-center" title="权限"><Shield size={17} aria-label="权限" /></span> },
]

const hm = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function when(at: number) {
  const d = new Date(at), now = new Date()
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000)
  return `${days === 0 ? '今天' : days === 1 ? '明天' : days < 7 ? WEEK[d.getDay()] : `${d.getMonth() + 1}/${d.getDate()}`} ${hm(at)}`
}

function ago(at: number) {
  const days = Math.round((new Date(new Date().toDateString()).getTime() - new Date(new Date(at).toDateString()).getTime()) / 86_400_000)
  return `${days === 0 ? '今天' : days === 1 ? '昨天' : `${new Date(at).getMonth() + 1}/${new Date(at).getDate()}`} ${hm(at)}`
}

export function RightPane({ onClose }: { onClose(): void }) {
  const persona = usePersona()
  const connected = useLive(s => s.connected)
  const live = (useTickets().data?.tickets ?? []).filter(t => t.stage !== 'ended')
  const status = statusLine(live)
  const current = usePaneTab()
  const mood = !connected ? 'sleepy' : status.tone === 'working' ? 'thinking' : status.tone
  return <div className="flex h-full flex-col">
    <div className="flex h-12 shrink-0 items-center justify-end px-3"><IconButton label="关闭" onClick={onClose}><X size={17} /></IconButton></div>
    <div className="flex items-center gap-3.5 px-6">
      <Avatar persona={persona} size={56} mood={mood} track />
      <div className="min-w-0">
        <div className="truncate text-xl font-semibold">{persona.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted">{connected ? status.text : '重连中…'}</div>
      </div>
    </div>
    <div className="px-6 pt-5 pb-1"><Seg label="右侧栏" value={current} options={TABS} onChange={setPaneTab} className="[&_button]:h-8" /></div>
    <div key={current} className="anim-fade min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
      {current === 'activity' ? <ActivityTab /> : current === 'who' ? <WhoTab /> : <PermissionsTab />}
    </div>
  </div>
}

function Head({ title, count, action }: { title: string; count?: number | string | undefined; action?: React.ReactNode }) {
  return <div className="mb-2 flex items-baseline gap-1.5 text-xs">
    <span className="text-muted">{title}</span>{count != null && <span className="text-faint tabular-nums">{count}</span>}
    <span className="flex-1" />{action}
  </div>
}
const LinkBtn = ({ onClick, children }: { onClick(): void; children: React.ReactNode }) =>
  <button onClick={onClick} className="text-xs text-muted hover:text-fg">{children}</button>

// ── 活动 ────────────────────────────────────────────────────────────────────

function ActivityTab() {
  const tickets = useTickets().data?.tickets ?? []
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') }).data?.routines ?? []
  const [all, setAll] = useState(false)
  const live = tickets.filter(t => t.stage !== 'ended')
  const waiting = live.filter(needsOwner)
  const going = live.filter(t => !needsOwner(t))
  const finished = tickets.filter(t => t.ended?.outcome === 'completed').sort((a, b) => b.ended!.at - a.ended!.at)
  const today = new Date().toDateString()
  const done = all ? finished : finished.filter(t => new Date(t.ended!.at).toDateString() === today)
  const next = routines.filter(r => r.enabled && r.next).sort((a, b) => a.next! - b.next!).slice(0, 4)
  const open = (t: Ticket) => { if (t.conversationId) go(`/c/${t.conversationId}`); else openTask(t.id) }
  if (!live.length && !next.length && !finished.length) return <div className="flex flex-col items-center gap-1.5 py-12 text-sm text-faint"><ShieldCheck size={20} />现在没事，有事叫我</div>
  return <div className="space-y-6">
    {waiting.length > 0 && <section>
      <Head title="等你点头" count={waiting.length} />
      <div className="space-y-1.5">{waiting.map(t => <button key={t.id} onClick={() => open(t)} className="press flex w-full items-center gap-3 rounded-2xl bg-sunken px-3.5 py-3 text-left">
        <Shield size={16} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{t.title}</span>
          <span className="mt-0.5 block text-[11px] text-faint tabular-nums">{hm(t.attention?.at ?? t.approvals[0]?.createdAt ?? t.updatedAt)}{t.conversationId ? ' · 在聊天里' : ''}</span>
        </span>
        <span className="shrink-0 text-xs font-medium text-accent">去确认</span>
      </button>)}</div>
    </section>}
    {going.length > 0 && <section>
      <Head title="正在做" count={going.length} />
      <div className="space-y-3">{going.map(t => <button key={t.id} onClick={() => openTask(t.id)} className="block w-full text-left">
        <span className="block truncate text-sm font-semibold">{t.title}</span>
        {t.latestReport?.summary && <span className="mt-0.5 block truncate text-xs text-muted">{t.latestReport.summary}</span>}
        {t.stage === 'working' ? <span className="progress mt-2 block h-1" /> : <span className="mt-2 block h-1 rounded-full bg-sunken" />}
      </button>)}</div>
    </section>}
    {next.length > 0 && <section>
      <Head title="接下来" count={next.length} />
      <div className="space-y-2">{next.map(r => <a key={r.id} href={r.conversationId ? `#/c/${r.conversationId}` : '#/settings/routines'} className="flex gap-4 text-sm hover:text-accent">
        <span className="w-[96px] shrink-0 font-medium whitespace-nowrap tabular-nums">{when(r.next!)}</span><span className="min-w-0 flex-1 truncate">{r.name}</span>
      </a>)}</div>
    </section>}
    {(done.length > 0 || finished.length > 0) && <section className="border-t border-line pt-5">
      <Head title={all ? '做过' : '今天做过'} count={done.length}
        action={finished.length > done.length || all ? <LinkBtn onClick={() => setAll(v => !v)}>{all ? '收起' : '展开'}</LinkBtn> : undefined} />
      {all ? <Done tickets={done} /> : done.length > 0 ? <Rows tickets={done.slice(0, 6)} />
        : <p className="text-sm text-faint">今天还没做完什么。</p>}
    </section>}
  </div>
}

/** Finished work as time + title rows; a row opens the task to see how it went. */
function Rows({ tickets }: { tickets: Ticket[] }) {
  return <div className="space-y-2">{tickets.map(t => <button key={t.id} onClick={() => openTask(t.id)} className="flex w-full gap-4 text-left text-sm hover:text-accent">
    <span className="w-10 shrink-0 text-faint tabular-nums">{hm(t.ended!.at)}</span><span className="min-w-0 flex-1 truncate">{t.title}</span>
  </button>)}</div>
}

/** Everything it has finished, grouped by day, right here in the pane (动态 is for changes outside, not this). */
function Done({ tickets }: { tickets: Ticket[] }) {
  const groups: { day: string; tickets: Ticket[] }[] = []
  for (const t of tickets) {
    const day = dayName(t.ended!.at)
    const g = groups.at(-1)
    if (g?.day === day) g.tickets.push(t); else groups.push({ day, tickets: [t] })
  }
  return <div className="space-y-4">{groups.map(g => <div key={g.day}>
    <div className="mb-1.5 text-[11px] font-medium text-faint">{g.day}</div>
    <Rows tickets={g.tickets} />
  </div>)}</div>
}

function dayName(at: number) {
  const d = new Date(at), now = new Date()
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  return days === 0 ? '今天' : days === 1 ? '昨天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEK[d.getDay()]}`
}

// ── 它是谁 ──────────────────────────────────────────────────────────────────

interface MemoryRow { id: string; kind: string; text: string; status: 'active' | 'pending' }
interface Memories { memories: MemoryRow[]; kinds: { id: string; label: string }[] }
/** A few words from the personality, for the little tags under it. */
const traits = (text: string) => text.split(/[，,；;、。.!！\n]/).map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 8).slice(0, 4)
const ruleLines = (d: InstructionsState) => d.sections.map(s => d.current.sections[s.id]).flatMap(t => t.split('\n')).map(t => t.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean)

function WhoTab() {
  const qc = useQueryClient()
  const raw = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona') }).data?.persona
  const instructions = useQuery({ queryKey: ['instructions'], queryFn: () => api.get<InstructionsState>('/instructions') }).data
  const memories = useQuery({ queryKey: ['memories'], queryFn: () => api.get<Memories>('/memories') }).data
  const [editing, setEditing] = useState<string | null>(null)
  const [modal, setModal] = useState<'soul' | 'memory' | null>(null)
  const savePersonality = useMutation({ mutationFn: (personality: string) => api.put('/persona', { ...raw!, personality }), onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['persona'] }) } })
  const decide = useMutation({ mutationFn: (v: { id: string; action: 'confirm' | 'reject' }) => api.patch(`/memories/${v.id}`, { action: v.action }), onSuccess: () => qc.invalidateQueries({ queryKey: ['memories'] }) })
  const personality = raw?.personality ?? ''
  const active = memories?.memories.filter(m => m.status === 'active') ?? []
  const pending = memories?.memories.filter(m => m.status === 'pending') ?? []
  const rules = instructions ? ruleLines(instructions) : []
  return <div className="space-y-5">
    {raw && <Identity persona={raw} />}
    <section className="border-t border-line pt-5">
      <Head title="性格" action={editing == null && <LinkBtn onClick={() => setEditing(personality)}>改一改</LinkBtn>} />
      {editing != null ? <div className="space-y-2">
        <textarea autoFocus value={editing} onChange={e => setEditing(e.target.value)} placeholder="说话直接，先说结论，偶尔开个玩笑。"
          className="min-h-20 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm leading-6 outline-none focus:border-faint" />
        <div className="flex justify-end gap-1.5">
          <button onClick={() => setEditing(null)} className="press h-8 rounded-full px-3 text-[13px] text-muted hover:bg-sunken">取消</button>
          <button onClick={() => savePersonality.mutate(editing.trim())} disabled={savePersonality.isPending || !raw} className="press h-8 rounded-full bg-ink px-3.5 text-[13px] font-medium text-ink-fg disabled:opacity-50">保存</button>
        </div>
      </div> : <>
        <p className={cx('text-[15px] leading-relaxed', personality ? 'font-medium' : 'text-faint')}>{personality || '还没写它的性格，点「改一改」告诉它该怎么说话。'}</p>
        {traits(personality).length > 0 && <div className="mt-2.5 flex flex-wrap gap-1.5">{traits(personality).map(t => <span key={t} className="rounded-full border border-line px-2.5 py-0.5 text-xs">{t}</span>)}</div>}
      </>}
    </section>
    <section className="border-t border-line pt-5">
      <Head title="灵魂" count={instructions?.current.version ? `V${instructions.current.version}` : undefined} action={<LinkBtn onClick={() => setModal('soul')}>{rules.length ? '看改动' : '写一写'}</LinkBtn>} />
      {rules.length ? <ol className="space-y-1.5 text-sm">{rules.slice(0, 3).map((r, i) => <li key={i} className="flex gap-3"><span className="w-3 shrink-0 text-faint tabular-nums">{i + 1}</span><span className="min-w-0">{r}</span></li>)}</ol>
        : <p className="text-sm text-faint">做事的规矩：怎么沟通、能做什么、交付什么。</p>}
      <p className="mt-2.5 text-[11px] text-faint">只有你能改它的灵魂</p>
    </section>
    <section className="border-t border-line pt-5">
      <Head title="记忆" count={active.length} action={<LinkBtn onClick={() => setModal('memory')}>看全部</LinkBtn>} />
      <div className="flex flex-wrap gap-1.5">{memories?.kinds.map(k => { const n = active.filter(m => m.kind === k.id).length
        return n ? <span key={k.id} className="rounded-full bg-sunken px-2.5 py-1 text-xs">{k.label} <span className="tabular-nums text-muted">{n}</span></span> : null })}</div>
      {!active.length && <p className="text-sm text-faint">它还没记下关于你的事。</p>}
    </section>
    {pending.length > 0 && <section className="rounded-2xl bg-sunken px-3.5 py-3">
      <Head title="新学到的，等你确认" count={pending.length} />
      <div className="space-y-2.5">{pending.slice(0, 5).map(m => <div key={m.id} className="flex items-start gap-3 text-sm">
        <span className="min-w-0 flex-1">{m.text}</span>
        <button onClick={() => decide.mutate({ id: m.id, action: 'confirm' })} disabled={decide.isPending} className="shrink-0 text-xs font-medium text-accent">记住</button>
        <button onClick={() => decide.mutate({ id: m.id, action: 'reject' })} disabled={decide.isPending} className="shrink-0 text-xs text-muted hover:text-fg">不要</button>
      </div>)}</div>
    </section>}
    {modal === 'soul' && <Modal title="灵魂" onClose={() => setModal(null)}><InstructionsPage /></Modal>}
    {modal === 'memory' && <Modal title="记忆" onClose={() => setModal(null)}><MemoryPage /></Modal>}
  </div>
}

const ROLES: { id: Persona['role']; label: string }[] = [{ id: 'all', label: '什么都帮' }, { id: 'life', label: '生活助理' }, { id: 'work', label: '工作助理' }, { id: 'study', label: '学习伙伴' }]
const AVATARS = ['🦊', '🐱', '🐼', '🦉', '🐙', '🌱']

/** 名字和样子 (Figma v7 D): who it is, set where you look at it. Settings no longer has a copy. */
function Identity({ persona }: { persona: Persona }) {
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (p: Partial<Persona>) => api.put('/persona', p),
    onMutate: p => qc.setQueryData<{ persona: Persona }>(['persona'], old => old && { persona: { ...old.persona, ...p } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['persona'] }),
  })
  const [name, setName] = useState(persona.name)
  useEffect(() => setName(persona.name), [persona.name])
  const field = 'h-8 w-[150px] rounded-[10px] border border-line bg-card px-3 text-[13px] outline-none focus:border-faint'
  return <section>
    <Head title="名字和样子" />
    <div className="rounded-2xl bg-sunken px-3.5 py-1.5">
      <label className="flex min-h-11 items-center gap-3 text-sm"><span className="flex-1">名字</span>
        <input value={name} maxLength={24} aria-label="名字" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          onBlur={() => { if (name.trim() && name.trim() !== persona.name) save.mutate({ name: name.trim() }); else setName(persona.name) }} className={field} />
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm"><span className="flex-1">角色</span>
        <span className="relative">
          <select value={persona.role} aria-label="角色" onChange={e => save.mutate({ role: e.target.value as Persona['role'] })} className={cx(field, 'cursor-pointer appearance-none pr-8')}>
            {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
        </span>
      </label>
      <div className="flex min-h-11 items-center gap-3 text-sm"><span className="flex-1">样子</span>
        <span className="flex items-center gap-0.5">
          <button type="button" aria-label="糯糯" aria-pressed={isMascot(persona)} onClick={() => save.mutate({ avatar: MASCOT })}
            className={cx('flex size-7 items-center justify-center rounded-lg', isMascot(persona) ? 'bg-card ring-1 ring-line' : 'hover:bg-card')}><Mascot color={persona.color} size={20} /></button>
          {AVATARS.map(a => <button key={a} type="button" aria-pressed={persona.avatar === a} onClick={() => save.mutate({ avatar: a })}
            className={cx('size-7 rounded-lg text-sm', persona.avatar === a ? 'bg-card ring-1 ring-line' : 'hover:bg-card')}>{a}</button>)}
        </span>
      </div>
    </div>
  </section>
}

// ── 权限 ────────────────────────────────────────────────────────────────────

const LEVEL_LABEL: Record<Level, string> = { allow: '直接做', review: '它判断', ask: '先问你', deny: '不行' }

type Grant = { id: string; ticketId: string; label: string; title: string; createdAt: number; standing: boolean }
const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)
const DECISION: Record<string, { label: string; cls: string }> = { allow: { label: '自己做了', cls: 'text-ok' }, block: { label: '没做', cls: 'text-danger' }, escalate: { label: '问了你', cls: 'text-warn' } }

function PermissionsTab() {
  const qc = useQueryClient()
  const review = useQuery({ queryKey: ['review'], queryFn: () => api.get<{ settings: ReviewSettings; defaults: ReviewSettings }>('/settings/review') }).data?.settings
  const execution = useQuery({ queryKey: ['execution'], queryFn: () => api.get<{ settings: ExecutionSettings }>('/settings/execution') }).data?.settings
  const audit = useQuery({ queryKey: ['audit', 1000], queryFn: () => api.get<{ entries: AuditEntry[] }>('/audit?limit=1000') }).data?.entries ?? []
  const grants = useQuery({ queryKey: ['grants'], queryFn: () => api.get<{ grants: Grant[] }>('/grants') }).data?.grants ?? []
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/grants/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['grants'] }) })
  const saveReview = useMutation({
    mutationFn: (patch: Partial<ReviewSettings>) => api.put('/settings/review', { ...review!, ...patch }),
    onMutate: patch => { qc.setQueryData<{ settings: ReviewSettings }>(['review'], old => old && { ...old, settings: { ...old.settings, ...patch } }) },
    onSettled: () => qc.invalidateQueries({ queryKey: ['review'] }),
  })
  const setRoots = useMutation({
    mutationFn: (workspaceRoots: string[]) => api.put('/settings/execution', { ...execution!, workspaceRoots }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['execution'] }),
  })
  const [adding, setAdding] = useState<string | null>(null)
  const [rules, setRules] = useState<string | null>(null)
  const [log, setLog] = useState(false)
  const week = audit.filter(e => e.at > Date.now() - 7 * 86_400_000)
  const self = week.filter(e => e.action === 'review' && e.decision === 'allow' && e.actor !== 'owner').length
  const asked = week.filter(e => e.decision === 'escalate').length
  const refused = week.filter(e => e.actor === 'owner' && e.action === 'approval' && e.decision === 'block').length
  if (!review) return null
  const standing = grants.filter(g => g.standing)
  const forTask = grants.filter(g => !g.standing)
  return <div className="space-y-5">
    <section>
      <Head title="它能自己做什么" />
      <div className="space-y-1">
        <Row icon={<Globe size={16} />} label="查网页、看资料"><span className="px-3 text-xs text-muted">直接做</span></Row>
        <Row icon={<Send size={16} />} label="往外发：评论、发消息">
          <LevelPick value={review.external} options={['allow', 'review', 'ask', 'deny']} onChange={external => saveReview.mutate({ external })} label="往外发" />
        </Row>
        <Row icon={<Trash2 size={16} />} label="删除、强推、合并">
          <LevelPick value={review.destructive} options={['review', 'ask', 'deny']} onChange={destructive => saveReview.mutate({ destructive: destructive as ReviewSettings['destructive'] })} label="删除、强推、合并" />
        </Row>
        <Row icon={<CreditCard size={16} />} label="花钱">
          <span className="flex h-7 items-center gap-1 rounded-full border border-accent/40 px-3 text-xs text-accent">每次都问<Lock size={12} /></span>
        </Row>
      </div>
      {standing.length > 0 && <div className="mt-3 space-y-1.5">{standing.map(g => <div key={g.id} className="anim-rise flex items-center gap-3 rounded-2xl bg-accent-soft px-3.5 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{g.label} · 直接做</span>
          <span className="block text-[11px] text-muted">{ago(g.createdAt)} 你在审批卡里定的</span>
        </span>
        <button onClick={() => revoke.mutate(g.id)} disabled={revoke.isPending} className="shrink-0 text-xs font-medium text-accent">撤销</button>
      </div>)}</div>}
      <p className="mt-3 text-[11px] leading-5 text-faint">「花钱」这一条锁着，永远先问你。其他的点一下就能改，审批卡上点「以后这类直接做」也会记在这里。</p>
    </section>
    <section className="border-t border-line pt-5">
      <Head title="它能碰的文件夹" action={adding == null && execution && <LinkBtn onClick={() => setAdding('')}><span className="flex items-center gap-0.5"><Plus size={12} />加一个</span></LinkBtn>} />
      <div className="space-y-1">
        <Row icon={<Folder size={16} />} label="每件事自己的工作目录"><span className="px-3 text-xs text-muted">能改</span></Row>
        {execution?.workspaceRoots.map(r => <Row key={r} icon={<Folder size={16} />} label={<span className="font-mono text-[13px]">{r}</span>}>
          <button onClick={() => setRoots.mutate(execution.workspaceRoots.filter(x => x !== r))} aria-label={`不再允许 ${r}`} className="press flex size-7 items-center justify-center rounded-full text-faint hover:bg-sunken hover:text-fg"><X size={14} /></button>
        </Row>)}
      </div>
      {adding != null && <form className="mt-2 flex gap-1.5" onSubmit={e => { e.preventDefault(); const v = adding.trim(); if (v && execution && !execution.workspaceRoots.includes(v)) setRoots.mutate([...execution.workspaceRoots, v]); setAdding(null) }}>
        <input autoFocus value={adding} onChange={e => setAdding(e.target.value)} placeholder="~/code" aria-label="文件夹路径"
          className="h-8 min-w-0 flex-1 rounded-full border border-line bg-panel px-3 font-mono text-[13px] outline-none focus:border-faint" />
        <button type="submit" className="press h-8 rounded-full bg-ink px-3 text-[13px] font-medium text-ink-fg">加上</button>
      </form>}
      <p className="mt-2 text-[11px] leading-5 text-faint">你在对话里点名这些文件夹时，它可以直接在里面做事。</p>
    </section>
    {forTask.length > 0 && <section className="border-t border-line pt-5">
      <Head title="这件事里你都同意过的" count={forTask.length} />
      <div className="space-y-1">{forTask.map(g => <div key={g.id} className="flex items-center gap-2.5 py-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate">{g.label}<span className="text-faint"> · {g.title}</span></span>
        <button onClick={() => revoke.mutate(g.id)} disabled={revoke.isPending} className="shrink-0 text-xs text-muted hover:text-fg">撤回</button>
      </div>)}</div>
    </section>}
    <section className="border-t border-line pt-5">
      <Head title="规则" count={review.rules.length || undefined} action={rules == null && <LinkBtn onClick={() => setRules(review.rules.join('\n'))}>{review.rules.length ? '展开' : '写一条'}</LinkBtn>} />
      {rules != null ? <div className="space-y-2">
        <textarea autoFocus value={rules} onChange={e => setRules(e.target.value)} placeholder={'发邮件、发评论之前先让我看一眼。\n不要删任何文件。'} aria-label="规则，每行一条"
          className="min-h-24 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm leading-6 outline-none focus:border-faint" />
        <div className="flex justify-end gap-1.5">
          <button onClick={() => setRules(null)} className="press h-8 rounded-full px-3 text-[13px] text-muted hover:bg-sunken">收起</button>
          <button onClick={() => saveReview.mutate({ rules: lines(rules) }, { onSuccess: () => setRules(null) })} disabled={saveReview.isPending || lines(rules).join() === review.rules.join()}
            className="press h-8 rounded-full bg-ink px-3.5 text-[13px] font-medium text-ink-fg disabled:opacity-50">保存</button>
        </div>
      </div> : review.rules.length > 0 && <ol className="space-y-1.5 text-sm">{review.rules.slice(0, 3).map((r, i) => <li key={i} className="flex gap-3"><span className="w-3 shrink-0 text-faint tabular-nums">{i + 1}</span><span className="min-w-0">{r}</span></li>)}</ol>}
      <div className="mt-2 flex min-h-10 items-center gap-3 text-sm">
        <span className="min-w-0 flex-1 text-muted">拿不准的事，交给它判断还是问你</span>
        <span className="relative shrink-0">
          <select value={review.mode} onChange={e => saveReview.mutate({ mode: e.target.value as ReviewSettings['mode'] })} aria-label="拿不准的事"
            className="h-7 cursor-pointer appearance-none rounded-full bg-sunken pr-7 pl-3 text-xs font-medium outline-none hover:bg-hero-2 focus-visible:ring-2 focus-visible:ring-accent">
            <option value="model">它判断</option><option value="ask">问你</option>
          </select>
          <ChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
        </span>
      </div>
    </section>
    <section className="border-t border-line pt-5">
      <Head title="最近 7 天" action={<LinkBtn onClick={() => setLog(v => !v)}>{log ? '收起' : '看记录'}</LinkBtn>} />
      <p className="text-sm tabular-nums">自己做了 {self} 次 · 问过你 {asked} 次 · 你拒绝了 {refused} 次</p>
      {log && <div className="mt-3 space-y-0.5">
        {!week.length ? <p className="py-2 text-sm text-faint">这 7 天没有要审核的事。</p> : week.slice(0, 40).map(e => <div key={e.id} className="flex gap-3 py-1.5 text-[13px]">
          <span className="w-[70px] shrink-0 text-xs text-faint tabular-nums">{ago(e.at)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">{e.input}</span>
            <span className={cx('text-xs', DECISION[e.decision]?.cls ?? 'text-muted')}>{DECISION[e.decision]?.label ?? e.decision}</span>{e.reason && <span className="text-xs text-faint"> · {e.reason}</span>}
          </span>
        </div>)}
        {week.length > 40 && <p className="pt-1 text-[11px] text-faint">更早的在 设置 · 数据和隐私 · 原始记录。</p>}
      </div>}
    </section>
  </div>
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex min-h-11 items-center gap-3">
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken text-muted">{icon}</span>
    <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
    {children}
  </div>
}

function LevelPick({ value, options, onChange, label }: { value: Level; options: Level[]; onChange(v: Level): void; label: string }) {
  return <span className="relative shrink-0">
    <select value={value} onChange={e => onChange(e.target.value as Level)} aria-label={label}
      className="h-7 cursor-pointer appearance-none rounded-full bg-sunken pr-7 pl-3 text-xs font-medium outline-none hover:bg-hero-2 focus-visible:ring-2 focus-visible:ring-accent">
      {options.map(o => <option key={o} value={o}>{LEVEL_LABEL[o]}</option>)}
    </select>
    <ChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
  </span>
}

// ── Narrow windows ──────────────────────────────────────────────────────────

/** Narrow windows: the pane as a drawer (tablets) or a bottom sheet (phones). */
export function PaneDrawer() {
  const open = useActivityOpen()
  const [phone, setPhone] = useState(() => matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const mq = matchMedia('(max-width: 767px)')
    const on = () => setPhone(mq.matches)
    mq.addEventListener('change', on)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') openActivity(false) }
    addEventListener('keydown', onKey)
    return () => { mq.removeEventListener('change', on); removeEventListener('keydown', onKey) }
  }, [])
  const { shown, leaving } = usePresence(open)
  if (!shown) return null
  const close = () => openActivity(false)
  return <div className={cx('anim-fade fixed inset-0 z-30 flex bg-[var(--scrim)]', phone ? 'items-end' : 'justify-end', leaving && 'out-fade pointer-events-none')} onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div role="dialog" aria-modal="true" aria-label="糯糯" className={phone
      ? cx('anim-sheet flex h-[86dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-panel pb-[env(safe-area-inset-bottom)] shadow-2xl', leaving && 'out-sheet')
      : cx('anim-drawer-r flex h-full w-[360px] flex-col overflow-hidden border-l border-line bg-panel shadow-2xl', leaving && 'out-r')}>
      <RightPane onClose={close} />
    </div>
  </div>
}
