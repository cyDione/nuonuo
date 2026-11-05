import { Activity, AlarmClock, Brain, Cpu, KeyRound, NotebookPen, Play, Plug, Puzzle, Server, ShieldCheck, Sparkles, Stethoscope } from 'lucide-react'
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

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode; intro: string }[] = [
  { id: 'providers', label: '模型供应商', icon: <KeyRound size={15} />, intro: 'API key 存放在系统钥匙串（或加密文件）中；也可以用环境变量（如 DEEPSEEK_API_KEY），启动时自动识别。密钥不进数据库、不进模型上下文，也不会传给任务的命令行环境。' },
  { id: 'roles', label: '分层模型', icon: <Cpu size={15} />, intro: '为每一层分别选择模型。没有配置的层沿用上一层；可设置备用模型与每日预算。' },
  { id: 'instructions', label: '说明', icon: <NotebookPen size={15} />, intro: '你给智能体的长期说明：怎么跟你说话、哪些事可以自己做、交付时要带上什么。每次修改都会存成新版本，可以随时恢复。对它说「以后……」它也会自己记到这里。' },
  { id: 'proactive', label: '主动', icon: <Sparkles size={15} />, intro: '没人找它的事件（GitHub 上的新 issue、CI 失败、群里的消息……）先经过程序规则，再由过滤层模型按你写的策略判断值不值得做。值得做的事在后台悄悄做，有价值才告诉你。' },
  { id: 'sources', label: '来源', icon: <Plug size={15} />, intro: '智能体从这些地方接收事件、在原处回复。在 GitHub 上用唤起词（默认 @agent）叫它，它以你的账号回复并带上机器人标记。' },
  { id: 'plugins', label: '插件', icon: <Puzzle size={15} />, intro: '插件为智能体增加新的来源（事件与回复渠道）和工具。内置 Telegram 与 Gmail；第三方插件放进数据目录的 plugins/ 下，启用后才会运行。' },
  { id: 'mcp', label: 'MCP 工具', icon: <Server size={15} />, intro: '接入 MCP（Model Context Protocol）服务，它们的工具会交给任务使用。会对外产生影响的服务建议保留「先经过审核」。' },
  { id: 'routines', label: '定时任务', icon: <AlarmClock size={15} />, intro: '按计划自动交给主 Agent 的任务。每个定时任务有自己的对话，结果出现在那里，左侧会显示未读。' },
  { id: 'review', label: '规则与审核', icon: <ShieldCheck size={15} />, intro: '任务要做有后果的事（推送、发布、发评论、删除、向外发数据）时，先经过规则和审核模型；拿不准的交给你批准，命令在你批准后才执行。每一次决定都记录在下面。' },
  { id: 'memory', label: '记忆', icon: <Brain size={15} />, intro: '长期记忆分三层，以 Markdown 文件存放在数据目录的 memory/ 下，可以直接编辑。对智能体说「记住…」「忘掉…」也可以。' },
  { id: 'execution', label: '执行', icon: <Play size={15} />, intro: '任务（Worker）在本机执行：每个任务有自己的工作目录。这里控制并发、命令超时与允许使用的已有目录。' },
  { id: 'usage', label: '用量', icon: <Activity size={15} />, intro: '按层与模型统计调用次数、token 与估算费用（在供应商中填写价格后显示费用）。' },
  { id: 'system', label: '系统', icon: <Stethoscope size={15} />, intro: '本机服务状态与运行环境检查。' },
]

export function Settings({ tab }: { tab: SettingsTab }) {
  const current = TABS.find(t => t.id === tab)!
  return <div className="flex h-full flex-col">
    <header className="shrink-0 border-b border-line px-6 pt-5">
      <h1 className="text-lg font-semibold">设置</h1>
      <div className="mt-3 flex gap-1 overflow-x-auto">
        {TABS.map(t => <a key={t.id} href={`#/settings/${t.id}`} className={cx('flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm whitespace-nowrap',
          t.id === tab ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>{t.icon}{t.label}</a>)}
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
        <p className="text-sm text-muted">{current.intro}</p>
        {tab === 'providers' && <Providers />}
        {tab === 'roles' && <Roles />}
        {tab === 'instructions' && <InstructionsPage />}
        {tab === 'proactive' && <ProactivePage />}
        {tab === 'sources' && <Sources />}
        {tab === 'plugins' && <Plugins />}
        {tab === 'mcp' && <Mcp />}
        {tab === 'routines' && <Routines />}
        {tab === 'review' && <Review />}
        {tab === 'memory' && <MemoryPage />}
        {tab === 'execution' && <Execution />}
        {tab === 'usage' && <Usage />}
        {tab === 'system' && <System />}
      </div>
    </div>
  </div>
}
