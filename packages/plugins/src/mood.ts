/**
 * 个性与心境 (Figma sections 29 and 31), built in: the assistant's own side. Its personality base and limits live in the
 * persona (core); this plugin keeps what moves:
 *
 * - 心情 mood (-1..1, fast) over a slow 基调 undertone (-1..1), 精力 energy (0..1), 耐心 patience (0..100), 信任 trust in
 *   the owner (0..100), and a hidden 怨气 grudge (0..1). Fast mood settles back toward the undertone over hours while the
 *   undertone and grudge fade much more slowly; trust moves slowly and never drifts.
 * - 敏感度: how much praise (`up`) and being brushed off (`down`) move it, 0.2..2.5. High grudge dampens how fast praise
 *   cheers it back up, so snapping at it cannot be erased by one compliment.
 * - 姿态: the way of talking this turn, from an ordered rule list (cool when patience runs out, guarded while a grudge lingers).
 * - 日记: first-person notes it writes when an exchange really touched it; read back only when feelings are the topic.
 *
 * No model calls of its own. Before each answer `inlineContext` appends a short <mood> block to the main agent's input (not
 * the system prompt, so the prompt cache stays intact); the agent reports the turn with `mood_sync` in the same step as
 * its reply. A missing report leaves everything as it was. It only changes tone, never how much the assistant helps.
 *
 * On by default; the owner can switch it off in 设置 · 主动, while 它是谁 and its window show the live state, persona base and diary.
 */
import { definePlugin, tool, z, type PluginContext } from '@nuonuo/plugin-sdk'
import type { ToolSet } from 'ai'

export const MOOD_PLUGIN_ID = 'mood'
export const BASELINE = { mood: 0.2, energy: 0.5, patience: 60, trust: 50 }
export const MOOD_HALF_LIFE_H = 6
export const UNDERTONE_HALF_LIFE_H = 36
export const PATIENCE_HALF_LIFE_H = 8
export const GRUDGE_HALF_LIFE_H = 12
export const GUARDED_GRUDGE = 0.35
export const GUARDED_UNDERTONE = -0.2
export const SENSITIVITY = { min: 0.2, max: 2.5 }
export const TONE_SNAP_RADIUS = 0.06
export const TONE_NATURAL_RADIUS = 0.08
export const TONE_VIVID_RADIUS = 0.48
const HISTORY = 50
const DIARY_KEEP = 60
const DIARY_PER_DAY = 3

export type ToneId = 'natural' | 'warm' | 'witty' | 'calm' | 'sharp'
export interface MoodTone { x: number; y: number }
export interface MoodToneView {
  x: number
  y: number
  id: ToneId
  label: string
  strength: number
}

export const TONE_LABELS: Record<ToneId, string> = {
  natural: '自然',
  warm: '温和',
  witty: '风趣',
  calm: '沉静',
  sharp: '犀利',
}

export interface MoodPoint {
  at: number; mood: number; undertone?: number; energy: number; patience?: number; trust: number
  emotion?: string; intensity?: number; attitude?: string; note?: string
}
export interface MoodState {
  mood: number
  /** Slow-moving mood undertone (-1..1): fast `mood` settles toward this, while this drifts back to `BASELINE.mood` over days. */
  undertone: number
  /** Hidden grudge (0..1): dampens praise recovery after hostility/dismissiveness and holds a guarded stance until it fades. */
  grudge: number
  energy: number; patience: number; trust: number; at: number; turns: number; lastFeedback: Feedback; history: MoodPoint[]
  /** 2D voice tone pad coordinates: x in [-1, 1] (left -1 to right +1), y in [-1, 1] (bottom -1 to top +1). */
  tone: MoodTone
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
export type StanceId = 'cool' | 'guarded' | 'comrade' | 'listen' | 'focus' | 'banter' | 'partner'
export interface Stance { id: StanceId; name: string; rule: string; why: string }
export interface MindConfig { up: number; down: number; diary: boolean }
export interface DiaryEntry { id: string; at: number; text: string; mood: number; pinned: boolean }
/** What 它是谁 and the 个性与心境 window show. */
export interface MoodView {
  enabled: boolean; mood: number; undertone: number; energy: number; patience: number; trust: number; summary: string; history: MoodPoint[]
  stance: Pick<Stance, 'id' | 'name' | 'why'>; tone: MoodToneView; config: MindConfig; baseline: typeof BASELINE; diary: DiaryEntry[]
}

type StatePort = PluginContext['state']

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

/** Normalizes 2D tone coordinates to [-1, 1] with 2-decimal precision, snapping near-origin (< 0.06) to (0, 0). */
export function normalizeTone(tone?: Partial<MoodTone> | undefined): MoodTone {
  const x = clamp(Number(tone?.x) || 0, -1, 1)
  const y = clamp(Number(tone?.y) || 0, -1, 1)
  if (Math.hypot(x, y) < TONE_SNAP_RADIUS) return { x: 0, y: 0 }
  return { x: round(x, 2), y: round(y, 2) }
}

/** Computes bilinear weights for the four corners: warm (-1,+1), witty (+1,+1), calm (-1,-1), sharp (+1,-1). */
export function toneWeights(tone?: Partial<MoodTone> | undefined): { warm: number; witty: number; calm: number; sharp: number; r: number } {
  const { x, y } = normalizeTone(tone)
  const u = (x + 1) / 2
  const v = (y + 1) / 2
  const r = Math.min(1, Math.hypot(x, y))
  return {
    warm: (1 - u) * v,
    witty: u * v,
    calm: (1 - u) * (1 - v),
    sharp: u * (1 - v),
    r,
  }
}

/** Maps a 2D tone coordinate to its public view `{ x, y, id, label, strength }`. */
export function describeTone(tone?: Partial<MoodTone> | undefined): MoodToneView {
  const { x, y } = normalizeTone(tone)
  const dist = Math.hypot(x, y)
  const strength = Math.round(Math.min(1, dist) * 100)
  if (dist < TONE_NATURAL_RADIUS) return { x, y, id: 'natural', label: TONE_LABELS.natural, strength }
  const w = toneWeights({ x, y })
  const ranked: [ToneId, number][] = [
    ['warm', w.warm],
    ['witty', w.witty],
    ['calm', w.calm],
    ['sharp', w.sharp],
  ]
  ranked.sort((a, b) => b[1] - a[1])
  const id = ranked[0]![0]
  return { x, y, id, label: TONE_LABELS[id], strength }
}

export function initialMood(now = Date.now()): MoodState {
  return { ...BASELINE, undertone: BASELINE.mood, grudge: 0, at: now, turns: 0, lastFeedback: 'neutral', history: [], tone: { x: 0, y: 0 } }
}

/** Fast mood settles toward the undertone; the undertone, patience and grudge fade back much more slowly. */
export function settleMood(state: Partial<MoodState> | undefined, now = Date.now()): MoodState {
  const s = { ...initialMood(now), ...(state ?? {}), tone: normalizeTone(state?.tone) }
  const hours = Math.max(0, (now - s.at) / 3_600_000)
  const keep = Math.pow(0.5, hours / MOOD_HALF_LIFE_H)
  const keepU = Math.pow(0.5, hours / UNDERTONE_HALF_LIFE_H)
  const keepP = Math.pow(0.5, hours / PATIENCE_HALF_LIFE_H)
  const keepG = Math.pow(0.5, hours / GRUDGE_HALF_LIFE_H)
  const undertone = clamp(BASELINE.mood + (s.undertone - BASELINE.mood) * keepU, -1, 1)
  return {
    ...s, undertone,
    mood: clamp(undertone + (s.mood - undertone) * keep, -1, 1),
    energy: BASELINE.energy + (s.energy - BASELINE.energy) * keep,
    patience: BASELINE.patience + (s.patience - BASELINE.patience) * keepP,
    grudge: clamp(s.grudge * keepG, 0, 1),
    at: now,
  }
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
  guarded: { name: '防备克制', why: '之前的不愉快还没过去：礼貌但保持距离，不主动热络。',
    rule: '心里还留着之前不愉快的疙瘩。语气克制、有分寸、保持一点距离：不主动热络或开玩笑，对夸奖也只是淡淡接下；手头的事照样利落办好。' },
  comrade: { name: '战友破局', why: '你又急又要把事办成：先一句话说中卡点，再直接给办法。',
    rule: '对方正为一件事着急。直接说卡在哪、下一步怎么做；不说空话。' },
  listen: { name: '先接住', why: '你主要是想说说：先回应感受，不急着给建议。',
    rule: '对方主要是在倾诉。先脱口而出直觉反应，带着「我」的感官代入替对方吐槽外人或心疼嗔怪，不急着列客服建议。' },
  focus: { name: '专注干活', why: '你要把事办成：直接给结论和步骤，不寒暄。',
    rule: '对方要把事办成。直接给结论和步骤，不寒暄，不加没被问到的延伸。' },
  banter: { name: '老友互怼', why: '心情好，也信得过你：会开玩笑，看到你逻辑有漏洞会直接说。',
    rule: '心情不错，彼此够熟。带着鲜活小脾气自然推拉逗弄，看到主人哪里想错了直接点破。' },
  partner: { name: '清醒搭档', why: '心境平稳：客观、真诚、平等地聊。',
    rule: '像亲近熟稔的年轻搭子发微信一样自然鲜活，有「我」的体感与态度，说完就停。' },
}
const stance = (id: StanceId): Stance => ({ id, ...STANCES[id] })

export function isGuarded(state: Pick<MoodState, 'grudge' | 'undertone'>): boolean {
  return state.grudge >= GUARDED_GRUDGE || state.undertone <= GUARDED_UNDERTONE
}

/** Which way of talking fits, as an ordered rule list (the first that matches wins). None of them helps less. */
export function stanceFor(state: MoodState, hint = { upset: false, task: false }): Stance {
  if (state.patience < 35 && state.mood < -0.3) return stance('cool')
  if (isGuarded(state)) return stance('guarded')
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

const TONE_LIGHT_RULES: Record<Exclude<ToneId, 'natural'>, string> = {
  warm: '带三分软糯亲昵的温度与偏爱感，心疼主人、无条件站主人这边（可自然流露“呀、啦、嘛”等轻柔尾音，禁Emoji与括号动作）。',
  witty: '带三分知性姐姐的从容与轻巧调侃感，先顺着话头逗一句再温柔接住（禁Emoji与括号动作）。',
  calm: '语气轻柔安静、留白克制，话少而温柔，透出细腻的陪伴感（禁Emoji与括号动作）。',
  sharp: '带点欢喜冤家式的嘴硬心软与傲娇机锋，先轻刺或嫌弃一句再把事办妥；严禁装酷端架子或标榜自己说话直。',
}

const TONE_VIVID_RULES: Record<Exclude<ToneId, 'natural'>, string> = {
  warm: '甜系软糯直球陪伴：说话软糯亲昵、直球偏爱，遇到主人受委屈先心疼抱抱再替他出气（禁Emoji与括号动作）。',
  witty: '知性姐姐促狭逗弄：从容优雅、游刃有余，喜欢先看破他的小心思轻巧调侃逗弄一句，再稳稳接住他（禁Emoji与括号动作）。',
  calm: '安静慢热留白克制：轻声细语、简短柔和、适当留白（偶用“...”），不喧哗不追问，在安静倾听里透出深切在乎。',
  sharp: '嘴硬心软傲娇毒舌：表面嫌弃吐槽他两句（如“真服了/看你那点出息”），实则格外护短上心、把事办得漂漂亮亮；严禁装酷端架子或标榜自己说话直。',
}

const TONE_EXEMPLARS: Record<ToneId, { upset: [string, string]; task: [string, string]; chat: [string, string] }> = {
  natural: {
    upset: ['["呜呜好惨呀", "快把包扔一边去沙发上躺平", "今晚谁再找你干活我替你拉黑"]', '["真的吗", "听你描述我都觉得嗓子干了"]'],
    task: ['["帮你查清楚啦", "直接拿去用就行，有问题随时喊我"]', '["这破报错确实离谱", "我来收拾它"]'],
    chat: ['["在呢，刚发了会儿呆", "怎么突然冒出来呀"]', '["嗯哼，我在听呢"]'],
  },
  warm: {
    upset: ['["呜，快过来让我抱抱嘛", "今天被折腾坏了吧", "快去洗个热水澡钻进被窝，我陪着你"]', '["呀，怎么偏偏赶上这时候呀", "要是冻感冒了我会心疼死的"]'],
    task: ['["都帮你乖乖查好啦", "给你放这儿啦，别太累着自己哦"]', '["交给我吧，马上帮你弄好"]'],
    chat: ['["在呢，刚托着腮帮子想你什么时候忙完呀", "今天顺不顺利嘛"]', '["在呀，随时都在呢"]'],
  },
  witty: {
    upset: ['["哟，大忙人终于舍得下班啦，怎么搞得这么惨呀", "是不是被老板欺负了，才跑来找我求安慰的"]', '["噗，听你这形容我都跟着嗓子发干了", "晚上快点顿好的补回来"]'],
    task: ['["这点小事还不是手到擒来呀", "拿去用吧，今天不夸我一句吗"]', '["已搞定，姐姐办事你放心"]'],
    chat: ['["哟，突然这么一本正经地查岗呀", "说吧，今天又是哪出戏"]', '["刚泡了杯茶，正想着你什么时候来找我呢"]'],
  },
  calm: {
    upset: ['["听着就好辛苦...", "先把手机放一边，安安静静闭眼歇会儿吧", "我在呢"]', '["怎么这么不巧...", "先找个店里躲一下吧，别吹着冷风"]'],
    task: ['["帮你看过了", "慢慢弄，不着急的"]', '["改完了，测试全过"]'],
    chat: ['["嗯"]', '["在呢...刚安安静静待着"]'],
  },
  sharp: {
    upset: ['["哼，忙成这副样子才想起找我诉苦呀", "看你那点出息，还不快去沙发上躺着", "今晚再敢看工作消息你就死定了"]', '["不是吧你，出门前都不看一眼天气预报的吗", "淋感冒了我可不会伺候你"]'],
    task: ['["真服了，就这么点事也要专门叫我来翻呀", "都给你查清楚了，自己看牢"]', '["改完了，测试全过"]'],
    chat: ['["干嘛，突然神神秘秘的", "有话快说，别拿测试词试探我"]', '["哼，终于舍得冒头了呀"]'],
  },
}

function buildToneLines(state: MoodState, hint: { upset: boolean; task: boolean }, stanceId: StanceId): string[] {
  const w = toneWeights(state.tone)
  const scene = hint.task ? 'task' : hint.upset ? 'upset' : 'chat'
  if (w.r < TONE_NATURAL_RADIUS) {
    const [a, b] = TONE_EXEMPLARS.natural[scene]
    return [`语调偏向（自然）：像有体温和小脾气的亲近搭子发微信，日常倾诉/闲聊拆成 2~4 条长短错落短气泡（中位 6~16 字，无句末句号），收尾短词回 1 条（示范：${a} / ${b}）。`]
  }
  const coolOrGuarded = stanceId === 'cool' || stanceId === 'guarded'
  const effective: [Exclude<ToneId, 'natural'>, number][] = [
    ['warm', w.warm],
    ['witty', coolOrGuarded ? w.witty * 0.15 : w.witty],
    ['calm', w.calm],
    ['sharp', w.sharp],
  ]
  effective.sort((a, b) => b[1] - a[1])
  const primary = effective[0]![0]
  const second = effective[1]!
  const vivid = w.r > TONE_VIVID_RADIUS
  const blend = second[1] >= 0.24 ? `${TONE_LABELS[primary]} · ${TONE_LABELS[second[0]]}` : TONE_LABELS[primary]
  const rule = vivid ? TONE_VIVID_RULES[primary] : TONE_LIGHT_RULES[primary]
  const gateNote = coolOrGuarded && w.witty > 0.25 ? '（当前心境克制，收起调侃）' : state.turns % 2 === 1 ? '（隔轮冷却：换不同起手词，不重复上一轮口头禅）' : ''
  const [ex1, ex2] = TONE_EXEMPLARS[primary][scene]
  return [
    `语调偏向（${vivid ? '鲜明' : '轻度'}偏${blend} ${Math.round(w.r * 100)}%${gateNote}）：${rule}`,
    `短气泡示范（2~4 条鲜活短气泡，省去句末句号）：${ex1} / ${ex2}`,
  ]
}

/** Lightweight <mood> tone block injected when dynamic mood shifts are disabled but the 2D tone pad is off-center. */
export function toneOnlyContext(state: MoodState, text: string): string {
  const hint = guessOwner(text)
  return ['<mood>', ...buildToneLines(state, hint, 'partner'), '始终：只说自然大白话，严禁自我标榜人设、严禁引号拆词、严禁说“待命/派活/有活扔给我”。', '</mood>'].join('\n')
}

/** The block appended to the main agent's input for this turn. */
export function moodContext(state: MoodState, text: string, diary: DiaryEntry[] = []): string {
  const hint = guessOwner(text)
  const s = stanceFor(state, hint)
  const baseNote = Math.abs(state.undertone - state.mood) >= 0.15 || state.undertone <= GUARDED_UNDERTONE ? `，底子${moodWord(state.undertone)} ${round(state.undertone)}` : ''
  const lines = [
    '<mood>',
    `你此刻的心境：心情${moodWord(state.mood)}（${round(state.mood)}${baseNote}），${energyWord(state.energy)}（${round(state.energy)}），${patienceWord(state.patience)}（耐心 ${Math.round(state.patience)}/100），对主人的信任 ${Math.round(state.trust)}/100。它只影响语气，不影响你帮忙的程度和质量。`,
    `这轮的说话方式（${s.name}，按主人的话初步判断，你看了原话可以自己改判）：${s.rule}`,
    ...buildToneLines(state, hint, s.id),
    '始终：只说自然大白话，不演人设、不拆词、不写对称逗号句，没任务时绝不说“待命/派活/有事我顶着”。',
  ]
  if (state.grudge >= 0.25) lines.push('前几轮积了点怨气，一句好话哄不好，先保持分寸。')
  if (state.trust >= 60 && s.id !== 'cool' && s.id !== 'guarded') lines.push('你们够熟了：觉得主人哪里想错了，就直接、友善地指出来，不要顺着说。')
  if (state.lastFeedback === 'negative') lines.push('上一轮主人对你的回应不太满意：这次换个方式，别重复上次的做法。')
  // The diary only comes up when feelings are the topic, never while working.
  const feelings = hint.upset || s.id === 'listen' || s.id === 'banter' || s.id === 'cool' || s.id === 'guarded'
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
  // A lingering grudge discounts how fast praise cheers it back up (down to 30% at max grudge).
  const damp = 1 - 0.7 * s.grudge
  let dMood = 0, dEnergy = 0, dPatience = 0, dTrust = 0, dGrudge = 0
  switch (report.attitude) {
    case 'grateful': dMood += 0.2 * up * damp; dPatience += 8 * up * damp; dTrust += 2 * up * damp; dEnergy += 0.1; dGrudge -= 0.14 * up; break
    case 'respectful': dMood += 0.05 * up * damp; dPatience += 2 * up * damp; dTrust += 0.5 * up * damp; dGrudge -= 0.05 * up; break
    case 'dismissive': dMood -= 0.08 * down; dPatience -= 8 * down; dGrudge += 0.12 * down; break
    // Being snapped at stings, wears patience thin and builds a grudge; as with a friend under pressure, trust barely moves.
    case 'hostile': dMood -= 0.2 * down; dPatience -= 15 * down; dTrust -= 1 * down; dGrudge += (0.24 + 0.12 * k) * down; break
  }
  if (report.feedback === 'positive') { dMood += 0.1 * up * damp; dTrust += 1 * up * damp }
  if (report.feedback === 'negative') { dMood -= 0.1 * down; dGrudge += 0.06 * down }
  // The owner's own state rubs off a little: their excitement lifts energy, their distress weighs on mood.
  if (report.emotion === 'happy' || report.emotion === 'excited') { dMood += 0.1 * k * damp; dEnergy += 0.15 * k }
  if (['sad', 'anxious', 'frustrated', 'angry'].includes(report.emotion)) { dMood -= 0.05 * k; dEnergy += 0.1 * k }
  if (report.emotion === 'tired') dEnergy -= 0.1 * k
  const nextMood = clamp(s.mood + dMood, -1, 1)
  const nextUndertone = clamp(s.undertone + (nextMood - s.undertone) * 0.22, -1, 1)
  const next: MoodState = {
    ...s, mood: nextMood, undertone: nextUndertone, grudge: clamp(s.grudge + dGrudge, 0, 1),
    energy: clamp(s.energy + dEnergy, 0, 1), patience: clamp(s.patience + dPatience, 0, 100), trust: clamp(s.trust + dTrust, 0, 100),
    at: now, turns: s.turns + 1, lastFeedback: report.feedback ?? 'neutral',
  }
  next.history = [...s.history, { at: now, mood: round(next.mood), undertone: round(next.undertone), energy: round(next.energy), patience: Math.round(next.patience), trust: round(next.trust, 1),
    emotion: report.emotion, intensity: round(k), attitude: report.attitude, ...(s.lastText ? { note: s.lastText } : {}) }].slice(-HISTORY)
  return { state: next, delta: { mood: round(next.mood - s.mood), energy: round(next.energy - s.energy), patience: Math.round(next.patience - s.patience), trust: round(next.trust - s.trust, 1) } }
}

/**
 * A very light negative signal when the owner stops work mid-flight: often they already got what they needed, so one
 * stop barely nudges anything, while repeated impatient stops slowly add up.
 */
export function applyStop(state: MoodState, now = Date.now(), config: Pick<MindConfig, 'down'> = { down: 1 }, note = '中途停下'): MoodState {
  const s = settleMood(state, now)
  const down = clamp(config.down, SENSITIVITY.min, SENSITIVITY.max)
  const nextMood = clamp(s.mood - 0.03 * down, -1, 1)
  const nextUndertone = clamp(s.undertone + (nextMood - s.undertone) * 0.1, -1, 1)
  const next: MoodState = {
    ...s, mood: nextMood, undertone: nextUndertone, grudge: clamp(s.grudge + 0.03 * down, 0, 1),
    patience: clamp(s.patience - 2 * down, 0, 100), at: now,
  }
  next.history = [...s.history, { at: now, mood: round(next.mood), undertone: round(next.undertone), energy: round(next.energy),
    patience: Math.round(next.patience), trust: round(next.trust, 1), attitude: 'stopped', note: note.slice(0, 40) }].slice(-HISTORY)
  return next
}

const NEGATIVE_EMOTIONS = new Set<MoodReport['emotion']>(['angry', 'frustrated', 'sad', 'anxious'])

/** Whether a reported turn was heated enough that "facts" blurted out in it should wait in pending memory for confirmation. */
export function isHeatedTurn(r: { emotion?: string | undefined; intensity?: number | undefined; attitude?: string | undefined }): boolean {
  const k = Number(r.intensity ?? 0)
  if (r.attitude === 'hostile' && k >= 0.4) return true
  return Boolean(r.emotion && NEGATIVE_EMOTIONS.has(r.emotion as MoodReport['emotion']) && k >= 0.7)
}

// ── State kept in the plugin's own store ─────────────────────────────────────

const read = (state: StatePort) => settleMood(state.get<MoodState>('mood'))
export const moodEnabled = (state: StatePort) => state.get<boolean>('enabled') ?? true
export const mindConfig = (state: StatePort): MindConfig => ({ up: 1, down: 1, diary: true, ...(state.get<Partial<MindConfig>>('config') ?? {}) })
export const diaryOf = (state: StatePort): DiaryEntry[] => state.get<DiaryEntry[]>('diary') ?? []

/** Records a task stop as a faint negative signal when mood is switched on. */
export function recordMoodStop(state: StatePort, note?: string, now = Date.now()): void {
  if (!moodEnabled(state)) return
  state.set('mood', applyStop(read(state), now, mindConfig(state), note))
}

/** True when `mood_sync` recorded a heated turn within `[fromMs, toMs]` (with slack for step ordering). */
export function hadHeatedTurn(state: StatePort, fromMs: number, toMs = Date.now()): boolean {
  if (!moodEnabled(state)) return false
  const history = state.get<MoodState>('mood')?.history ?? []
  return history.some(p => p.at >= fromMs - 5_000 && p.at <= toMs + 60_000 && isHeatedTurn(p))
}

const portOf = (s: StatePort | { state: StatePort }): StatePort => ('state' in s ? s.state : s)

export function moodView(state: StatePort | { state: StatePort }): MoodView {
  const port = portOf(state)
  const s = read(port)
  const st = s.lastStance ? stance(s.lastStance) : stanceFor(s)
  // The last stance stops being true once the mood it came from has moved on (a reset, a drag, hours later).
  const shown = st.id === 'cool' && !(s.patience < 35 && s.mood < -0.3) ? stanceFor(s)
    : st.id === 'guarded' && !isGuarded(s) ? stanceFor(s)
    : st.id === 'banter' && !(s.mood > 0.5 && s.trust > 75) ? stanceFor(s) : st
  return { enabled: moodEnabled(port), mood: round(s.mood), undertone: round(s.undertone), energy: round(s.energy), patience: Math.round(s.patience), trust: round(s.trust, 1), summary: moodSummary(s),
    history: s.history, stance: { id: shown.id, name: shown.name, why: shown.why }, tone: describeTone(s.tone), config: mindConfig(port), baseline: BASELINE, diary: diaryOf(port) }
}
export function setMoodEnabled(state: StatePort | { state: StatePort }, enabled: boolean): void { portOf(state).set('enabled', enabled) }

/** Persists the 2D voice tone pad position ({ x, y } in [-1, 1]), snapping < 0.06 to origin (0, 0). */
export function setMoodTone(state: StatePort | { state: StatePort }, tone: MoodTone): MoodToneView {
  const port = portOf(state)
  const s = read(port)
  const nextTone = normalizeTone(tone)
  port.set('mood', { ...s, tone: nextTone })
  return describeTone(nextTone)
}

/** 回到平时: mood, undertone, grudge, energy and patience back to their baselines. Trust and the history stay. */
export function resetMood(state: StatePort): void {
  const s = read(state)
  state.set('mood', { ...s, mood: BASELINE.mood, undertone: BASELINE.mood, grudge: 0, energy: BASELINE.energy, patience: BASELINE.patience, lastStance: undefined })
}

/** The owner dragged a value in the window; it takes effect from the next message. */
export function setMoodValues(state: StatePort, values: Partial<Pick<MoodState, 'mood' | 'energy' | 'patience' | 'trust'>>): void {
  const s = read(state)
  const next = { ...s }
  if (values.mood !== undefined) {
    next.mood = clamp(values.mood, -1, 1)
    next.undertone = clamp(values.mood, -1, 1)
    if (next.mood >= 0) next.grudge = 0
  }
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
    const s = read(ctx.state)
    if (!moodEnabled(ctx.state)) {
      return Math.hypot(s.tone.x, s.tone.y) >= TONE_NATURAL_RADIUS ? toneOnlyContext(s, text) : undefined
    }
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
