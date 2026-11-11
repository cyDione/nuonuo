/**
 * 通知 (Figma 21 · 12): which changes reach you as a banner, and how — banner, sound, the number on the app icon — with a
 * test. Things waiting for your OK always notify. Quiet hours are on 助理.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type IdeaSettings, type NotifySettings } from '../api'
import { notificationsEnabled, setNotifications } from '../live'
import { usePersona } from '../persona'
import { desktop, isMacDesktop } from '../shell'
import { Btn, Page, Row, Section, SelectInput, Toggle } from './kit'
import { playChime } from '../sounds'
import { useNotify } from './hooks'
import { tx } from '../i18n'

const CADENCE: Record<IdeaSettings['cadence'], string> = { daily: tx('每天早上一批'), weekly: tx('每周一批'), off: tx('点子已经关了') }

export function Notifications() {
  const persona = usePersona()
  const notify = useNotify()
  const ideas = useQuery({ queryKey: ['ideas'], queryFn: () => api.get<{ settings: IdeaSettings }>('/ideas') }).data?.settings
  const [browser, setBrowser] = useState(notificationsEnabled())
  const supported = typeof Notification !== 'undefined'
  const test = useMutation({
    mutationFn: async () => {
      if (!desktop && !browser) { const on = await setNotifications(true); setBrowser(on); if (!on) throw new Error(tx('浏览器没有允许通知')) }
      return api.post('/notifications/test')
    },
  })
  const s = notify.data?.settings
  if (!s) return <Page title={tx('通知')}><div /></Page>
  const toggle = (key: keyof Omit<NotifySettings, 'quiet' | 'tone'>, label: string, sub?: string) =>
    <Row label={label} sub={sub}><Toggle label={label} checked={s[key]} onChange={v => notify.save({ [key]: v })} /></Row>
  return <Page title={tx('通知')}>
    {!desktop && <Section title={tx('这个浏览器')} foot={tx('网页在后台时，用系统通知告诉你；在前台时不打扰。')}>
      <Row label={tx('允许这个浏览器弹通知')} sub={!supported ? tx('这个浏览器不支持通知') : browser ? tx('已允许') : tx('打开后浏览器会问你一次')}>
        <Toggle label={tx('允许这个浏览器弹通知')} disabled={!supported} checked={browser} onChange={async on => setBrowser(await setNotifications(on))} />
      </Row>
    </Section>}
    <Section title={tx('什么时候叫你')}>
      {toggle('message', tx('{0}跟你说话', persona.name), tx('回复、做完的事、定时任务的结果'))}
      {toggle('price', tx('价格、到货提醒'), tx('它盯着的数字有了变化'))}
      {toggle('feed', tx('动态有新的一条'))}
      {toggle('ideas', tx('点子'), ideas ? CADENCE[ideas.cadence] : undefined)}
      <Row label={tx('等你确认的事')} sub={tx('花钱、发出去之前要你点头')}><span className="text-[13px] text-faint">{tx('一直通知，不能关')}</span></Row>
    </Section>
    <Section title={tx('怎么叫你')} foot={tx('安静时间在「主动」里设，那段时间只有等你确认的事会叫你。')}>
      {toggle('banner', tx('横幅'), tx('关掉后只有等你确认的事会弹出来'))}
      {toggle('sound', tx('声音'))}
      {s.sound && <Row label={tx('提示音')} sub={s.tone === 'nuonuo' ? tx('{0}自己的声音：说话升两个音，等你确认的升三个', persona.name) : tx('用系统的通知声音')}>
        <span className="flex items-center gap-2">
          {s.tone === 'nuonuo' && <Btn onClick={() => playChime('message')}>{tx('试听')}</Btn>}
          <SelectInput value={s.tone} onChange={e => notify.save({ tone: e.target.value as NotifySettings['tone'] })}>
            <option value="nuonuo">{tx('{0}的', persona.name)}</option><option value="system">{tx('系统的')}</option>
          </SelectInput>
        </span>
      </Row>}
      {desktop && toggle('badge', isMacDesktop ? tx('Dock 图标上的数字') : tx('任务栏图标上的数字'), tx('有几件事在等你'))}
      <Row label={tx('试一下')} sub={test.error ? <span className="text-danger">{(test.error as Error).message}</span> : test.isSuccess ? tx('发出去了{0}', !desktop ? tx('；看不到的话，检查一下系统的通知设置') : '') : undefined}>
        <Btn disabled={test.isPending || (!desktop && !supported)} onClick={() => test.mutate()}>{tx('发一条测试通知')}</Btn>
      </Row>
    </Section>
  </Page>
}
