import { Activity, AlarmClock, Brain, Cpu, KeyRound, NotebookPen, Play, Plug, Puzzle, Server, ShieldCheck, Smile, Sparkles, Stethoscope } from 'lucide-react'
import type { SettingsTab } from '../route'
import { cx } from '../ui'
import { Providers } from './Providers'
import { Roles } from './Roles'
import { System } from './System'
import { Usage } from './Usage'
import { Execution } from './Execution'
import { Routines } from './Routines'
import { Review } from './Review'
import { MemoryPage } from './MemoryPage'
import { Plugins } from './Plugins'
import { Mcp } from './Mcp'
import { Sources } from './Sources'
import { InstructionsPage } from './Instructions'
import { ProactivePage } from './Proactive'
import { PersonaPage } from './PersonaPage'

type Tab = { id: SettingsTab; label: string; icon: React.ReactNode; intro: string }
/** Settings grouped by what they are about: the assistant itself, what it does on a schedule, what it connects to, how it is kept safe, which models it runs on. */
const GROUPS: { title: string; tabs: Tab[] }[] = [
  { title: '助手', tabs: [
    { id: 'persona', label: '个性', icon: <Smile size={15} />, intro: '它的名字、头像和说话的样子。' },
    { id: 'instructions', label: '说明', icon: <NotebookPen size={15} />, intro: '你给它的长期说明：怎么跟你说话、哪些事可以自己做、交付时要带上什么。每次修改都存成新版本，可以随时恢复。对它说「以后……」它也会自己记到这里。' },
    { id: 'memory', label: '记忆', icon: <Brain size={15} />, intro: '它记住的关于你、关于各个项目的事。你的原话直接记住；从别人那里看到的、或者它不太确定的，先放进「等你确认」。对话安静一会儿后，它会自动从对话里整理值得记住的事。' },
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
  const current = TABS.find(t => t.id === tab) ?? TABS[0]!
  return <div className="flex h-full">
    <nav className="w-52 shrink-0 space-y-4 overflow-y-auto border-r border-line px-3 py-5 max-md:hidden">
      <h1 className="px-2 text-lg font-semibold">设置</h1>
      {GROUPS.map(g => <div key={g.title}>
        <div className="px-2 pb-1 text-[11px] font-medium text-faint">{g.title}</div>
        {g.tabs.map(t => <a key={t.id} href={`#/settings/${t.id}`} className={cx('flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm',
          t.id === current.id ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-sunken hover:text-fg')}>{t.icon}{t.label}</a>)}
      </div>)}
    </nav>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
        <div className="md:hidden"><select className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm" value={current.id} onChange={e => { location.hash = `/settings/${e.target.value}` }}>
          {GROUPS.map(g => <optgroup key={g.title} label={g.title}>{g.tabs.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>)}
        </select></div>
        {!item && <header><h2 className="text-lg font-semibold">{current.label}</h2><p className="mt-1 text-sm text-muted">{current.intro}</p></header>}
        {tab === 'persona' && <PersonaPage />}
        {tab === 'instructions' && <InstructionsPage />}
        {tab === 'memory' && <MemoryPage />}
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
}
