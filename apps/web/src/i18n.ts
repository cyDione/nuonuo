/**
 * The interface language (设置 · 通用 · 界面语言): 中文, English, or following the system. Text is written in Chinese in
 * the code and looked up here; a line with no English yet shows in Chinese. `{0}`, `{1}`… in a line are filled from the
 * arguments in order. The language is read once when the page loads, so changing it reloads the page.
 */
import { EN } from './i18n.en'

export type UiLanguage = 'zh' | 'en' | 'system'
const KEY = 'sa-ui-language'

function stored(): UiLanguage {
  try { const v = localStorage.getItem(KEY); return v === 'zh' || v === 'en' ? v : 'system' } catch { return 'system' }
}
const resolve = (l: UiLanguage): 'zh' | 'en' => l !== 'system' ? l : typeof navigator !== 'undefined' && !/^zh\b/i.test(navigator.language) ? 'en' : 'zh'

/** The language chosen (system included) and the one in effect. */
export const uiLanguage: UiLanguage = stored()
export const lang: 'zh' | 'en' = resolve(uiLanguage)
/** For dates and numbers. */
export const locale = lang === 'en' ? 'en-US' : 'zh-CN'
if (typeof document !== 'undefined') document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'

export function setUiLanguage(l: UiLanguage) {
  try { if (l === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, l) } catch { /* private mode */ }
  location.reload()
}

type Arg = string | number | null | undefined | false
export function tx(text: string, ...args: Arg[]): string {
  const line = lang === 'en' ? EN[text] ?? text : text
  return args.length ? line.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? '')) : line
}
