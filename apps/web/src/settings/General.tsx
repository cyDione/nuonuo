/**
 * 通用 (Figma 21 · 11): starting with the computer and staying in the menu bar (desktop app), the language it speaks to
 * you in, and text size and motion on this device. Look and theme colour are in the quick settings.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Persona } from '../api'
import { setPrefs, usePrefs } from '../prefs'
import { isMacDesktop } from '../shell'
import { Choice, Page, Row, Section, SelectInput, Toggle } from './kit'
import { useDesktopPrefs } from './hooks'

const LANGUAGES: { id: Persona['language']; label: string }[] = [{ id: 'auto', label: '跟着你说的话' }, { id: 'zh', label: '中文' }, { id: 'en', label: 'English' }]

export function General() {
  const qc = useQueryClient()
  const prefs = usePrefs()
  const app = useDesktopPrefs()
  const persona = useQuery({ queryKey: ['persona'], queryFn: () => api.get<{ persona: Persona }>('/persona') }).data?.persona
  const setLanguage = useMutation({
    mutationFn: (language: Persona['language']) => api.put('/persona', { language }),
    onMutate: language => qc.setQueryData<{ persona: Persona }>(['persona'], old => old && { persona: { ...old.persona, language } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['persona'] }),
  })
  const name = persona?.name ?? '糯糯'
  return <Page title="通用">
    {app?.prefs && <Section title="启动">
      <Row label="开机时自动打开" sub="在后台打开，不弹窗口"><Toggle label="开机时自动打开" checked={app.prefs.openAtLogin} onChange={openAtLogin => app.save({ openAtLogin })} /></Row>
      <Row label={`在${isMacDesktop ? '菜单栏' : '任务栏通知区'}显示${name}`} sub="点一下就能叫出来，也看得到几件事在等你"><Toggle label="显示图标" checked={app.prefs.tray} onChange={tray => app.save({ tray })} /></Row>
      <Row label="关掉窗口时" sub="后台服务一直在跑，事情不会断">
        <SelectInput value={app.prefs.close} onChange={e => app.save({ close: e.target.value as 'hide' | 'quit' })}>
          <option value="hide">留在后台</option><option value="quit">退出应用</option>
        </SelectInput>
      </Row>
    </Section>}
    {persona && <Section title="语言" foot="界面目前只有中文。">
      <Row label="它跟你说话用" sub="跟着你说的话：你用什么语言写，它就用什么语言回">
        <SelectInput value={persona.language} onChange={e => setLanguage.mutate(e.target.value as Persona['language'])}>
          {LANGUAGES.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </SelectInput>
      </Row>
    </Section>}
    <Section title="文字和动效" foot="外观、主题色在快捷设置里。这两项只改这台设备。">
      <Row label="字号"><Choice label="字号" value={prefs.text} onChange={text => setPrefs({ text })} className="w-[220px]" options={[{ id: 'small', label: '小' }, { id: 'normal', label: '标准' }, { id: 'large', label: '大' }]} /></Row>
      <Row label="减少动态效果" sub="几乎不再有动画；系统里开了「减少动态效果」时也会这样"><Toggle label="减少动态效果" checked={prefs.reduceMotion} onChange={reduceMotion => setPrefs({ reduceMotion })} /></Row>
    </Section>
  </Page>
}
