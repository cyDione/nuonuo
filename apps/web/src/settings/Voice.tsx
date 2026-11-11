/**
 * 语音 (Figma 21 · 13): talking to it (the mic in the input bar, which language it listens for, sending when you pause)
 * and hearing it (reading replies aloud, the voice and the speed). Uses this device's own speech, so it is per device.
 */
import { useEffect, useState } from 'react'
import { usePersona } from '../persona'
import { setPrefs, usePrefs, type VoiceRate } from '../prefs'
import { speak, voices } from '../voice'
import { Btn, Choice, Page, Row, Section, SelectInput, Toggle } from './kit'

const LANGS = [{ id: 'zh-CN', label: '中文（普通话）' }, { id: 'zh-TW', label: '中文（台湾）' }, { id: 'zh-HK', label: '粤语' }, { id: 'en-US', label: 'English' }, { id: 'ja-JP', label: '日本語' }]

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
  return <Page title="语音">
    <Section title="说话" foot={canListen ? undefined : '这个浏览器没有语音识别，输入框里不会出现麦克风。'}>
      <Row label="语音输入" sub="输入框右边的麦克风，点一下开始说"><Toggle label="语音输入" checked={prefs.voiceInput} onChange={voiceInput => setPrefs({ voiceInput })} /></Row>
      <Row label="识别语言">
        <SelectInput value={prefs.voiceLang} onChange={e => setPrefs({ voiceLang: e.target.value })}>{LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</SelectInput>
      </Row>
      <Row label="说完自动发送" sub="停下 1.5 秒就发出去"><Toggle label="说完自动发送" checked={prefs.autoSend} onChange={autoSend => setPrefs({ autoSend })} /></Row>
    </Section>
    <Section title="朗读" foot={canSpeak ? '只读你正在看的那段聊天里它的新回复，窗口在后台时不读。' : '这个浏览器不能朗读。'}>
      <Row label="把回复读出来"><Toggle label="把回复读出来" disabled={!canSpeak} checked={prefs.readAloud} onChange={readAloud => setPrefs({ readAloud })} /></Row>
      <Row label="声音">
        <SelectInput value={prefs.voiceName} onChange={e => setPrefs({ voiceName: e.target.value })} className="w-[200px]" disabled={!canSpeak}>
          <option value="">系统默认</option>
          {list.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
        </SelectInput>
        <Btn disabled={!canSpeak} onClick={() => speak(`你好，我是${persona.name}。今天想先做哪件事？`)}>试听</Btn>
      </Row>
      <Row label="语速"><Choice<VoiceRate> label="语速" value={prefs.voiceRate} onChange={voiceRate => setPrefs({ voiceRate })} className="w-[220px]" options={[{ id: 'slow', label: '慢' }, { id: 'normal', label: '正常' }, { id: 'fast', label: '快' }]} /></Row>
    </Section>
  </Page>
}
