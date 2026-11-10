/** Speech on this device (设置 → 语音): reading replies aloud with the voice and speed the owner picked. */
import { getPrefs } from './prefs'

export const RATES = { slow: 0.8, normal: 1, fast: 1.25 } as const

/** The voices this browser has, the owner's language first. */
export function voices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return []
  return [...speechSynthesis.getVoices()].sort((a, b) => Number(b.lang.startsWith('zh')) - Number(a.lang.startsWith('zh')))
}

/** Markdown read as plain sentences: no code, links read by their text, no list marks. */
export function plain(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '（代码）').replace(/`([^`]+)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#+|[-*+]|\d+\.)\s+/gm, '').replace(/[*_~>|]/g, '').replace(/\s+/g, ' ').trim()
}

export function speak(text: string, opts: { name?: string; rate?: keyof typeof RATES } = {}) {
  if (typeof speechSynthesis === 'undefined') return
  const prefs = getPrefs()
  const u = new SpeechSynthesisUtterance(plain(text).slice(0, 1_500))
  const voice = voices().find(v => v.name === (opts.name ?? prefs.voiceName))
  if (voice) { u.voice = voice; u.lang = voice.lang } else u.lang = prefs.voiceLang
  u.rate = RATES[opts.rate ?? prefs.voiceRate]
  speechSynthesis.cancel()
  speechSynthesis.speak(u)
}
