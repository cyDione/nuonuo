/**
 * 设置窗口 (Figma v6, section 21; ⌘,): the whole window, with its own sidebar. 返回聊天 at the top (or Esc) goes back to
 * where you were; 搜索设置 narrows the list. Five groups: 助理 · 连接 · 安全 · 模型 · 应用. Pages here have no motion.
 * What lives elsewhere stays there (Figma v7): name, look, personality, soul and memory in the right pane's 它是谁; what it
 * may do on its own and the rules in the right pane's 权限. 主动程度, 点子, the sandbox and raw records are here (主动,
 * 安全和执行, 数据和隐私).
 */
import { Activity, AlarmClock, Bell, ChevronLeft, Cpu, Info, Keyboard, KeyRound, Lock, Mic, Plug, Puzzle, Search, Server, Settings as Cog, ShieldCheck, Smile } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { leaveSettings, type SettingsTab } from '../route'
import { isMacDesktop } from '../shell'
import { cx } from '../ui'
import { AssistantPage } from './Assistant'
import { Routines } from './Routines'
import { Sources } from './Sources'
import { Plugins } from './Plugins'
import { Mcp } from './Mcp'
import { Execution } from './Execution'
import { Providers } from './Providers'
import { Roles } from './Roles'
import { Usage } from './Usage'
import { General } from './General'
import { Notifications } from './Notifications'
import { Voice } from './Voice'
import { Shortcuts } from './Shortcuts'
import { DataPrivacy } from './DataPrivacy'
import { System } from './System'
import { tx } from '../i18n'

/** Each page, with the words on it that 搜索设置 should find. */
type Tab = { id: SettingsTab; label: string; icon: ReactNode; words: string }
const GROUPS: { title: string; tabs: Tab[] }[] = [
  { title: tx('助理'), tabs: [
    { id: 'persona', label: tx('主动'), icon: <Smile size={17} />, words: tx('主动 主动程度 多主动 只留意 点子 策略 节奏 同时 每天 不理会 账号 安静时间') },
    { id: 'routines', label: tx('定时任务'), icon: <AlarmClock size={17} />, words: tx('定时 cron 每天 简报 周报 提醒') },
  ] },
  { title: tx('连接'), tabs: [
    { id: 'sources', label: tx('来源'), icon: <Plug size={17} />, words: tx('GitHub Gmail Telegram 飞书 Discord 企业微信 钉钉 Slack RSS 授权 唤起词 仓库 同步 主动留意') },
    { id: 'plugins', label: tx('插件'), icon: <Puzzle size={17} />, words: tx('第三方 插件 plugins') },
    { id: 'mcp', label: tx('MCP 工具'), icon: <Server size={17} />, words: tx('MCP 工具 服务 notion filesystem') },
  ] },
  { title: tx('安全'), tabs: [
    { id: 'execution', label: tx('安全和执行'), icon: <ShieldCheck size={17} />, words: tx('审核 放行 拦截 正则 并发 超时 命令 Docker 沙箱 镜像 网络 禁止 云电脑 执行环境 本机 浏览器 Instabox 唤醒') },
  ] },
  { title: tx('模型'), tabs: [
    { id: 'providers', label: tx('模型供应商'), icon: <KeyRound size={17} />, words: tx('API key 密钥 Base URL 网关 价格 连通 OpenAI Anthropic') },
    { id: 'roles', label: tx('分层模型'), icon: <Cpu size={17} />, words: tx('主 Agent 执行 子任务 过滤 审核 看门狗 摘要 向量 视觉 备用 预算') },
    { id: 'usage', label: tx('用量'), icon: <Activity size={17} />, words: tx('调用 token 费用 缓存') },
  ] },
  { title: tx('应用'), tabs: [
    { id: 'general', label: tx('通用'), icon: <Cog size={17} />, words: tx('外观 浅色 深色 主题色 颜色 开机 启动 菜单栏 关掉窗口 语言 字号 动态效果') },
    { id: 'notifications', label: tx('通知'), icon: <Bell size={17} />, words: tx('通知 价格 动态 点子 确认 横幅 声音 Dock 数字 试一下') },
    { id: 'voice', label: tx('语音'), icon: <Mic size={17} />, words: tx('语音 输入 识别 语言 自动发送 朗读 声音 语速') },
    { id: 'shortcuts', label: tx('快捷键'), icon: <Keyboard size={17} />, words: tx('快捷键 叫出 快速问 搜索 新侧聊 主聊 右侧栏') },
    { id: 'data', label: tx('数据和隐私'), icon: <Lock size={17} />, words: tx('数据目录 隐私 聊天记录 保留 原始记录 事件 审计 审核记录 导出 清除 记忆') },
    { id: 'system', label: tx('系统和更新'), icon: <Info size={17} />, words: tx('版本 更新 渠道 服务 重启 密钥 网页版 局域网 端口 看门狗 环境检查') },
  ] },
]
const TABS = GROUPS.flatMap(g => g.tabs)

export function Settings({ tab, item }: { tab: SettingsTab; item?: string }) {
  const current = TABS.find(t => t.id === tab) ?? TABS[0]!
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return GROUPS
    return GROUPS.map(g => ({ ...g, tabs: g.tabs.filter(t => `${g.title} ${t.label} ${t.words}`.toLowerCase().includes(term)) })).filter(g => g.tabs.length)
  }, [q])

  // Esc goes back to the chat, unless it is closing something first (a field you are typing in, a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"]')) return
      const el = document.activeElement as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { el.blur(); return }
      leaveSettings()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { document.getElementById('settings-main')?.scrollTo(0, 0) }, [tab, item])

  return <div className="settings-static flex h-dvh bg-bg">
    <nav aria-label={tx('设置')} className="flex w-[232px] shrink-0 flex-col border-r border-line bg-sunken max-md:hidden">
      <div className={cx('drag flex h-[52px] shrink-0 items-center justify-end px-3', isMacDesktop && 'pl-[84px]')}>
        <button type="button" onClick={leaveSettings} className="no-drag flex h-[28px] items-center gap-0.5 rounded-[8px] bg-hero-2 pr-2.5 pl-1.5 text-[13px] font-medium hover:opacity-80">
          <ChevronLeft size={16} />{tx('返回聊天')} </button>
      </div>
      <div className="px-3 pb-2">
        <label className="flex h-[32px] items-center gap-2 rounded-[10px] bg-hero-2 px-2.5 text-muted">
          <Search size={15} className="shrink-0" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tx('搜索设置')} aria-label={tx('搜索设置')} className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {groups.map(g => <div key={g.title} className="mt-3 first:mt-1">
          <div className="px-2.5 pb-1 text-xs text-faint">{g.title}</div>
          {g.tabs.map(t => <a key={t.id} href={`#/settings/${t.id}`} aria-current={t.id === current.id ? 'page' : undefined}
            className={cx('flex h-[30px] items-center gap-2.5 rounded-[8px] px-2.5 text-sm', t.id === current.id ? 'bg-hero-2 font-medium' : 'hover:bg-hero-2/60')}>
            <span className="shrink-0 text-fg">{t.icon}</span>{t.label}</a>)}
        </div>)}
        {!groups.length && <p className="px-2.5 pt-3 text-xs text-faint">{tx('没有找到「{0}」', q.trim())}</p>}
      </div>
    </nav>

    <div id="settings-main" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      {/* Phones: back, and the pages as a list. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg px-4 pt-[env(safe-area-inset-top)] md:hidden">
        <button type="button" onClick={leaveSettings} className="flex h-12 items-center gap-0.5 text-sm"><ChevronLeft size={18} />{tx('返回')}</button>
        <select aria-label={tx('设置分区')} className="ml-auto h-9 rounded-[10px] bg-sunken px-2 text-sm" value={current.id} onChange={e => { location.hash = `/settings/${e.target.value}` }}>
          {GROUPS.map(g => <optgroup key={g.title} label={g.title}>{g.tabs.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>)}
        </select>
      </div>
      <div className="mx-auto max-w-[720px] px-4 pt-8 pb-16 md:px-8 md:pt-[52px]">
        {tab === 'persona' && <AssistantPage />}
        {tab === 'routines' && <Routines />}
        {tab === 'sources' && <Sources {...(item ? { item } : {})} />}
        {tab === 'plugins' && <Plugins />}
        {tab === 'mcp' && <Mcp {...(item ? { item } : {})} />}
        {tab === 'execution' && <Execution />}
        {tab === 'providers' && <Providers {...(item ? { item } : {})} />}
        {tab === 'roles' && <Roles {...(item ? { item } : {})} />}
        {tab === 'usage' && <Usage />}
        {tab === 'general' && <General />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'voice' && <Voice />}
        {tab === 'shortcuts' && <Shortcuts />}
        {tab === 'data' && <DataPrivacy />}
        {tab === 'system' && <System />}
      </div>
    </div>
  </div>
}
