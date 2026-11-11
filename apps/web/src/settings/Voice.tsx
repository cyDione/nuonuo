/**
 * 语音 (Figma 21 · 13): talking to it (the mic in the input bar, which language it listens for, sending when you pause)
 * and hearing it (reading replies aloud, the voice and the speed). Uses this device's own speech, so it is per device.
 */
import { useEffect, useState } from 'react'
import { usePersona } from '../persona'
import { setPrefs, usePrefs, type VoiceRate } from '../prefs'
import { speak, voices } from '../voice'
import { Btn, Choice, Page, Row, Section, SelectInput, Toggle } from './kit'
import { tx } from '../i18n'

const LANGS = [{ id: 'zh-CN', label: tx('中文（普通话）') }, { id: 'zh-TW', label: tx('中文（台湾）') }, { id: 'zh-HK', label: tx('粤语') }, { id: 'en-US', label: 'English' }, { id: 'ja-JP', label: tx('日本語') }]

export function Voice() {
  const prefs = usePrefs()
  const persona = usePersona()
  const [list, setList] = useState(voices)
  // Voices load late in some browsers.
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return
    const update = () => setList(voices())
    speechSynthesis.addEventListener('voiceschanged', update)
    return () => speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  const canListen = Boolean((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)
  const canSpeak = typeof speechSynthesis !== 'undefined'
  return <Page title={tx('语音')}>
    <Section title={tx('说话')} foot={canListen ? undefined : tx('这个浏览器没有语音识别，输入框里不会出现麦克风。')}>
      <Row label={tx('语音输入')} sub={tx('输入框右边的麦克风，点一下开始说')}><Toggle label={tx('语音输入')} checked={prefs.voiceInput} onChange={voiceInput => setPrefs({ voiceInput })} /></Row>
      <Row label={tx('识别语言')}>
        <SelectInput value={prefs.voiceLang} onChange={e => setPrefs({ voiceLang: e.target.value })}>{LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</SelectInput>
      </Row>
      <Row label={tx('说完自动发送')} sub={tx('停下 1.5 秒就发出去')}><Toggle label={tx('说完自动发送')} checked={prefs.autoSend} onChange={autoSend => setPrefs({ autoSend })} /></Row>
    </Section>
    <Section title={tx('朗读')} foot={canSpeak ? tx('只读你正在看的那段聊天里它的新回复，窗口在后台时不读。') : tx('这个浏览器不能朗读。')}>
      <Row label={tx('把回复读出来')}><Toggle label={tx('把回复读出来')} disabled={!canSpeak} checked={prefs.readAloud} onChange={readAloud => setPrefs({ readAloud })} /></Row>
      <Row label={tx('声音')}>
        <SelectInput value={prefs.voiceName} onChange={e => setPrefs({ voiceName: e.target.value })} className="w-[200px]" disabled={!canSpeak}>
          <option value="">{tx('系统默认')}</option>
          {list.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
        </SelectInput>
        <Btn disabled={!canSpeak} onClick={() => speak(tx('你好，我是{0}。今天想先做哪件事？', persona.name))}>{tx('试听')}</Btn>
      </Row>
      <Row label={tx('语速')}><Choice<VoiceRate> label={tx('语速')} value={prefs.voiceRate} onChange={voiceRate => setPrefs({ voiceRate })} className="w-[220px]" options={[{ id: 'slow', label: tx('慢') }, { id: 'normal', label: tx('正常') }, { id: 'fast', label: tx('快') }]} /></Row>
    </Section>
  </Page>
}
