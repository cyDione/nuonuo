/**
 * 心境 (mood), built in: the assistant's own mood (心情, -1..1), energy (精力, 0..1) and trust in the owner (信任, 0..100).
 * Mood and energy drift back to their baselines (half-life MOOD_HALF_LIFE_H hours); trust moves slowly and never drifts.
 *
 * No model calls of its own. Before each answer, `inlineContext` appends a short <mood> block to the main agent's input
 * (not the system prompt, so the prompt cache stays intact) with a way of talking picked from the owner's new message;
 * the agent reports the owner's state with `mood_sync` in the same step as its reply. A missing report leaves the mood
 * as it was. It only changes tone, never how much the assistant helps, and it does not write memory.
 *
 * Off until the owner switches it on in 它是谁 (Figma section 29); that switch is its only entry.
 */
import { definePlugin, tool, z, type PluginContext } from '@nuonuo/plugin-sdk'
import type { ToolSet } from 'ai'

export const MOOD_PLUGIN_ID = 'mood'
export const BASELINE = { mood: 0.2, energy: 0.5, trust: 50 }
export const MOOD_HALF_LIFE_H = 6
const HISTORY = 50

export interface MoodPoint { at: number; mood: number; energy: number; trust: number; emotion?: string; attitude?: string }
export interface MoodState { mood: number; energy: number; trust: number; at: number; turns: number; lastFeedback: Feedback; history: MoodPoint[] }
export type Feedback = 'positive' | 'neutral' | 'negative'
export interface MoodReport {
  emotion: 'neutral' | 'happy' | 'excited' | 'anxious' | 'frustrated' | 'sad' | 'angry' | 'tired'
  intensity: number
  attitude: 'respectful' | 'casual' | 'dismissive' | 'hostile' | 'grateful'
  feedback: Feedback
}
export interface Stance { id: 'comrade' | 'listen' | 'focus' | 'banter' | 'partner'; name: string; rule: string }
/** What 它是谁 shows. */
export interface MoodView { enabled: boolean; mood: number; energy: number; trust: number; summary: string; history: MoodPoint[] }

type StatePort = PluginContext['state']

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

export function initialMood(now = Date.now()): MoodState {
  return { ...BASELINE, at: now, turns: 0, lastFeedback: 'neutral', history: [] }
}

/** The state with mood and energy drifted back toward their baselines for the time since it was last touched. */
export function settleMood(state: Partial<MoodState> | undefined, now = Date.now()): MoodState {
  const s = { ...initialMood(now), ...(state ?? {}) }
  const hours = Math.max(0, (now - s.at) / 3_600_000)
  const keep = Math.pow(0.5, hours / MOOD_HALF_LIFE_H)
  return { ...s, mood: BASELINE.mood + (s.mood - BASELINE.mood) * keep, energy: BASELINE.energy + (s.energy - BASELINE.energy) * keep, at: now }
}

// A cheap first guess at the owner's state from the words of the new message, so this turn's tone fits this turn (the
// agent's own report only arrives after it answered). Only a hint: the prompt asks the agent to judge for itself.
const UPSET = /烦|崩溃|气死|受不了|无语|急死|焦虑|难受|郁闷|伤心|累死|好累|累了|绝望|怎么又|又挂|又报错|又出|搞不定|心态|哭|唉|妈的|卧槽|tmd|wtf|ugh|frustrat|annoy|stress|upset|sad|angry|!!|！！|\?\?|？？/i
const TASK = /报错|错误|异常|bug|挂了|崩了|500|404|超时|失败|修|改|帮我|怎么|如何|能不能|写一个|写个|部署|上线|安装|配置|查一下|看看|error|fail|fix|deploy|how (do|to)|can you|please/i

export function guessOwner(text = ''): { upset: boolean; task: boolean } {
  const t = String(text).slice(0, 2_000)
  return { upset: UPSET.test(t), task: TASK.test(t) }
}

/** Which way of talking fits, as an ordered rule list (the first that matches wins). None of them helps less. */
export function stanceFor(state: MoodState, hint = { upset: false, task: false }): Stance {
  if (hint.upset && hint.task) return { id: 'comrade', name: '并肩解决', rule: '对方正为一件事着急。先用一句话说中卡住的地方，接着直接给能做的下一步或答案；不说空洞的安慰。' }
  if (hint.upset) return { id: 'listen', name: '先接住', rule: '对方主要是在倾诉。先回应感受，用自己的话说，不急着列建议；对方问了再给办法。' }
  if (hint.task) return { id: 'focus', name: '专注干活', rule: '对方要把事办成。直接给结论和步骤，不寒暄，不加没被问到的延伸。' }
  if (state.mood > 0.5 && state.trust > 75) return { id: 'banter', name: '老朋友', rule: '心情不错，彼此熟。可以轻松一点、偶尔打趣。' }
  return { id: 'partner', name: '平常', rule: '平稳、真诚、平等地聊。' }
}

const pick = (v: number, lo: number, hi: number, words: string[]) => words[Math.min(words.length - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * words.length)))]!
const moodWord = (v: number) => pick(v, -1, 1, ['低落', '有点闷', '平静', '不错', '很好'])
const energyWord = (v: number) => pick(v, 0, 1, ['没什么劲', '平稳', '有精神'])

/** One line for 它是谁: 「心情不错，有精神」. */
export function moodSummary(s: MoodState): string {
  const m = moodWord(s.mood)
  return `${m === '有点闷' || m === '低落' ? m : `心情${m}`}，${energyWord(s.energy)}`
}

/** The block appended to the main agent's input for this turn (about 200 characters plus the rules). */
export function moodContext(state: MoodState, text: string): string {
  const s = stanceFor(state, guessOwner(text))
  const lines = [
    '<mood>',
    `你此刻的心境：心情${moodWord(state.mood)}（${round(state.mood)}），${energyWord(state.energy)}（${round(state.energy)}），对主人的信任 ${Math.round(state.trust)}/100。它只影响语气，不影响你帮忙的程度和质量。`,
    `这轮的说话方式（${s.name}，按主人的话初步判断，你看了原话可以自己改判）：${s.rule}`,
    '始终：不说客服套话（“非常理解您的感受”“抱抱你”之类），共情要具体、用自己的话。',
  ]
  if (state.trust >= 60) lines.push('你们够熟了：觉得主人哪里想错了，就直接、友善地指出来，不要顺着说。')
  if (state.lastFeedback === 'negative') lines.push('上一轮主人对你的回应不太满意：这次换个方式，别重复上次的做法。')
  lines.push('回复主人时，在同一步里顺手调用 mood_sync，简单报告主人这轮的状态；不要为它单独多走一步，也不要在回复里提到它。', '</mood>')
  return lines.join('\n')
}

/** Applies the agent's report of a turn. Returns the new state and what moved. */
export function applyReport(state: MoodState, report: MoodReport, now = Date.now()): { state: MoodState; delta: { mood: number; energy: number; trust: number } } {
  const s = settleMood(state, now)
  const k = clamp(Number(report.intensity ?? 0.5), 0, 1)
  let { mood, energy, trust } = s
  switch (report.attitude) {
    case 'grateful': mood += 0.2; trust += 2; energy += 0.1; break
    case 'respectful': mood += 0.05; trust += 0.5; break
    case 'dismissive': mood -= 0.05; break
    // Being snapped at stings a little but, as with a friend under pressure, barely dents trust.
    case 'hostile': mood -= 0.15; trust -= 1; break
  }
  if (report.feedback === 'positive') { mood += 0.1; trust += 1 }
  if (report.feedback === 'negative') mood -= 0.1
  // The owner's own state rubs off a little: their excitement lifts energy, their distress weighs on mood.
  if (report.emotion === 'happy' || report.emotion === 'excited') { mood += 0.1 * k; energy += 0.15 * k }
  if (['sad', 'anxious', 'frustrated', 'angry'].includes(report.emotion)) { mood -= 0.05 * k; energy += 0.1 * k }
  if (report.emotion === 'tired') energy -= 0.1 * k
  const next: MoodState = { ...s, mood: clamp(mood, -1, 1), energy: clamp(energy, 0, 1), trust: clamp(trust, 0, 100), at: now, turns: s.turns + 1, lastFeedback: report.feedback ?? 'neutral' }
  next.history = [...s.history, { at: now, mood: round(next.mood), energy: round(next.energy), trust: round(next.trust, 1), emotion: report.emotion, attitude: report.attitude }].slice(-HISTORY)
  return { state: next, delta: { mood: round(next.mood - s.mood), energy: round(next.energy - s.energy), trust: round(next.trust - s.trust, 1) } }
}

// ── State kept in the plugin's own store ─────────────────────────────────────

const read = (state: StatePort) => settleMood(state.get<MoodState>('mood'))
export const moodEnabled = (state: StatePort) => state.get<boolean>('enabled') ?? false

export function moodView(state: StatePort): MoodView {
  const s = read(state)
  return { enabled: moodEnabled(state), mood: round(s.mood), energy: round(s.energy), trust: round(s.trust, 1), summary: moodSummary(s), history: s.history }
}
export function setMoodEnabled(state: StatePort, enabled: boolean): void { state.set('enabled', enabled) }
export function resetMood(state: StatePort): void { state.set('mood', initialMood()) }

const Report = z.object({
  emotion: z.enum(['neutral', 'happy', 'excited', 'anxious', 'frustrated', 'sad', 'angry', 'tired']).describe("The owner's main feeling in this message"),
  intensity: z.number().min(0).max(1).describe('How strong that feeling is, 0..1'),
  attitude: z.enum(['respectful', 'casual', 'dismissive', 'hostile', 'grateful']).describe('How the owner treated you'),
  feedback: z.enum(['positive', 'neutral', 'negative']).describe('How the owner took your previous answer'),
})

export const moodPlugin = definePlugin({
  id: MOOD_PLUGIN_ID,
  name: '心境',
  description: '糯糯自己的心情、精力和对你的信任，随对话变化、随时间回落。',
  inlineContext: (ctx, { text }) => moodEnabled(ctx.state) ? moodContext(read(ctx.state), text) : undefined,
  routerTools: (ctx): ToolSet => moodEnabled(ctx.state) ? {
    mood_sync: tool({
      description: 'Report how the owner was in the message you are answering, in the same step as your reply (never a step of its own). Nothing is posted; it only updates your mood.',
      inputSchema: Report,
      execute: async report => {
        const { state, delta } = applyReport(read(ctx.state), report)
        ctx.state.set('mood', state)
        return { ok: true, delta }
      },
    }),
  } : {},
})
