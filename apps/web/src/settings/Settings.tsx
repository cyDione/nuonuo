import { Activity, AlarmClock, Cpu, KeyRound, Play, Plug, Puzzle, Server, ShieldCheck, Sparkles, Stethoscope } from 'lucide-react'
import { Smile } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { SettingsTab } from '../route'
import { cx } from '../ui'
import { Providers } from './Providers'
import { Roles } from './Roles'
import { System } from './System'
import { Usage } from './Usage'
import { Execution } from './Execution'
import { Routines } from './Routines'
import { Review } from './Review'
import { Plugins } from './Plugins'
import { Mcp } from './Mcp'
import { Sources } from './Sources'
import { ProactivePage } from './Proactive'
import { PersonaPage } from './PersonaPage'

type Tab = { id: SettingsTab; label: string; icon: React.ReactNode; intro: string }
/** Settings grouped by what they are about: the assistant itself, what it does on a schedule, what it connects to, how it is kept safe, which models it runs on. */
const GROUPS: { title: string; tabs: Tab[] }[] = [
  { title: '助理', tabs: [
    { id: 'persona', label: '名字和样子', icon: <Smile size={15} />, intro: '' },
    { id: 'proactive', label: '主动', icon: <Sparkles size={15} />, intro: '没人找它的事件（GitHub 上的新 issue、CI 失败、群里的消息……）先过程序规则，再由过滤层模型按你写的策略判断值不值得做。值得做的在后台悄悄做，有价值才在主对话里告诉你。' },
  ] },
  { title: '自动化', tabs: [
    { id: 'routines', label: '定时任务', icon: <AlarmClock size={15} />, intro: '按计划自动交给它的事。到点后它在主对话里处理，结果也发在那里。也可以直接对它说「每天早上 9 点……」。' },
  ] },
  { title: '连接', tabs: [
    { id: 'sources', label: '来源', icon: <Plug size={15} />, intro: '它从这些地方接收事件、在原处回复。在 GitHub 上用唤起词（默认 @agent）叫它，它以你的账号回复并带上机器人标记。' },
    { id: 'plugins', label: '插件', icon: <Puzzle size={15} />, intro: '插件为它增加新的来源（事件与回复渠道）和工具。内置 Telegram 与 Gmail；第三方插件放进数据目录的 plugins/ 下，启用后才会运行。' },
    { id: 'mcp', label: 'MCP 工具', icon: <Server size={15} />, intro: '接入 MCP（Model Context Protocol）服务，它们的工具会交给任务使用。会对外产生影响的服务建议保留「先经过审核」。' },
  ] },
  { title: '安全', tabs: [
    { id: 'review', label: '规则与审核', icon: <ShieldCheck size={15} />, intro: '它要做有后果的事（推送、发布、发评论、删除、向外发数据）时，先经过规则和审核模型；拿不准的交给你批准，你批准后才执行。读取凭据的命令一律禁止。每一次决定都记录在下面。' },
    { id: 'execution', label: '执行环境', icon: <Play size={15} />, intro: '任务在本机执行：每件事有自己的工作目录。这里控制并发、命令超时、允许使用的已有目录，以及 Docker 沙箱。' },
  ] },
  { title: '模型', tabs: [
    { id: 'providers', label: '模型供应商', icon: <KeyRound size={15} />, intro: 'API key 存放在系统钥匙串（或加密文件）中；也可以用环境变量（如 OPENAI_API_KEY），启动时自动识别。密钥不进数据库、不进模型上下文，也不会传给任务的命令行环境。' },
    { id: 'roles', label: '分层模型', icon: <Cpu size={15} />, intro: '为每一层分别选择模型。没有配置的层沿用上一层；可设置备用模型与每日预算。' },
    { id: 'usage', label: '用量', icon: <Activity size={15} />, intro: '按层与模型统计调用次数、token 与估算费用（在供应商中填写价格后显示费用）。' },
  ] },
  { title: '系统', tabs: [
    { id: 'system', label: '系统', icon: <Stethoscope size={15} />, intro: '本机服务状态与运行环境检查。' },
  ] },
]
const TABS = GROUPS.flatMap(g => g.tabs)

export function Settings({ tab, item }: { tab: SettingsTab; item?: string }) {
  const current = TABS.find(t => t.id === tab) ?? TABS.find(t => t.id === 'providers')!
  // The block that slides to the open section, like the sidebar's.
  const navRef = useRef<HTMLElement>(null)
  const [mark, setMark] = useState<{ y: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const nav = navRef.current, el = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    setMark(nav && el ? { y: el.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop, h: el.offsetHeight } : null)
  }, [current.id])
  return <div className="flex h-full">
    <nav ref={navRef} className="relative w-56 shrink-0 space-y-5 overflow-y-auto border-r border-line px-3 pt-4 pb-6 max-md:hidden" aria-label="设置">
      {mark && <span className="nav-indicator pointer-events-none absolute right-3 left-3 top-0 rounded-xl bg-sunken" style={{ transform: `translateY(${mark.y}px)`, height: mark.h }} aria-hidden />}
      <h1 className="px-2 font-display text-2xl font-semibold">设置</h1>
      {GROUPS.map(g => <div key={g.title} className="relative">
        <div className="eyebrow px-2 pb-1.5">{g.title}</div>
        {g.tabs.map(t => <a key={t.id} href={`#/settings/${t.id}`} aria-current={t.id === current.id ? 'page' : undefined} className={cx('press relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm',
          t.id === current.id ? 'font-medium text-fg' : 'text-muted hover:bg-sunken/60 hover:text-fg')}>
          <span className={cx('shrink-0 transition-colors duration-200', t.id === current.id && 'text-accent')}>{t.icon}</span>{t.label}</a>)}
      </div>)}
    </nav>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 md:px-8 md:py-8">
        <div className="md:hidden"><select aria-label="设置分区" className="h-11 w-full rounded-xl border border-line bg-panel px-3 text-sm" value={current.id} onChange={e => { location.hash = `/settings/${e.target.value}` }}>
          {GROUPS.map(g => <optgroup key={g.title} label={g.title}>{g.tabs.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>)}
        </select></div>
        {!item && <header key={current.id} className="anim-rise">
          <h2 className="font-display text-3xl font-semibold text-balance">{current.label}</h2>
        </header>}
        <div key={`${current.id}/${item ?? ''}`} className="anim-rise space-y-4 [animation-delay:40ms]">
          {tab === 'persona' && <PersonaPage />}
          {tab === 'proactive' && <ProactivePage />}
          {tab === 'routines' && <Routines />}
          {tab === 'sources' && <Sources {...(item ? { item } : {})} />}
          {tab === 'plugins' && <Plugins />}
          {tab === 'mcp' && <Mcp />}
          {tab === 'review' && <Review />}
          {tab === 'execution' && <Execution />}
          {tab === 'providers' && <Providers />}
          {tab === 'roles' && <Roles {...(item ? { item } : {})} />}
          {tab === 'usage' && <Usage />}
          {tab === 'system' && <System />}
        </div>
      </div>
    </div>
  </div>
}
