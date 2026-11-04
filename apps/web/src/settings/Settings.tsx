import { Activity, Cpu, KeyRound, Play, Stethoscope } from 'lucide-react'
import type { SettingsTab } from '../route'
import { cx } from '../ui'
import { Providers } from './Providers'
import { Roles } from './Roles'
import { System } from './System'
import { Usage } from './Usage'
import { Execution } from './Execution'

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode; intro: string }[] = [
  { id: 'providers', label: '模型供应商', icon: <KeyRound size={15} />, intro: 'API key 存放在系统钥匙串（或加密文件）中；也可以用环境变量（如 DEEPSEEK_API_KEY），启动时自动识别。密钥不进数据库、不进模型上下文，也不会传给任务的命令行环境。' },
  { id: 'roles', label: '分层模型', icon: <Cpu size={15} />, intro: '为每一层分别选择模型。没有配置的层沿用上一层；可设置备用模型与每日预算。' },
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
        {tab === 'execution' && <Execution />}
        {tab === 'usage' && <Usage />}
        {tab === 'system' && <System />}
      </div>
    </div>
  </div>
}
