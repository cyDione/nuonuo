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
import { Btn, Page, Row, Section, Toggle } from './kit'
import { useNotify } from './hooks'

const CADENCE: Record<IdeaSettings['cadence'], string> = { daily: '每天早上一批', weekly: '每周一批', off: '点子已经关了' }

export function Notifications() {
  const persona = usePersona()
  const notify = useNotify()
  const ideas = useQuery({ queryKey: ['ideas'], queryFn: () => api.get<{ settings: IdeaSettings }>('/ideas') }).data?.settings
  const [browser, setBrowser] = useState(notificationsEnabled())
  const supported = typeof Notification !== 'undefined'
  const test = useMutation({
    mutationFn: async () => {
      if (!desktop && !browser) { const on = await setNotifications(true); setBrowser(on); if (!on) throw new Error('浏览器没有允许通知') }
      return api.post('/notifications/test')
    },
  })
  const s = notify.data?.settings
  if (!s) return <Page title="通知"><div /></Page>
  const toggle = (key: keyof Omit<NotifySettings, 'quiet'>, label: string, sub?: string) =>
    <Row label={label} sub={sub}><Toggle label={label} checked={s[key]} onChange={v => notify.save({ [key]: v })} /></Row>
  return <Page title="通知">
    {!desktop && <Section title="这个浏览器" foot="网页在后台时，用系统通知告诉你；在前台时不打扰。">
      <Row label="允许这个浏览器弹通知" sub={!supported ? '这个浏览器不支持通知' : browser ? '已允许' : '打开后浏览器会问你一次'}>
        <Toggle label="允许这个浏览器弹通知" disabled={!supported} checked={browser} onChange={async on => setBrowser(await setNotifications(on))} />
      </Row>
    </Section>}
    <Section title="什么时候叫你">
      {toggle('message', `${persona.name}跟你说话`, '回复、做完的事、定时任务的结果')}
      {toggle('price', '价格、到货提醒', '它盯着的数字有了变化')}
      {toggle('feed', '动态有新的一条')}
      {toggle('ideas', '点子', ideas ? CADENCE[ideas.cadence] : undefined)}
      <Row label="等你确认的事" sub="花钱、发出去之前要你点头"><span className="text-[13px] text-faint">一直通知，不能关</span></Row>
    </Section>
    <Section title="怎么叫你" foot="安静时间在「主动」里设，那段时间只有等你确认的事会叫你。">
      {toggle('banner', '横幅', '关掉后只有等你确认的事会弹出来')}
      {toggle('sound', '声音')}
      {desktop && toggle('badge', isMacDesktop ? 'Dock 图标上的数字' : '任务栏图标上的数字', '有几件事在等你')}
      <Row label="试一下" sub={test.error ? <span className="text-danger">{(test.error as Error).message}</span> : test.isSuccess ? `发出去了${!desktop ? '；看不到的话，检查一下系统的通知设置' : ''}` : undefined}>
        <Btn disabled={test.isPending || (!desktop && !supported)} onClick={() => test.mutate()}>发一条测试通知</Btn>
      </Row>
    </Section>
  </Page>
}
