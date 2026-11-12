// The mood model of the 心境 plugin: plain functions over a small state object, no model calls of its own.
//
// State: mood (心情, -1..1), energy (精力, 0..1), trust (信任, 0..100). Mood and energy drift back to their baselines
// over time (half-life MOOD_HALF_LIFE_H hours); trust moves slowly and does not drift. What moves them is the report the
// main agent files with `mood_sync` in the same step as its reply: how the owner felt and how they treated it.
//
// The tone rules only ever change how the assistant talks (length, warmth, directness). They never make it less
// helpful: an owner who is short with it still gets a full answer.

export const BASELINE = { mood: 0.2, energy: 0.5, trust: 50 }
export const MOOD_HALF_LIFE_H = 6
const HISTORY = 50

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d

/** A fresh state. */
export function initial(now = Date.now()) {
  return { ...BASELINE, at: now, turns: 0, lastFeedback: 'neutral', history: [] }
}

/** The state with mood and energy drifted back toward their baselines for the time since it was last touched. */
export function settle(state, now = Date.now()) {
  const s = { ...initial(now), ...(state ?? {}) }
  const hours = Math.max(0, (now - (s.at ?? now)) / 3_600_000)
  const keep = Math.pow(0.5, hours / MOOD_HALF_LIFE_H)
  return { ...s, mood: BASELINE.mood + (s.mood - BASELINE.mood) * keep, energy: BASELINE.energy + (s.energy - BASELINE.energy) * keep, at: now }
}

// Cheap first guess at the owner's state from the words of the new message, so this turn's tone fits this turn (the
// agent's own report only arrives after it answered). Only a hint: the prompt asks the agent to judge for itself.
const UPSET = /烦|崩溃|气死|受不了|无语|急死|焦虑|难受|郁闷|伤心|累死|好累|累了|绝望|怎么又|又挂|又报错|又出|搞不定|心态|哭|唉|妈的|卧槽|tmd|wtf|ugh|frustrat|annoy|stress|upset|sad|angry|!!|！！|\?\?|？？/i
const TASK = /报错|错误|异常|bug|挂了|崩了|500|404|超时|失败|修|改|帮我|怎么|如何|能不能|写一个|写个|部署|上线|安装|配置|查一下|看看|error|fail|fix|deploy|how (do|to)|can you|please/i

export function guess(text = '') {
  const t = String(text).slice(0, 2_000)
  return { upset: UPSET.test(t), task: TASK.test(t) }
}

/** Which way of talking fits, as an ordered rule list (the first that matches wins). */
export function stance(state, hint = { upset: false, task: false }) {
  if (hint.upset && hint.task) return { id: 'comrade', name: '并肩解决', rule: '对方正为一件事着急。先用一句话说中卡住的地方，接着直接给能做的下一步或答案；不说空洞的安慰。' }
  if (hint.upset) return { id: 'listen', name: '先接住', rule: '对方主要是在倾诉。先回应感受，用自己的话说，不急着列建议；对方问了再给办法。' }
  if (hint.task) return { id: 'focus', name: '专注干活', rule: '对方要把事办成。直接给结论和步骤，不寒暄，不加没被问到的延伸。' }
  if (state.mood > 0.5 && state.trust > 75) return { id: 'banter', name: '老朋友', rule: '心情不错，彼此熟。可以轻松一点、偶尔打趣。' }
  return { id: 'partner', name: '平常', rule: '平稳、真诚、平等地聊。' }
}

const label = (v, lo, hi, words) => words[Math.min(words.length - 1, Math.floor(((v - lo) / (hi - lo)) * words.length))]

/** The block appended to the main agent's input for this turn (short: about 150 Chinese characters plus the rules). */
export function context(state, text) {
  const s = stance(state, guess(text))
  const mood = label(state.mood, -1, 1, ['低落', '有点闷', '平静', '不错', '很好'])
  const energy = label(state.energy, 0, 1, ['没什么劲', '平稳', '有精神'])
  const lines = [
    '<mood>',
    `你此刻的心境：心情${mood}（${round(state.mood)}），${energy}（${round(state.energy)}），对主人的信任 ${Math.round(state.trust)}/100。它只影响语气，不影响你帮忙的程度和质量。`,
    `这轮的说话方式（${s.name}，按主人的话初步判断，你看了原话可以自己改判）：${s.rule}`,
    '始终：不说客服套话（“非常理解您的感受”“抱抱你”之类），共情要具体、用自己的话。',
  ]
  if (state.trust >= 60) lines.push('你们够熟了：觉得主人哪里想错了，就直接、友善地指出来，不要顺着说。')
  if (state.lastFeedback === 'negative') lines.push('上一轮主人对你的回应不太满意：这次换个方式，别重复上次的做法。')
  lines.push('回复主人时，在同一步里顺手调用 mood_sync，简单报告主人这轮的状态；不要为它单独多走一步，也不要在回复里提到它。', '</mood>')
  return lines.join('\n')
}

/** Applies the agent's report of a turn. Returns the new state and what moved. */
export function apply(state, report, now = Date.now()) {
  const s = settle(state, now)
  const before = { mood: s.mood, energy: s.energy, trust: s.trust }
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
  if (['happy', 'excited'].includes(report.emotion)) { mood += 0.1 * k; energy += 0.15 * k }
  if (['sad', 'anxious', 'frustrated', 'angry'].includes(report.emotion)) { mood -= 0.05 * k; energy += 0.1 * k }
  if (report.emotion === 'tired') energy -= 0.1 * k
  const next = {
    ...s, mood: clamp(mood, -1, 1), energy: clamp(energy, 0, 1), trust: clamp(trust, 0, 100), at: now, turns: (s.turns ?? 0) + 1,
    lastFeedback: report.feedback ?? 'neutral',
  }
  const delta = { mood: round(next.mood - before.mood), energy: round(next.energy - before.energy), trust: round(next.trust - before.trust, 1) }
  next.history = [...(s.history ?? []), { at: now, mood: round(next.mood), energy: round(next.energy), trust: round(next.trust, 1), emotion: report.emotion, attitude: report.attitude }].slice(-HISTORY)
  return { state: next, delta }
}
