/**
 * The right pane (Figma v6, 81:1128 / 92:1057 / section 20): opened from 糯糯 in the sidebar. Its face and status line on
 * top, then an icon-only switch (Figma v7, section 23): 活动 (what waits for you, what it is doing, what comes next, what
 * it has done — the full history opens in place), 它是谁 (名字 · 角色 · 样子 · 灵魂 · 记忆 · 个性与心境) and 权限 (what it may do
 * on its own, where, and the rules). These live only here, never in settings. 目标 lives only on its page (更多 → 目标).
 * On narrower windows the same pane opens as a drawer, and on phones as a sheet from the bottom.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Brain, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Cloud, CreditCard, FileText, Folder, GitBranch, Globe, Image, ListChecks, Loader2, Lock, Mail, Pencil, Plus, ScrollText, Send, Shield, ShieldCheck, Smile, SquareTerminal, Trash2, Upload, Users, X, XCircle } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type AccessSettings, type AppLevel, type AuditEntry, type ExecutionSettings, type InstructionsState, type Level, type LocalApp, type Persona, type ReviewSettings, type Routine, type SourceInfo, type Ticket } from './api'
import { BrowserPaneTab } from './browser'
import { BrowserWatch } from './watch'
import { SkillsSection } from './skills'
import { MoodSection } from './mood'
import { openActivity, openTask, useActivityOpen, useLive } from './live'
import { Avatar, isImageAvatar, isMascot, Mascot, MASCOT, statusLine, usePersona } from './persona'
import { go } from './route'
import { LiquidButton, MemorySheet, pickHues, SoulSheet } from './soul'
import { endedText, needsOwner, STATE_TEXT, useTickets } from './tasks'
import { cx, IconButton, Seg } from './ui'
import { usePresence } from './shell'
import { locale, tx } from './i18n'

export type PaneTab = 'activity' | 'browser' | 'who' | 'permissions'
let tab: PaneTab = 'activity'
const tabListeners = new Set<() => void>()
export function setPaneTab(next: PaneTab) { tab = next; for (const l of tabListeners) l() }
const usePaneTab = () => useSyncExternalStore(l => { tabListeners.add(l); return () => tabListeners.delete(l) }, () => tab)

const ACTIVITY_TAB = { id: 'activity' as PaneTab, label: <span className="flex items-center" title={tx('活动')}><ListChecks size={17} aria-label={tx('活动')} /></span> }
const BROWSER_TAB = { id: 'browser' as PaneTab, label: <span className="flex items-center" title={tx('浏览器')}><Globe size={17} aria-label={tx('浏览器')} /></span> }
const WHO_TAB = { id: 'who' as PaneTab, label: <span className="flex items-center" title={tx('它是谁')}><Smile size={17} aria-label={tx('它是谁')} /></span> }
const PERMISSIONS_TAB = { id: 'permissions' as PaneTab, label: <span className="flex items-center" title={tx('权限')}><Shield size={17} aria-label={tx('权限')} /></span> }
const BROWSER_TABS = [ACTIVITY_TAB, BROWSER_TAB, WHO_TAB, PERMISSIONS_TAB]

const hm = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
const WEEK = [tx('周日'), tx('周一'), tx('周二'), tx('周三'), tx('周四'), tx('周五'), tx('周六')]
function when(at: number) {
  const d = new Date(at), now = new Date()
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000)
  return `${days === 0 ? tx('今天') : days === 1 ? tx('明天') : days < 7 ? WEEK[d.getDay()] : `${d.getMonth() + 1}/${d.getDate()}`} ${hm(at)}`
}

function ago(at: number) {
  const days = Math.round((new Date(new Date().toDateString()).getTime() - new Date(new Date(at).toDateString()).getTime()) / 86_400_000)
  return `${days === 0 ? tx('今天') : days === 1 ? tx('昨天') : `${new Date(at).getMonth() + 1}/${new Date(at).getDate()}`} ${hm(at)}`
}

function activityTime(at: number) {
  const d = new Date(at), now = new Date()
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  if (days === 0) return hm(at)
  if (days === 1) return `${tx('昨天')} ${hm(at)}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hm(at)}`
}

export function fmtElapsed(startAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startAt) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [enabled])
  return now
}

export function RightPane({ onClose }: { onClose(): void }) {
  const persona = usePersona()
  const connected = useLive(s => s.connected)
  const live = (useTickets().data?.tickets ?? []).filter(t => t.stage !== 'ended')
  const waiting = live.filter(needsOwner)
  const going = live.filter(t => !needsOwner(t))
  const status = statusLine(live)
  const activeTab = usePaneTab()
  const mood = !connected ? 'sleepy' : status.tone === 'working' ? 'thinking' : status.tone
  const statusDotCls = !connected
    ? 'bg-faint'
    : waiting.length > 0
      ? 'bg-warn'
      : going.length > 0
        ? 'bg-[#2656c7] dark:bg-[#78aef2]'
        : 'bg-ok'
  const statusText = !connected
    ? tx('重连中…')
    : waiting.length > 0
      ? `${tx('已连接')} · ${tx('{0} 件事等你点头', waiting.length)}`
      : going.length > 0
        ? `${tx('已连接')} · ${tx('正在执行 {0} 项任务', going.length)}`
        : tx('已连接')

  return <div className="flex h-full flex-col">
    <div className="flex h-11 shrink-0 items-center justify-end px-3"><IconButton label={tx('关闭')} onClick={onClose}><X size={17} /></IconButton></div>
    <div className="flex flex-col items-center px-6 pt-0.5 pb-2 text-center">
      <div className="relative">
        <div className={cx('flex size-[68px] items-center justify-center overflow-hidden rounded-full ring-2 ring-line', isMascot(persona) ? 'bg-[#f6ebe6] dark:bg-[#251e21]' : 'bg-sunken')}>
          {isMascot(persona) ? <Mascot color={persona.color} size={46} mood={mood} track />
            : isImageAvatar(persona.avatar) ? <img src={persona.avatar} alt={persona.name} className="size-full rounded-full object-cover" />
            : <Avatar persona={persona} size={68} mood={mood} className="rounded-full!" />}
        </div>
        <button
          type="button"
          aria-label={tx('修改名字和样子')}
          title={tx('修改名字和样子')}
          onClick={() => {
            setPaneTab('who')
            requestAnimationFrame(() => {
              const el = document.getElementById('nuonuo-persona-name-input') as HTMLInputElement | null
              el?.focus()
              el?.select()
            })
          }}
          className="press absolute right-0 bottom-0 flex size-[21px] items-center justify-center rounded-full border border-line bg-card text-muted shadow-xs hover:text-fg"
        >
          <Pencil size={10} />
        </button>
      </div>
      <div className="mt-2.5 max-w-full truncate text-[16.5px] font-bold tracking-tight text-fg">{persona.name}</div>
      <div className="mt-1 flex items-center justify-center gap-1.5 text-[11.5px] text-muted tabular-nums">
        <span className={cx('size-[7px] shrink-0 rounded-full', statusDotCls)} />
        <span className="truncate">{statusText}</span>
      </div>
    </div>
    <div className="px-5 pt-3 pb-1"><Seg label={tx('右侧栏')} value={activeTab} options={BROWSER_TABS} onChange={setPaneTab} className="[&_button]:h-8" /></div>
    <div key={activeTab} className={cx('anim-fade min-h-0 flex-1 px-5 pt-3.5', activeTab === 'activity' ? 'flex flex-col overflow-hidden pb-3.5' : 'overflow-y-auto pb-5')}>
      {activeTab === 'activity' ? <ActivityTab /> : activeTab === 'browser' ? <BrowserPaneTab /> : activeTab === 'who' ? <WhoTab /> : <PermissionsTab />}
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

function activitySummary(t: Ticket): string {
  const raw = t.latestReport?.summary
    ? t.latestReport.summary.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim()
    : ''
  if (raw) return raw
  if (t.currentStep?.label) return t.currentStep.label
  if (t.ended?.reason) return t.ended.reason
  return endedText(t)
}

function ActivityRowIcon({ t, isFailed }: { t: Ticket; isFailed: boolean }) {
  if (isFailed) return <XCircle size={17} className="mt-0.5 shrink-0 text-danger" />
  if (t.iconKind === 'file') return <FileText size={17} className="mt-0.5 shrink-0 text-muted" />
  if (t.iconKind === 'terminal') return <SquareTerminal size={17} className="mt-0.5 shrink-0 text-muted" />
  return <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-muted" />
}

function ActivityTab() {
  const tickets = useTickets().data?.tickets ?? []
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => api.get<{ routines: Routine[] }>('/routines') }).data?.routines ?? []
  const [all, setAll] = useState(false)
  const live = tickets.filter(t => t.stage !== 'ended')
  const waiting = live.filter(needsOwner)
  const going = live.filter(t => !needsOwner(t))
  const now = useNow(going.length > 0)
  const history = tickets
    .filter(t => t.stage === 'ended')
    .sort((a, b) => (b.ended?.at ?? b.updatedAt) - (a.ended?.at ?? a.updatedAt))
  const shownHistory = all ? history : history.slice(0, 25)
  const next = routines.filter(r => r.enabled && r.next).sort((a, b) => a.next! - b.next!).slice(0, 4)
  const openWaiting = (t: Ticket) => { if (t.conversationId) go(`/c/${t.conversationId}`); else openTask(t.id) }

  if (!live.length && !next.length && !history.length) {
    return <div className="flex flex-col items-center gap-1.5 py-12 text-sm text-faint"><ShieldCheck size={20} />{tx('现在没事，有事叫我')}</div>
  }

  return <div className="flex h-full min-h-0 flex-col gap-2.5">
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-0.5">
      {waiting.length > 0 && <div className="space-y-2">
        {waiting.map(t => {
          const detailLine = t.approvals[0]?.command
            ? `${tx('申请执行')} ${t.approvals[0].command}`
            : (t.approvals[0]?.reason ?? t.attention?.question ?? STATE_TEXT[t.stage])
          return <button
            key={t.id}
            type="button"
            onClick={() => openWaiting(t)}
            className="press block w-full rounded-[14px] border border-warn/35 bg-warn-soft px-3 py-2.5 text-left transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] font-bold text-warn">{tx('等你点头')} · {t.title}</span>
              <span className="shrink-0 text-[11.5px] font-bold text-accent">{tx('去确认')} &gt;</span>
            </div>
            <div className="mt-1 truncate text-[11.5px] text-muted">
              {detailLine}{t.conversationId ? tx(' · 在聊天里') : ''}
            </div>
          </button>
        })}
      </div>}

      {going.length > 0 && <div className="space-y-2">
        {going.map(t => {
          const stepNum = Math.max(1, t.stepCount ?? 1)
          const stepText = t.currentStep?.label || t.latestReport?.summary?.replace(/[#*`>]/g, '').trim() || tx('正在准备执行步骤…')
          const mmss = fmtElapsed(t.createdAt, now)
          return <div key={t.id} className="space-y-1.5">
            <button
              type="button"
              onClick={() => openTask(t.id)}
              className="press block w-full rounded-[14px] border border-[#2656c7]/35 bg-[#edf2fe] px-3 py-2.5 text-left transition-colors dark:border-[#78aef2]/35 dark:bg-[#162133]"
            >
              <div className="flex items-start gap-2.5">
                <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-[#2656c7] dark:text-[#78aef2]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13.5px] font-semibold text-fg">{t.title}</span>
                    <span className="shrink-0 rounded-full bg-[#dbe6fd] px-2 py-0.5 text-[10.5px] font-medium text-[#2656c7] tabular-nums dark:bg-[#1f314d] dark:text-[#78aef2]">
                      {tx('第 {0} 步', stepNum)}
                    </span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 break-all text-[12px] leading-[17px] text-fg">{stepText}</div>
                  <div className="mt-1 text-[11px] text-muted tabular-nums">
                    {tx('刚刚 · 已用时 {0}（点击查看实时输出）', mmss)}
                    {t.runningJobs ? tx(' · {0} 个后台命令', t.runningJobs) : ''}
                  </div>
                </div>
              </div>
              <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-[#dbe6fd] dark:bg-[#1f314d]">
                <div className="h-full w-2/3 rounded-full bg-[#2656c7] dark:bg-[#78aef2]" />
              </div>
            </button>
            <BrowserWatch t={t} />
          </div>
        })}
      </div>}

      {shownHistory.length > 0 && <div className="space-y-1">
        {shownHistory.map(t => {
          const isFailed = Boolean(t.ended?.outcome && t.ended.outcome !== 'completed') || t.iconKind === 'error'
          const steps = t.stepCount ?? 0
          const ts = activityTime(t.ended?.at ?? t.updatedAt)
          return <button
            key={t.id}
            type="button"
            onClick={() => openTask(t.id)}
            className="group flex w-full items-start gap-2.5 rounded-[14px] px-2.5 py-2 text-left transition-colors hover:bg-sunken"
          >
            <ActivityRowIcon t={t} isFailed={isFailed} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13.5px] font-medium text-fg">{t.title}</span>
                {isFailed ? (
                  <span className="shrink-0 text-[11px] font-medium text-danger">{tx('已停下')} &gt;</span>
                ) : steps >= 2 && t.kind !== 'action' ? (
                  <span className="shrink-0 text-[11px] text-faint tabular-nums">{tx('{0} 步', steps)} &gt;</span>
                ) : null}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-muted">{activitySummary(t)}</div>
              <div className="mt-1 text-[11px] text-faint tabular-nums">
                {ts}{isFailed ? ` · ${tx('点击可重试或查看失败步骤')}` : ''}
              </div>
            </div>
          </button>
        })}
        {history.length > 25 && (
          <div className="pt-1 text-center">
            <LinkBtn onClick={() => setAll(v => !v)}>{all ? tx('收起早期记录') : tx('展开全部 {0} 条记录', history.length)}</LinkBtn>
          </div>
        )}
      </div>}
    </div>

    {next.length > 0 && <a
      href={next[0]!.conversationId ? `#/c/${next[0]!.conversationId}` : '#/settings/routines'}
      className="flex shrink-0 items-center justify-between gap-2 rounded-[12px] bg-sunken px-3 py-2 text-[11.5px] text-muted transition-colors hover:text-fg"
    >
      <span className="flex min-w-0 items-center gap-2 truncate">
        <CalendarDays size={13} className="shrink-0 text-muted" />
        <span className="truncate tabular-nums">{tx('接下来')} · {when(next[0]!.next!)} {next[0]!.name}</span>
      </span>
      <ChevronRight size={13} className="shrink-0 text-faint" />
    </a>}
  </div>
}

// ── 它是谁 ──────────────────────────────────────────────────────────────────

interface MemoryRow { id: string; kind: string; text: string; status: 'active' | 'pending' }
interface Memories { memories: MemoryRow[]; kinds: { id: string; label: string }[] }
/** How many parts the 灵魂 document has: its ## sections, or 1 for a document without headings. */
const soulParts = (body: string) => body.trim() ? Math.max(1, (body.match(/^#{1,3}\s/gm) ?? []).length) : 0

function WhoTab() {
  const qc = useQueryClient()
  const raw = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona') }).data?.persona
  const instructions = useQuery({ queryKey: ['instructions'], queryFn: () => api.get<InstructionsState>('/instructions') }).data
  const memories = useQuery({ queryKey: ['memories'], queryFn: () => api.get<Memories>('/memories') }).data
  const [modal, setModal] = useState<'soul' | 'memory' | null>(null)
  // A new pair of colours each time 它是谁 opens (Figma section 24).
  const [hues] = useState(() => pickHues())
  const decide = useMutation({ mutationFn: (v: { id: string; action: 'confirm' | 'reject' }) => api.patch(`/memories/${v.id}`, { action: v.action }), onSuccess: () => qc.invalidateQueries({ queryKey: ['memories'] }) })
  const active = memories?.memories.filter(m => m.status === 'active') ?? []
  const pending = memories?.memories.filter(m => m.status === 'pending') ?? []
  const soul = instructions?.current
  const parts = soulParts(soul?.body ?? '')
  return <div className="space-y-5">
    {raw && <Identity persona={raw} />}
    <section className="border-t border-line pt-5">
      <div className="flex gap-3">
        <LiquidButton hues={hues.soul} icon={<ScrollText size={18} />} title={tx('灵魂')} sub={soul?.version ? tx('第 {0} 版 · {1} 段', soul.version, parts) : tx('还没写')} onClick={() => setModal('soul')} />
        <LiquidButton hues={hues.memory} icon={<Brain size={18} />} title={tx('记忆')} sub={tx('{0} 件', active.length)} onClick={() => setModal('memory')} />
      </div>
      <p className="mt-2.5 text-[11px] text-faint">{tx('点开看全文，可以直接改。')}</p>
    </section>
    <MoodSection Head={Head} />
    <SkillsSection Head={Head} LinkBtn={LinkBtn} />
    {pending.length > 0 && <section className="rounded-2xl bg-sunken px-3.5 py-3">
      <Head title={tx('新学到的，等你确认')} count={pending.length} />
      <div className="space-y-2.5">{pending.slice(0, 5).map(m => <div key={m.id} className="flex items-start gap-3 text-sm">
        <span className="min-w-0 flex-1">{m.text}</span>
        <button onClick={() => decide.mutate({ id: m.id, action: 'confirm' })} disabled={decide.isPending} className="shrink-0 text-xs font-medium text-accent">{tx('记住')}</button>
        <button onClick={() => decide.mutate({ id: m.id, action: 'reject' })} disabled={decide.isPending} className="shrink-0 text-xs text-muted hover:text-fg">{tx('不要')}</button>
      </div>)}</div>
    </section>}
    {modal === 'soul' && <SoulSheet hues={hues.soul} onClose={() => setModal(null)} />}
    {modal === 'memory' && <MemorySheet hues={hues.memory} count={active.length} onClose={() => setModal(null)} />}
  </div>
}

const ROLES: { id: Persona['role']; label: string }[] = [{ id: 'all', label: tx('什么都帮') }, { id: 'life', label: tx('生活助理') }, { id: 'work', label: tx('工作助理') }, { id: 'study', label: tx('学习伙伴') }]
const AVATARS = ['🦊', '🐱', '🐼', '🦉', '🐙', '🌱']

function compressAvatarImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const img = new window.Image()
      img.onerror = () => reject(new Error('Image load failed'))
      img.onload = () => {
        const size = 160
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(String(reader.result)); return }
        const minSide = Math.min(img.width, img.height) || 1
        const sx = (img.width - minSide) / 2
        const sy = (img.height - minSide) / 2
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size)
        const webp = canvas.toDataURL('image/webp', 0.86)
        resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.86))
      }
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

/** 名字和样子 (Figma v7 D): who it is, set where you look at it. Settings no longer has a copy. */
function Identity({ persona }: { persona: Persona }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const save = useMutation({
    mutationFn: (p: Partial<Persona>) => api.put('/persona', p),
    onMutate: p => qc.setQueryData<{ persona: Persona }>(['persona'], old => old && { persona: { ...old.persona, ...p } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['persona'] }),
  })
  const [name, setName] = useState(persona.name)
  useEffect(() => setName(persona.name), [persona.name])
  const field = 'h-8 w-[150px] rounded-[10px] border border-line bg-card px-3 text-[13px] outline-none focus:border-faint'
  const customImg = isImageAvatar(persona.avatar)
  return <section>
    <Head title={tx('名字和样子')} />
    <div className="rounded-2xl bg-sunken px-3.5 py-1.5">
      <label className="flex min-h-11 items-center gap-3 text-sm"><span className="flex-1">{tx('名字')}</span>
        <input id="nuonuo-persona-name-input" value={name} maxLength={24} aria-label={tx('名字')} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          onBlur={() => { if (name.trim() && name.trim() !== persona.name) save.mutate({ name: name.trim() }); else setName(persona.name) }} className={field} />
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm"><span className="flex-1">{tx('角色')}</span>
        <span className="relative">
          <select value={persona.role} aria-label={tx('角色')} onChange={e => save.mutate({ role: e.target.value as Persona['role'] })} className={cx(field, 'cursor-pointer appearance-none pr-8')}>
            {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
        </span>
      </label>
      <div className="flex min-h-11 items-center gap-3 text-sm"><span className="flex-1">{tx('样子')}</span>
        <span className="flex items-center gap-0.5">
          <button type="button" aria-label={tx('糯糯')} aria-pressed={isMascot(persona)} onClick={() => save.mutate({ avatar: MASCOT })}
            className={cx('flex size-7 items-center justify-center rounded-lg', isMascot(persona) ? 'bg-card ring-1 ring-line' : 'hover:bg-card')}><Mascot color={persona.color} size={20} /></button>
          {AVATARS.map(a => <button key={a} type="button" aria-pressed={persona.avatar === a} onClick={() => save.mutate({ avatar: a })}
            className={cx('size-7 rounded-lg text-sm', persona.avatar === a ? 'bg-card ring-1 ring-line' : 'hover:bg-card')}>{a}</button>)}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={async e => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              try {
                const dataUrl = await compressAvatarImage(f)
                save.mutate({ avatar: dataUrl })
              } catch { /* ignore invalid image */ }
            }}
          />
          <button
            type="button"
            aria-label={tx('上传自定义头像')}
            title={tx('上传自定义头像')}
            aria-pressed={customImg}
            onClick={() => fileRef.current?.click()}
            className={cx('flex size-7 items-center justify-center overflow-hidden rounded-lg text-muted hover:text-fg', customImg ? 'bg-card ring-1 ring-line' : 'hover:bg-card')}
          >
            {customImg ? <img src={persona.avatar} alt={persona.name} className="size-5 rounded-full object-cover" /> : <Upload size={13} />}
          </button>
        </span>
      </div>
    </div>
  </section>
}

// ── 权限 ────────────────────────────────────────────────────────────────────

const LEVEL_LABEL: Record<Level, string> = { allow: tx('直接做'), review: tx('它判断'), ask: tx('先问你'), deny: tx('不行') }

type Grant = { id: string; ticketId: string; label: string; title: string; createdAt: number; standing: boolean }
const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)
const DECISION: Record<string, { label: string; cls: string }> = { allow: { label: tx('自己做了'), cls: 'text-ok' }, block: { label: tx('没做'), cls: 'text-danger' }, escalate: { label: tx('问了你'), cls: 'text-warn' } }

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
      <Head title={tx('它能自己做什么')} />
      <div className="space-y-1">
        <Row icon={<Globe size={16} />} label={tx('查网页、看资料')}><span className="inline-flex h-7 items-center rounded-full bg-sunken px-3 text-xs font-medium text-fg">{tx('直接做')}</span></Row>
        <Row icon={<Send size={16} />} label={tx('往外发：评论、发消息')}>
          <LevelPick value={review.external} options={['allow', 'review', 'ask', 'deny']} onChange={external => saveReview.mutate({ external })} label={tx('往外发')} />
        </Row>
        <Row icon={<Trash2 size={16} />} label={tx('删除、强推、合并')}>
          <LevelPick value={review.destructive} options={['review', 'ask', 'deny']} onChange={destructive => saveReview.mutate({ destructive: destructive as ReviewSettings['destructive'] })} label={tx('删除、强推、合并')} />
        </Row>
        <Row icon={<CreditCard size={16} />} label={tx('花钱')}>
          <span className="flex h-7 items-center gap-1 rounded-full border border-accent/40 px-3 text-xs text-accent">{tx('每次都问')}<Lock size={12} /></span>
        </Row>
      </div>
      {standing.length > 0 && <div className="mt-3 space-y-1.5">{standing.map(g => <div key={g.id} className="anim-rise flex items-center gap-3 rounded-2xl bg-accent-soft px-3.5 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{tx('{0} · 直接做', g.label)}</span>
          <span className="block text-[11px] text-muted">{tx('{0} 你在审批卡里定的', ago(g.createdAt))}</span>
        </span>
        <button onClick={() => revoke.mutate(g.id)} disabled={revoke.isPending} className="shrink-0 text-xs font-medium text-accent">{tx('撤销')}</button>
      </div>)}</div>}
      <p className="mt-3 text-[11px] leading-5 text-faint">{tx('「花钱」这一条锁着，永远先问你。其他的点一下就能改，审批卡上点「以后这类直接做」也会记在这里。')}</p>
    </section>
    <FoldersSection execution={execution} onRoots={roots => setRoots.mutate(roots)} />
    <AppsSection />
    <AccountsSection />
    {forTask.length > 0 && <section className="border-t border-line pt-5">
      <Head title={tx('这件事里你都同意过的')} count={forTask.length} />
      <div className="space-y-1">{forTask.map(g => <div key={g.id} className="flex items-center gap-2.5 py-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate">{g.label}<span className="text-faint"> · {g.title}</span></span>
        <button onClick={() => revoke.mutate(g.id)} disabled={revoke.isPending} className="shrink-0 text-xs text-muted hover:text-fg">{tx('撤回')}</button>
      </div>)}</div>
    </section>}
    <section className="border-t border-line pt-5">
      <Head title={tx('规则')} count={review.rules.length || undefined} action={rules == null && <LinkBtn onClick={() => setRules(review.rules.join('\n'))}>{review.rules.length ? tx('展开') : tx('写一条')}</LinkBtn>} />
      {rules != null ? <div className="space-y-2">
        <textarea autoFocus value={rules} onChange={e => setRules(e.target.value)} placeholder={tx('发邮件、发评论之前先让我看一眼。\n不要删任何文件。')} aria-label={tx('规则，每行一条')}
          className="min-h-24 w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm leading-6 outline-none focus:border-faint" />
        <div className="flex justify-end gap-1.5">
          <button onClick={() => setRules(null)} className="press h-8 rounded-full px-3 text-[13px] text-muted hover:bg-sunken">{tx('收起')}</button>
          <button onClick={() => saveReview.mutate({ rules: lines(rules) }, { onSuccess: () => setRules(null) })} disabled={saveReview.isPending || lines(rules).join() === review.rules.join()}
            className="press h-8 rounded-full bg-ink px-3.5 text-[13px] font-medium text-ink-fg disabled:opacity-50">{tx('保存')}</button>
        </div>
      </div> : review.rules.length > 0 && <ol className="space-y-1.5 text-sm">{review.rules.slice(0, 3).map((r, i) => <li key={i} className="flex gap-3"><span className="w-3 shrink-0 text-faint tabular-nums">{i + 1}</span><span className="min-w-0">{r}</span></li>)}</ol>}
      <div className="mt-2 flex min-h-10 items-center gap-3 text-sm">
        <span className="min-w-0 flex-1 text-muted">{tx('拿不准的事，交给它判断还是问你')}</span>
        <span className="relative shrink-0">
          <select value={review.mode} onChange={e => saveReview.mutate({ mode: e.target.value as ReviewSettings['mode'] })} aria-label={tx('拿不准的事')}
            className="h-7 cursor-pointer appearance-none rounded-full bg-sunken pr-7 pl-3 text-xs font-medium outline-none hover:bg-hero-2 focus-visible:ring-2 focus-visible:ring-accent">
            <option value="model">{tx('它判断')}</option><option value="ask">{tx('问你')}</option>
          </select>
          <ChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
        </span>
      </div>
    </section>
    <section className="border-t border-line pt-5">
      <Head title={tx('最近 7 天')} action={<LinkBtn onClick={() => setLog(v => !v)}>{log ? tx('收起') : tx('看记录')}</LinkBtn>} />
      <p className="text-sm tabular-nums">{tx('自己做了 {0} 次 · 问过你 {1} 次 · 你拒绝了 {2} 次', self, asked, refused)}</p>
      {log && <div className="mt-3 space-y-0.5">
        {!week.length ? <p className="py-2 text-sm text-faint">{tx('这 7 天没有要审核的事。')}</p> : week.slice(0, 40).map(e => <div key={e.id} className="flex gap-3 py-1.5 text-[13px]">
          <span className="w-[70px] shrink-0 text-xs text-faint tabular-nums">{ago(e.at)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">{e.input}</span>
            <span className={cx('text-xs', DECISION[e.decision]?.cls ?? 'text-muted')}>{DECISION[e.decision]?.label ?? e.decision}</span>{e.reason && <span className="text-xs text-faint"> · {e.reason}</span>}
          </span>
        </div>)}
        {week.length > 40 && <p className="pt-1 text-[11px] text-faint">{tx('更早的在 设置 · 数据和隐私 · 原始记录。')}</p>}
      </div>}
    </section>
  </div>
}

function Row({ icon, label, sub, children, tone }: { icon: React.ReactNode; label: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode; tone?: 'danger' }) {
  return <div className="flex min-h-11 items-center gap-3">
    <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken', tone === 'danger' ? 'text-accent' : 'text-muted')}>{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm">{label}</span>
      {sub && <span className="block truncate text-[11px] text-faint">{sub}</span>}
    </span>
    {children}
  </div>
}

/** A small select that reads like a pill: 直接做 ⌄. */
function Pick<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange(v: T): void; label: string }) {
  return <span className="relative shrink-0">
    <select value={value} onChange={e => onChange(e.target.value as T)} aria-label={label}
      className="h-7 cursor-pointer appearance-none rounded-full bg-sunken pr-7 pl-3 text-xs font-medium outline-none hover:bg-hero-2 focus-visible:ring-2 focus-visible:ring-accent">
      {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
    <ChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
  </span>
}

function useAccess() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['access'], queryFn: () => api.get<{ settings: AccessSettings; platform: string }>('/settings/access') })
  const save = useMutation({
    mutationFn: (patch: Partial<AccessSettings>) => api.put<{ settings: AccessSettings }>('/settings/access', patch),
    onMutate: patch => { qc.setQueryData<{ settings: AccessSettings; platform: string }>(['access'], old => old && { ...old, settings: { ...old.settings, ...patch } }) },
    onSettled: () => qc.invalidateQueries({ queryKey: ['access'] }),
  })
  return { settings: query.data?.settings, platform: query.data?.platform, save }
}

const short = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean).slice(-2).join(' / ') || p

/**
 * 文件夹 (Figma section 25, D): 能看的 (only look, or also change) and 永远不碰. Keys and credentials are never-touch by
 * default and locked. A folder it may change is also where it may start work.
 */
function FoldersSection({ execution, onRoots }: { execution: ExecutionSettings | undefined; onRoots(roots: string[]): void }) {
  const { settings, save } = useAccess()
  const [adding, setAdding] = useState<{ path: string; kind: 'read' | 'write' | 'never' } | null>(null)
  // Folders that were allowed before 权限 had its own list (执行环境's work folders) show here as 能改.
  useEffect(() => {
    if (!settings || !execution) return
    const missing = execution.workspaceRoots.filter(r => !settings.folders.some(f => f.path === r))
    if (missing.length) save.mutate({ folders: [...settings.folders, ...missing.map(path => ({ path, write: true }))] })
  }, [Boolean(settings), Boolean(execution)])
  if (!settings) return null
  const setFolders = (folders: AccessSettings['folders']) => {
    save.mutate({ folders })
    onRoots(folders.filter(f => f.write).map(f => f.path))
  }
  const add = () => {
    if (!adding) return
    const path = adding.path.trim()
    if (path) {
      if (adding.kind === 'never') { if (!settings.never.includes(path)) save.mutate({ never: [...settings.never, path] }) }
      else if (!settings.folders.some(f => f.path === path)) setFolders([...settings.folders, { path, write: adding.kind === 'write' }])
    }
    setAdding(null)
  }
  return <section className="border-t border-line pt-5">
    <Head title={tx('文件夹')} action={adding == null && <LinkBtn onClick={() => setAdding({ path: '', kind: 'read' })}><span className="flex items-center gap-0.5"><Plus size={12} />{tx('添加')}</span></LinkBtn>} />
    <div className="mb-1 text-[11px] text-faint">{tx('能看的')}</div>
    <div className="space-y-1">
      {!settings.folders.length && <p className="py-1 text-xs text-faint">{tx('还没有。它只在每件事自己的工作目录里做事。')}</p>}
      {settings.folders.map(f => <Row key={f.path} icon={<Folder size={16} />} label={short(f.path)} sub={f.path}>
        <Pick value={f.write ? 'write' : 'read'} label={tx('{0} 的权限', f.path)} onChange={v => v === 'remove' ? setFolders(settings.folders.filter(x => x.path !== f.path)) : setFolders(settings.folders.map(x => x.path === f.path ? { ...x, write: v === 'write' } : x))}
          options={[{ id: 'read', label: tx('只能看') }, { id: 'write', label: tx('能改') }, { id: 'remove', label: tx('不让碰了') }]} />
      </Row>)}
    </div>
    <div className="mt-3 mb-1 text-[11px] text-faint">{tx('永远不碰')}</div>
    <div className="space-y-1">
      {settings.never.map(p => <Row key={p} icon={<Ban size={16} />} tone="danger" label={short(p)} sub={p}>
        <button onClick={() => save.mutate({ never: settings.never.filter(x => x !== p) })} aria-label={tx('不再禁止 {0}', p)} className="press flex size-7 items-center justify-center rounded-full text-faint hover:bg-sunken hover:text-fg"><X size={14} /></button>
      </Row>)}
      <Row icon={<Ban size={16} />} tone="danger" label={tx('钥匙串和密钥')} sub={settings.locked.slice(0, 3).join(' · ')}>
        <span className="flex h-7 items-center gap-1 px-3 text-xs" title={settings.locked.join('\n')}>{tx('默认')}<Lock size={12} /></span>
      </Row>
    </div>
    {adding != null && <form className="anim-rise mt-2 space-y-1.5" onSubmit={e => { e.preventDefault(); add() }}>
      <input autoFocus value={adding.path} onChange={e => setAdding({ ...adding, path: e.target.value })} placeholder={tx('~/Documents/工作')} aria-label={tx('文件夹路径')}
        className="h-8 w-full rounded-full border border-line bg-panel px-3 font-mono text-[13px] outline-none focus:border-faint" />
      <div className="flex items-center gap-1.5">
        <Pick value={adding.kind} label={tx('这个文件夹')} onChange={kind => setAdding({ ...adding, kind })} options={[{ id: 'read', label: tx('只能看') }, { id: 'write', label: tx('能改') }, { id: 'never', label: tx('永远不碰') }]} />
        <span className="flex-1" />
        <button type="button" onClick={() => setAdding(null)} className="press h-8 rounded-full px-3 text-[13px] text-muted hover:bg-sunken">{tx('取消')}</button>
        <button type="submit" className="press h-8 rounded-full bg-ink px-3 text-[13px] font-medium text-ink-fg">{tx('加上')}</button>
      </div>
    </form>}
  </section>
}

const APPS: { id: LocalApp; label: string; icon: React.ReactNode }[] = [
  { id: 'calendar', label: tx('日历'), icon: <CalendarDays size={16} /> }, { id: 'reminders', label: tx('提醒事项'), icon: <ListChecks size={16} /> },
  { id: 'notes', label: tx('备忘录'), icon: <FileText size={16} /> }, { id: 'contacts', label: tx('通讯录'), icon: <Users size={16} /> }, { id: 'photos', label: tx('照片'), icon: <Image size={16} /> },
]
const APP_LEVELS: { id: AppLevel; label: string }[] = [{ id: 'auto', label: tx('直接做') }, { id: 'ask', label: tx('先问你') }, { id: 'read', label: tx('只能看') }, { id: 'off', label: tx('不允许') }]
const APP_SUB: Partial<Record<AppLevel, string>> = { ask: tx('看直接看，改要问你') }

/** 电脑上的 App: each of the owner's own apps at one level. Off a Mac only 日历 is here, through Google Calendar. */
function AppsSection() {
  const { settings, platform, save } = useAccess()
  if (!settings) return null
  const mac = platform === 'darwin'
  const apps = mac ? APPS : APPS.filter(a => a.id === 'calendar')
  return <section className="border-t border-line pt-5">
    <Head title={mac ? tx('电脑上的 App') : tx('日历')} />
    <div className="space-y-1">{apps.map(a => <Row key={a.id} icon={a.icon} label={mac ? a.label : tx('Google 日历')} sub={mac ? APP_SUB[settings.apps[a.id]] : tx('在 设置 · 来源 连上 Gmail 就能用')}>
      <Pick value={settings.apps[a.id]} label={a.label} options={APP_LEVELS} onChange={level => save.mutate({ apps: { ...settings.apps, [a.id]: level } })} />
    </Row>)}</div>
    {mac && <p className="mt-2 text-[11px] leading-5 text-faint">{tx('第一次用某个 App 时，macOS 会再问你一次。')}</p>}
  </section>
}

const SOURCE_ICON: Record<string, React.ReactNode> = { gmail: <Mail size={16} />, github: <GitBranch size={16} />, gdrive: <Cloud size={16} /> }
const SOURCE_SUB: Record<string, string> = { gmail: tx('发邮件仍然每次问你'), github: tx('发评论、推代码按上面的「往外发」') }

/** 连接的账号: what it may do in each account the owner connected (connecting happens in 设置 · 来源). */
function AccountsSection() {
  const { settings, save } = useAccess()
  const sources = (useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceInfo[] }>('/sources') }).data?.sources ?? []).filter(x => x.enabled && x.id !== 'cron')
  if (!settings || !sources.length) return null
  return <section className="border-t border-line pt-5">
    <Head title={tx('连接的账号')} />
    <div className="space-y-1">{sources.map(x => <Row key={x.id} icon={SOURCE_ICON[x.id] ?? <Globe size={16} />} label={x.title} sub={SOURCE_SUB[x.id]}>
      <Pick value={settings.sources[x.id] ?? 'act'} label={x.title} options={[{ id: 'read', label: tx('只能看') }, { id: 'act', label: tx('能操作') }]}
        onChange={v => save.mutate({ sources: { ...settings.sources, [x.id]: v } })} />
    </Row>)}</div>
  </section>
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
    <div role="dialog" aria-modal="true" aria-label={tx('糯糯')} className={phone
      ? cx('anim-sheet flex h-[86dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-panel pb-[env(safe-area-inset-bottom)] shadow-2xl', leaving && 'out-sheet')
      : cx('anim-drawer-r flex h-full w-[360px] flex-col overflow-hidden border-l border-line bg-panel shadow-2xl', leaving && 'out-r')}>
      <RightPane onClose={close} />
    </div>
  </div>
}
