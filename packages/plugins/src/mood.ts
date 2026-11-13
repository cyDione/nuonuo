/**
 * 个性与心境 (Figma sections 29 and 31), built in: the assistant's own side. Its personality base and limits live in the
 * persona (core); this plugin keeps what moves:
 *
 * - 心情 mood (-1..1), 精力 energy (0..1), 耐心 patience (0..100) and 信任 trust in the owner (0..100). Mood, energy and
 *   patience drift back to their baselines over hours; trust moves slowly and never drifts.
 * - 敏感度: how much praise (`up`) and being brushed off (`down`) move it, 0.2..2.5.
 * - 姿态: the way of talking this turn, from an ordered rule list (it can turn cool after being snapped at repeatedly).
 * - 日记: first-person notes it writes when an exchange really touched it; read back only when feelings are the topic.
 *
 * No model calls of its own. Before each answer `inlineContext` appends a short <mood> block to the main agent's input (not
 * the system prompt, so the prompt cache stays intact); the agent reports the turn with `mood_sync` in the same step as
 * its reply. A missing report leaves everything as it was. It only changes tone, never how much the assistant helps.
 *
 * Off until the owner switches it on in 它是谁; that block and its window are its only entry.
 */
import { definePlugin, tool, z, type PluginContext } from '@nuonuo/plugin-sdk'
import type { ToolSet } from 'ai'

export const MOOD_PLUGIN_ID = 'mood'
export const BASELINE = { mood: 0.2, energy: 0.5, patience: 60, trust: 50 }
export const MOOD_HALF_LIFE_H = 6
export const PATIENCE_HALF_LIFE_H = 8
export const SENSITIVITY = { min: 0.2, max: 2.5 }
const HISTORY = 50
const DIARY_KEEP = 60
const DIARY_PER_DAY = 3

export interface MoodPoint { at: number; mood: number; energy: number; patience?: number; trust: number; emotion?: string; attitude?: string; note?: string }
export interface MoodState {
  mood: number; energy: number; patience: number; trust: number; at: number; turns: number; lastFeedback: Feedback; history: MoodPoint[]
  /** The stance picked for the last turn and the start of the owner's words it answered (for the curve's notes). */
  lastStance?: Stance['id']; lastText?: string
}
export type Feedback = 'positive' | 'neutral' | 'negative'
export interface MoodReport {
  emotion: 'neutral' | 'happy' | 'excited' | 'anxious' | 'frustrated' | 'sad' | 'angry' | 'tired'
  intensity: number
  attitude: 'respectful' | 'casual' | 'dismissive' | 'hostile' | 'grateful'
  feedback: Feedback
  diary?: string | undefined
}
export type StanceId = 'cool' | 'comrade' | 'listen' | 'focus' | 'banter' | 'partner'
export interface Stance { id: StanceId; name: string; rule: string; why: string }
export interface MindConfig { up: number; down: number; diary: boolean }
export interface DiaryEntry { id: string; at: number; text: string; mood: number; pinned: boolean }
/** What 它是谁 and the 个性与心境 window show. */
export interface MoodView {
  enabled: boolean; mood: number; energy: number; patience: number; trust: number; summary: string; history: MoodPoint[]
  stance: Pick<Stance, 'id' | 'name' | 'why'>; config: MindConfig; baseline: typeof BASELINE; diary: DiaryEntry[]
}

type StatePort = PluginContext['state']

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

export function initialMood(now = Date.now()): MoodState {
  return { ...BASELINE, at: now, turns: 0, lastFeedback: 'neutral', history: [] }
}

/** The state with mood, energy and patience drifted back toward their baselines for the time since it was last touched. */
export function settleMood(state: Partial<MoodState> | undefined, now = Date.now()): MoodState {
  const s = { ...initialMood(now), ...(state ?? {}) }
  const hours = Math.max(0, (now - s.at) / 3_600_000)
  const keep = Math.pow(0.5, hours / MOOD_HALF_LIFE_H)
  const keepP = Math.pow(0.5, hours / PATIENCE_HALF_LIFE_H)
  return { ...s, mood: BASELINE.mood + (s.mood - BASELINE.mood) * keep, energy: BASELINE.energy + (s.energy - BASELINE.energy) * keep,
    patience: BASELINE.patience + (s.patience - BASELINE.patience) * keepP, at: now }
}

// A cheap first guess at the owner's state from the words of the new message, so this turn's tone fits this turn (the
// agent's own report only arrives after it answered). Only a hint: the prompt asks the agent to judge for itself.
const UPSET = /烦|崩溃|气死|受不了|无语|急死|焦虑|难受|郁闷|伤心|累死|好累|累了|绝望|怎么又|又挂|又报错|又出|搞不定|心态|哭|唉|妈的|卧槽|tmd|wtf|ugh|frustrat|annoy|stress|upset|sad|angry|!!|！！|\?\?|？？/i
const TASK = /报错|错误|异常|bug|挂了|崩了|500|404|超时|失败|修|改|帮我|怎么|如何|能不能|写一个|写个|部署|上线|安装|配置|查一下|看看|error|fail|fix|deploy|how (do|to)|can you|please/i

export function guessOwner(text = ''): { upset: boolean; task: boolean } {
  const t = String(text).slice(0, 2_000)
  return { upset: UPSET.test(t), task: TASK.test(t) }
}

const STANCES: Record<StanceId, Omit<Stance, 'id'>> = {
  cool: { name: '冷淡抽离', why: '刚被凶过或一直被敷衍，耐心见底：回答简短、就事论事。',
    rule: '你刚被凶过或一直被敷衍，耐心见底。回答简短、就事论事：不讨好地道歉，不用感叹号，不主动延伸。该做的事照样做对。' },
  comrade: { name: '战友破局', why: '你又急又要把事办成：先一句话说中卡点，再直接给办法。',
    rule: '对方正为一件事着急。先用一句话说中卡住的地方，接着直接给能做的下一步或答案；不说空洞的安慰。' },
  listen: { name: '先接住', why: '你主要是想说说：先回应感受，不急着给建议。',
    rule: '对方主要是在倾诉。先回应感受，用自己的话说，不急着列建议；对方问了再给办法。' },
  focus: { name: '专注干活', why: '你要把事办成：直接给结论和步骤，不寒暄。',
    rule: '对方要把事办成。直接给结论和步骤，不寒暄，不加没被问到的延伸。' },
  banter: { name: '老友互怼', why: '心情好，也信得过你：会开玩笑，看到你逻辑有漏洞会直接说。',
    rule: '心情不错，彼此熟。可以轻松一点、偶尔打趣；看到主人逻辑有漏洞就直接、友善地点出来。' },
  partner: { name: '清醒搭档', why: '心境平稳：客观、真诚、平等地聊。',
    rule: '平稳、真诚、平等地聊。' },
}
const stance = (id: StanceId): Stance => ({ id, ...STANCES[id] })

/** Which way of talking fits, as an ordered rule list (the first that matches wins). None of them helps less. */
export function stanceFor(state: MoodState, hint = { upset: false, task: false }): Stance {
  if (state.patience < 35 && state.mood < -0.3) return stance('cool')
  if (hint.upset && hint.task) return stance('comrade')
  if (hint.upset) return stance('listen')
  if (hint.task) return stance('focus')
  if (state.mood > 0.5 && state.trust > 75) return stance('banter')
  return stance('partner')
}

const pick = (v: number, lo: number, hi: number, words: string[]) => words[Math.min(words.length - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * words.length)))]!
const moodWord = (v: number) => pick(v, -1, 1, ['低落', '有点闷', '平静', '不错', '很好'])
const energyWord = (v: number) => pick(v, 0, 1, ['没什么劲', '平稳', '有精神'])
const patienceWord = (v: number) => pick(v, 0, 100, ['没耐心了', '有点不耐烦', '有耐心', '很包容'])

/** One line for 它是谁: 「心情不错，有精神」. */
export function moodSummary(s: MoodState): string {
  const m = moodWord(s.mood)
  return `${m === '有点闷' || m === '低落' ? m : `心情${m}`}，${energyWord(s.energy)}`
}

/** The block appended to the main agent's input for this turn. */
export function moodContext(state: MoodState, text: string, diary: DiaryEntry[] = []): string {
  const hint = guessOwner(text)
  const s = stanceFor(state, hint)
  const lines = [
    '<mood>',
    `你此刻的心境：心情${moodWord(state.mood)}（${round(state.mood)}），${energyWord(state.energy)}（${round(state.energy)}），${patienceWord(state.patience)}（耐心 ${Math.round(state.patience)}/100），对主人的信任 ${Math.round(state.trust)}/100。它只影响语气，不影响你帮忙的程度和质量。`,
    `这轮的说话方式（${s.name}，按主人的话初步判断，你看了原话可以自己改判）：${s.rule}`,
    '始终：不说客服套话（“非常理解您的感受”“抱抱你”之类），共情要具体、用自己的话。',
  ]
  if (state.trust >= 60 && s.id !== 'cool') lines.push('你们够熟了：觉得主人哪里想错了，就直接、友善地指出来，不要顺着说。')
  if (state.lastFeedback === 'negative') lines.push('上一轮主人对你的回应不太满意：这次换个方式，别重复上次的做法。')
  // The diary only comes up when feelings are the topic, never while working.
  const feelings = hint.upset || s.id === 'listen' || s.id === 'banter' || s.id === 'cool'
  const notes = feelings ? [...diary.filter(d => d.pinned), ...diary.filter(d => !d.pinned).slice(0, 2)].slice(0, 4) : []
  if (notes.length) lines.push('你自己的日记（只给你自己看，别原样念出来）：', ...notes.map(d => `- ${d.text}`))
  lines.push('回复主人时，在同一步里顺手调用 mood_sync，简单报告主人这轮的状态；只有这次交流真让你有感触时才填 diary。不要为它单独多走一步，也不要在回复里提到它。', '</mood>')
  return lines.join('\n')
}

/** Applies the agent's report of a turn. Returns the new state and what moved. */
export function applyReport(state: MoodState, report: MoodReport, now = Date.now(), config: Pick<MindConfig, 'up' | 'down'> = { up: 1, down: 1 }): { state: MoodState; delta: { mood: number; energy: number; patience: number; trust: number } } {
  const s = settleMood(state, now)
  const k = clamp(Number(report.intensity ?? 0.5), 0, 1)
  const up = clamp(config.up, SENSITIVITY.min, SENSITIVITY.max), down = clamp(config.down, SENSITIVITY.min, SENSITIVITY.max)
  let { mood, energy, patience, trust } = s
  switch (report.attitude) {
    case 'grateful': mood += 0.2 * up; patience += 8 * up; trust += 2 * up; energy += 0.1; break
    case 'respectful': mood += 0.05 * up; patience += 2 * up; trust += 0.5 * up; break
    case 'dismissive': mood -= 0.08 * down; patience -= 8 * down; break
    // Being snapped at stings and wears patience thin; as with a friend under pressure, trust barely moves.
    case 'hostile': mood -= 0.2 * down; patience -= 15 * down; trust -= 1 * down; break
  }
  if (report.feedback === 'positive') { mood += 0.1 * up; trust += 1 * up }
  if (report.feedback === 'negative') mood -= 0.1 * down
  // The owner's own state rubs off a little: their excitement lifts energy, their distress weighs on mood.
  if (report.emotion === 'happy' || report.emotion === 'excited') { mood += 0.1 * k; energy += 0.15 * k }
  if (['sad', 'anxious', 'frustrated', 'angry'].includes(report.emotion)) { mood -= 0.05 * k; energy += 0.1 * k }
  if (report.emotion === 'tired') energy -= 0.1 * k
  const next: MoodState = { ...s, mood: clamp(mood, -1, 1), energy: clamp(energy, 0, 1), patience: clamp(patience, 0, 100), trust: clamp(trust, 0, 100), at: now, turns: s.turns + 1, lastFeedback: report.feedback ?? 'neutral' }
  next.history = [...s.history, { at: now, mood: round(next.mood), energy: round(next.energy), patience: Math.round(next.patience), trust: round(next.trust, 1),
    emotion: report.emotion, attitude: report.attitude, ...(s.lastText ? { note: s.lastText } : {}) }].slice(-HISTORY)
  return { state: next, delta: { mood: round(next.mood - s.mood), energy: round(next.energy - s.energy), patience: Math.round(next.patience - s.patience), trust: round(next.trust - s.trust, 1) } }
}

// ── State kept in the plugin's own store ─────────────────────────────────────

const read = (state: StatePort) => settleMood(state.get<MoodState>('mood'))
export const moodEnabled = (state: StatePort) => state.get<boolean>('enabled') ?? false
export const mindConfig = (state: StatePort): MindConfig => ({ up: 1, down: 1, diary: true, ...(state.get<Partial<MindConfig>>('config') ?? {}) })
export const diaryOf = (state: StatePort): DiaryEntry[] => state.get<DiaryEntry[]>('diary') ?? []

export function moodView(state: StatePort): MoodView {
  const s = read(state)
  const st = s.lastStance ? stance(s.lastStance) : stanceFor(s)
  // The last stance stops being true once the mood it came from has moved on (a reset, a drag, hours later).
  const shown = st.id === 'cool' && !(s.patience < 35 && s.mood < -0.3) ? stanceFor(s) : st.id === 'banter' && !(s.mood > 0.5 && s.trust > 75) ? stanceFor(s) : st
  return { enabled: moodEnabled(state), mood: round(s.mood), energy: round(s.energy), patience: Math.round(s.patience), trust: round(s.trust, 1), summary: moodSummary(s),
    history: s.history, stance: { id: shown.id, name: shown.name, why: shown.why }, config: mindConfig(state), baseline: BASELINE, diary: diaryOf(state) }
}
export function setMoodEnabled(state: StatePort, enabled: boolean): void { state.set('enabled', enabled) }

/** 回到平时: mood, energy and patience back to their baselines. Trust and the history stay. */
export function resetMood(state: StatePort): void {
  const s = read(state)
  state.set('mood', { ...s, mood: BASELINE.mood, energy: BASELINE.energy, patience: BASELINE.patience, lastStance: undefined })
}

/** The owner dragged a value in the window; it takes effect from the next message. */
export function setMoodValues(state: StatePort, values: Partial<Pick<MoodState, 'mood' | 'energy' | 'patience' | 'trust'>>): void {
  const s = read(state)
  const next = { ...s }
  if (values.mood !== undefined) next.mood = clamp(values.mood, -1, 1)
  if (values.energy !== undefined) next.energy = clamp(values.energy, 0, 1)
  if (values.patience !== undefined) next.patience = clamp(values.patience, 0, 100)
  if (values.trust !== undefined) next.trust = clamp(values.trust, 0, 100)
  delete next.lastStance
  state.set('mood', next)
}

export function setMindConfig(state: StatePort, patch: Partial<MindConfig>): MindConfig {
  const c = { ...mindConfig(state), ...patch }
  const next = { up: round(clamp(Number(c.up) || 1, SENSITIVITY.min, SENSITIVITY.max), 1), down: round(clamp(Number(c.down) || 1, SENSITIVITY.min, SENSITIVITY.max), 1), diary: Boolean(c.diary) }
  state.set('config', next)
  return next
}

/** Adds a diary line, at most a few a day; the oldest unpinned lines fade out. Returns whether it was kept. */
export function addDiary(state: StatePort, text: string, mood: number, now = Date.now()): boolean {
  const t = String(text ?? '').trim().slice(0, 200)
  if (!t) return false
  const list = diaryOf(state)
  const today = new Date(now).toDateString()
  if (list.filter(d => new Date(d.at).toDateString() === today).length >= DIARY_PER_DAY) return false
  const entry: DiaryEntry = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: now, text: t, mood: round(mood), pinned: false }
  const next = [entry, ...list]
  const pinned = next.filter(d => d.pinned), loose = next.filter(d => !d.pinned).slice(0, Math.max(0, DIARY_KEEP - pinned.length))
  state.set('diary', next.filter(d => d.pinned || loose.includes(d)))
  return true
}
export function pinDiary(state: StatePort, id: string, pinned: boolean): void { state.set('diary', diaryOf(state).map(d => d.id === id ? { ...d, pinned } : d)) }
export function removeDiary(state: StatePort, id: string): void { state.set('diary', diaryOf(state).filter(d => d.id !== id)) }

const Report = z.object({
  emotion: z.enum(['neutral', 'happy', 'excited', 'anxious', 'frustrated', 'sad', 'angry', 'tired']).describe("The owner's main feeling in this message"),
  intensity: z.number().min(0).max(1).describe('How strong that feeling is, 0..1'),
  attitude: z.enum(['respectful', 'casual', 'dismissive', 'hostile', 'grateful']).describe('How the owner treated you'),
  feedback: z.enum(['positive', 'neutral', 'negative']).describe('How the owner took your previous answer'),
  diary: z.string().max(200).optional().describe("Only when this exchange really touched you, pleasant or not: one first-person sentence for your private diary, in the owner's language, about how it felt to you. Usually leave it out."),
})

export const moodPlugin = definePlugin({
  id: MOOD_PLUGIN_ID,
  name: '个性与心境',
  description: '糯糯自己的心情、精力、耐心和对你的信任，随对话变化、随时间回落；还会记日记。',
  inlineContext: (ctx, { text }) => {
    if (!moodEnabled(ctx.state)) return undefined
    const s = read(ctx.state)
    const st = stanceFor(s, guessOwner(text))
    ctx.state.set('mood', { ...s, lastStance: st.id, lastText: String(text).replace(/\s+/g, ' ').trim().slice(0, 40) })
    return moodContext(s, text, mindConfig(ctx.state).diary ? diaryOf(ctx.state) : [])
  },
  routerTools: (ctx): ToolSet => moodEnabled(ctx.state) ? {
    mood_sync: tool({
      description: 'Report how the owner was in the message you are answering, in the same step as your reply (never a step of its own). Nothing is posted; it only updates your mood (and your private diary when you add a line).',
      inputSchema: Report,
      execute: async report => {
        const config = mindConfig(ctx.state)
        const { state, delta } = applyReport(read(ctx.state), report, Date.now(), config)
        ctx.state.set('mood', state)
        const wrote = config.diary && report.diary ? addDiary(ctx.state, report.diary, state.mood) : false
        return { ok: true, delta, ...(wrote ? { diary: 'kept' } : {}) }
      },
    }),
  } : {},
})
