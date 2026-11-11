/**
 * 快捷键 (Figma 21 · 14): shortcuts that work anywhere (desktop app: bring up the window, quick ask) and inside the window.
 * Click a key box and press the new combination to change it; Delete clears it, Esc keeps the old one.
 */
import { useEffect, useState } from 'react'
import { usePersona } from '../persona'
import { comboOf, DEFAULT_KEYS, keyLabel, setPrefs, usePrefs, type Keys as KeyMap } from '../prefs'
import { desktop } from '../shell'
import { Btn, Keys, Page, Row, Section } from './kit'
import { useDesktopPrefs } from './hooks'
import { tx } from '../i18n'

type Target = { scope: 'window'; key: keyof KeyMap } | { scope: 'global'; key: 'summon' | 'quick' }
const WINDOW: { key: keyof KeyMap; label: string }[] = [
  { key: 'search', label: tx('搜索') }, { key: 'newChat', label: tx('新侧聊') }, { key: 'mainChat', label: tx('回到主聊') }, { key: 'pane', label: tx('打开右侧栏') }, { key: 'settings', label: tx('设置') },
]
/** The desktop app takes Electron accelerators: Mod is CommandOrControl, Ctrl is Control. */
const accelerator = (combo: string) => combo.split('+').map(k => (k === 'Mod' ? 'CommandOrControl' : k === 'Ctrl' ? 'Control' : k)).join('+')

export function Shortcuts() {
  const prefs = usePrefs()
  const persona = usePersona()
  const app = useDesktopPrefs()
  const [recording, setRecording] = useState<Target | null>(null)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); return }
      const combo = e.key === 'Backspace' || e.key === 'Delete' ? '' : comboOf(e)
      if (combo === null) return
      if (recording.scope === 'window') setPrefs({ keys: { ...prefs.keys, [recording.key]: combo } })
      else app?.save({ [recording.key]: combo && accelerator(combo) })
      setRecording(null)
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [recording])
  const isRec = (t: Target) => recording?.scope === t.scope && recording.key === t.key
  const changed = WINDOW.some(w => prefs.keys[w.key] !== DEFAULT_KEYS[w.key])
  return <Page title={tx('快捷键')}>
    <Section title={tx('在哪都能用')} foot={desktop ? undefined : tx('这一组只有桌面版有：在别的应用里也能叫出它。')}>
      {(['summon', 'quick'] as const).map(key => { const t: Target = { scope: 'global', key }
        const value = app?.prefs?.[key] ?? ''
        const taken = app?.prefs && value && app.prefs.registered[key] === false
        return <Row key={key} label={key === 'summon' ? tx('叫出{0}', persona.name) : tx('快速问一句')}
          sub={taken ? <span className="text-danger">{tx('这个组合被别的应用占了，换一个')}</span> : key === 'summon' ? tx('打开主窗口') : tx('屏幕上方弹出一个小框，问完就收起')}>
          <Keys keys={keyLabel(value)} active={isRec(t)} label={tx('修改：{0}', key)} {...(app ? { onClick: () => setRecording(t) } : {})} />
        </Row> })}
    </Section>
    <Section title={tx('窗口里')} foot={<>{tx('点按键框，再按新的组合键就改好了；按 Delete 清掉，Esc 不改。浏览器自己占用的组合（比如 ⌘N）在网页版里可能不灵，换一个就好。')}{changed && <Btn className="ml-2 align-middle" onClick={() => setPrefs({ keys: DEFAULT_KEYS })}>{tx('恢复默认')}</Btn>}</>}>
      {WINDOW.map(w => { const t: Target = { scope: 'window', key: w.key }
        return <Row key={w.key} label={w.label}><Keys keys={keyLabel(prefs.keys[w.key])} active={isRec(t)} label={tx('修改：{0}', w.label)} onClick={() => setRecording(t)} /></Row> })}
    </Section>
  </Page>
}
