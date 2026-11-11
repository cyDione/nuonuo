/**
 * 糯糯's own notification sounds: short, soft chimes made with Web Audio (no audio files). A message rises two notes, a
 * change in 动态 is one bright ping, and what waits for your OK climbs three notes so it stands apart. 设置 · 通知 · 提示音
 * picks them over the system's sound; the desktop app calls `window.__saChime` from its main process.
 */
import type { Notice } from './api'

const NOTES: Record<Notice['kind'], number[]> = {
  message: [659.25, 880], test: [659.25, 880], approval: [523.25, 659.25, 783.99],
  feed: [1046.5], price: [880, 1174.66], ideas: [783.99, 1046.5],
}

let ctx: AudioContext | null = null

export function playChime(kind: Notice['kind'] = 'message') {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const start = ctx.currentTime + 0.02
    const out = ctx.createGain()
    out.gain.value = 0.18
    out.connect(ctx.destination)
    NOTES[kind].forEach((freq, i) => {
      const at = start + i * 0.11
      for (const [mult, level] of [[1, 1], [2, 0.18]] as const) {
        const osc = ctx!.createOscillator(), gain = ctx!.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq * mult
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(level, at + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42)
        osc.connect(gain).connect(out)
        osc.start(at)
        osc.stop(at + 0.45)
      }
    })
  } catch { /* no audio here */ }
}

;(window as { __saChime?: typeof playChime }).__saChime = playChime
