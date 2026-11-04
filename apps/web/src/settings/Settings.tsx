import { Activity, Cpu, KeyRound, Stethoscope } from 'lucide-react'
import type { SettingsTab } from '../route'
import { cx } from '../ui'
import { Providers } from './Providers'
import { Roles } from './Roles'
import { System } from './System'
import { Usage } from './Usage'

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode; intro: string }[] = [
  { id: 'providers', label: '模型供应商', icon: <KeyRound size={15} />, intro: 'API key 存放在系统钥匙串（或加密文件）中，不进入数据库，也不会进入模型上下文。' },
  { id: 'roles', label: '分层模型', icon: <Cpu size={15} />, intro: '为每一层分别选择模型。没有配置的层沿用上一层；可设置备用模型与每日预算。' },
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
        {tab === 'usage' && <Usage />}
        {tab === 'system' && <System />}
      </div>
    </div>
  </div>
}
