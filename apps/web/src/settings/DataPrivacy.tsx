/**
 * 数据和隐私 (Figma 21 · 15): where everything is kept (only on this computer), how long chats are kept, the raw records
 * (events and review decisions, v7), exporting it all, and clearing memories or chats. Clearing asks first and cannot be undone.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Health, type PrivacySettings } from '../api'
import { desktop, isMacDesktop } from '../shell'
import { setPrefs, usePrefs } from '../prefs'
import { Btn, Page, Row, Section, SelectInput, Toggle } from './kit'
import { RawRecords } from './RawRecords'
import { tx } from '../i18n'

const KEEP: { id: PrivacySettings['keep']; label: string }[] = [{ id: 'forever', label: tx('一直保留') }, { id: '365', label: tx('一年') }, { id: '90', label: tx('90 天') }, { id: '30', label: tx('30 天') }]

export function DataPrivacy() {
  const qc = useQueryClient()
  const prefs = usePrefs()
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health') }).data
  const privacy = useQuery({ queryKey: ['privacy'], queryFn: () => api.get<{ settings: PrivacySettings }>('/settings/privacy') }).data?.settings
  const setKeep = useMutation({ mutationFn: (keep: PrivacySettings['keep']) => api.put('/settings/privacy', { keep }), onSettled: () => qc.invalidateQueries({ queryKey: ['privacy'] }) })
  const [copied, setCopied] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const clearMemories = useMutation({ mutationFn: () => api.del<{ removed: number }>('/memories'),
    onSuccess: r => { setDone(tx('清掉了 {0} 条记忆。', r?.removed ?? 0)); qc.invalidateQueries({ queryKey: ['memories'] }) } })
  const clearChats = useMutation({ mutationFn: () => api.del<{ removed: number }>('/conversations'),
    onSuccess: r => { setDone(tx('清掉了 {0} 条聊天记录。', r?.removed ?? 0)); qc.invalidateQueries() } })
  const reveal = async () => {
    if (!health) return
    if (desktop?.reveal) { await desktop.reveal(health.home); return }
    await navigator.clipboard?.writeText(health.home).catch(() => {})
    setCopied(true)
  }
  return <Page title={tx('数据和隐私')}>
    <Section title={tx('存在哪里')}>
      <Row label={tx('数据目录')} sub={<span className="font-mono break-all">{health?.home ?? '…'}</span>}>
        <Btn onClick={reveal} disabled={!health}>{desktop?.reveal ? (isMacDesktop ? tx('在访达中显示') : tx('打开文件夹')) : copied ? tx('已复制') : tx('复制路径')}</Btn>
      </Row>
      <Row label={tx('只在这台电脑上')} sub={tx('聊天、记忆和文件都存在这里；只有调用模型时，才把那一段对话发给你选的模型服务')} />
    </Section>
    {privacy && <Section title={tx('记录')} foot={tx('超过期限的聊天每小时清理一次，主聊会留着但变短。')}>
      <Row label={tx('聊天记录保留')}>
        <SelectInput value={privacy.keep} onChange={e => { const keep = e.target.value as PrivacySettings['keep']; if (keep === 'forever' || confirm(tx('超过{0}的聊天记录会被删掉，不能恢复。继续？', KEEP.find(k => k.id === keep)!.label))) setKeep.mutate(keep) }}>
          {KEEP.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
        </SelectInput>
      </Row>
      <Row label={tx('显示原始记录')} sub={tx('给技术用户：聊天里显示它每一步调了什么')}><Toggle label={tx('显示原始记录')} checked={prefs.showRaw} onChange={showRaw => setPrefs({ showRaw })} /></Row>
    </Section>}
    <RawRecords />
    <Section title={tx('导出和清除')} foot={done ?? tx('清除之后不能恢复。想留一份，先导出。')}>
      <Row label={tx('导出全部数据')} sub={tx('聊天、记忆、目标、动态、定时任务和做过的事，一个 JSON 文件；不含 API key')}>
        <a href="/api/export" download className="inline-flex h-[28px] items-center rounded-[8px] border border-line bg-card px-3 text-[13px] font-medium hover:border-faint">{tx('导出')}</a>
      </Row>
      <Row label={tx('清除全部记忆')} sub={tx('它记得的关于你的事，包括等你确认的')}>
        <Btn tone="danger" disabled={clearMemories.isPending} onClick={() => { if (confirm(tx('清除它记得的全部内容？不能恢复。'))) clearMemories.mutate() }}>{tx('清除')}</Btn>
      </Row>
      <Row label={tx('清除全部聊天')} sub={tx('所有侧聊和主聊里的消息；还在做的事会停下')}>
        <Btn tone="danger" disabled={clearChats.isPending} onClick={() => { if (confirm(tx('清除全部聊天记录？侧聊会被删掉，主聊会清空，还在做的事会停下。不能恢复。'))) clearChats.mutate() }}>{tx('清除')}</Btn>
      </Row>
      {(clearMemories.error || clearChats.error) && <Row label={<span className="text-danger">{((clearMemories.error ?? clearChats.error) as Error).message}</span>} />}
    </Section>
  </Page>
}
