import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { AgentRuntime, Bus } from '@nuonuo/agent-runtime'
import { generateOf, lastUserText, streamOf, systemText, type Scripted } from '@nuonuo/agent-runtime/src/testing'
import { kvSet, newId, openStore, schema, type Store } from '@nuonuo/db'
import { MemorySecrets, ModelHub } from '@nuonuo/models'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAgents } from './agents'
import { Engine } from './engine'
import { savePersona } from './persona'
import {
  buildVoiceFewShotMessages,
  extractCodeBlocks,
  extractRecentOpeners,
  extractTechnicalAnchors,
  matchClosingFastPath,
  restoreCodeBlocks,
  sanitizeVoiceBubbles,
  shouldBypassVoice,
  VOICE_DEFAULT_TEMPERATURE,
  VOICE_STYLE_BANK,
  VoiceRenderer,
} from './voice'

let store: Store
let runtime: AgentRuntime
afterEach(async () => {
  await runtime?.shutdown()
  store?.close()
})

describe('Split-Phase VoiceRenderer unit suites', () => {
  it('ensures VOICE_STYLE_BANK across all 5 tones has 0 Northern customer-service slang, 0 emojis, and 0 trailing periods', () => {
    const forbidden = /咋了|好嘞|那眯会儿呗|甭|瘫会儿|摸摸鱼缓缓|有活丢过来|待命|随时叫我|一句话[：:]|说白了[：:]|说说看/
    for (const [toneId, pairs] of Object.entries(VOICE_STYLE_BANK)) {
      expect(pairs.length, toneId).toBeGreaterThanOrEqual(5)
      for (const pair of pairs) {
        expect(pair.bubbles.length, `${toneId}:${pair.scene}`).toBeGreaterThanOrEqual(2)
        expect(pair.bubbles.length, `${toneId}:${pair.scene}`).toBeLessThanOrEqual(4)
        for (const b of pair.bubbles) {
          expect(b, `${toneId}:${b}`).not.toMatch(forbidden)
          expect(b.endsWith('。'), `${toneId}:${b}`).toBe(false)
        }
      }
    }
  })

  it('protects code blocks byte-for-byte, unwraps smuggled markdown blocks, and extracts technical anchors accurately', () => {
    const code = '```ts\nexport function checkSla(ms: number) {\n  return ms < 300;\n}\n```'
    const draft = `我已经看过了，\`package.json\` 的 name 是 \`pulseboard-sla-bench\`，报错是 ECONNREFUSED 端口 5432：\n${code}\n另外别忘了跑 vitest run。`
    const { textWithoutCode, codeBlocks } = extractCodeBlocks(draft)
    expect(codeBlocks).toEqual([code])
    expect(textWithoutCode).toContain('[CODE_BLOCK_0]')
    expect(textWithoutCode).not.toContain('export function checkSla')

    const anchors = extractTechnicalAnchors(textWithoutCode, '把刚才报错的 ECONNREFUSED 端口 5432 记一下')
    expect(anchors).toEqual(expect.arrayContaining(['package.json', 'pulseboard-sla-bench', 'ECONNREFUSED', '5432', 'vitest run']))

    const restored = restoreCodeBlocks(['都给你查好啦', '代码放这儿 [CODE_BLOCK_0] 拿去直接用吧'], codeBlocks)
    expect(restored).toEqual(['都给你查好啦', '代码放这儿', code, '拿去直接用吧'])

    // Prose-smuggled ```markdown block is unwrapped into plain text
    const smuggled = '```markdown\n- 第一条结论\n- 第二条结论\n```'
    const { textWithoutCode: unwrapped, codeBlocks: emptyBlocks } = extractCodeBlocks(smuggled)
    expect(emptyBlocks).toEqual([])
    expect(unwrapped).toContain('第一条结论')
  })

  it('fast-paths closing short words (行吧/嗯/哦/好的/ok) in 0ms and bypasses non-chat or long structured markdown', () => {
    expect(matchClosingFastPath('行吧', ['好嘞'], { x: 0, y: 0 })).toEqual(['嗯哼'])
    expect(matchClosingFastPath('行吧', ['嗯'], { x: 0.9, y: -0.8 })).toEqual(['哼'])
    expect(matchClosingFastPath('好的', ['嗯'], { x: -0.9, y: 0.8 })).toEqual(['嗯呐'])
    expect(matchClosingFastPath('知道了', ['好喔'], { x: 0, y: 0 })).toEqual(['好喔'])
    expect(matchClosingFastPath('刚出地铁站就开始下暴雨', ['快躲雨'], { x: 0, y: 0 })).toBeUndefined()

    expect(shouldBypassVoice({ draftText: '普通短句回复', isChatSource: false })).toBe(true)
    expect(shouldBypassVoice({ draftText: '普通短句回复', detailed: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '```ts\nconst a = 1\n```', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '| A | B |\n|---|---|\n| 1 | 2 |', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '# 标题一\n内容\n## 标题二\n更多内容', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '帮你查好啦，name 是 pulseboard-sla-bench。', isChatSource: true })).toBe(false)
  })

  it('dynamically blends few-shot messages across 2D coordinates and filters out recently used openers (Anti-Repetition Gate)', () => {
    const naturalMsgs = buildVoiceFewShotMessages({ x: 0, y: 0 }, [], 4)
    expect(naturalMsgs).toHaveLength(8) // 4 user + 4 assistant turns
    expect(naturalMsgs[0]?.role).toBe('user')
    expect(naturalMsgs[1]?.role).toBe('assistant')

    // Diagonal blend (0.6, -0.5) mixes sharp (+1,-1) and secondary quadrant
    const blendMsgs = buildVoiceFewShotMessages({ x: 0.6, y: -0.5 }, [], 5)
    expect(blendMsgs).toHaveLength(10)

    // Anti-repetition gate filters out '不是吧' and '啧' when they were used in the last assistant turns
    const recent = ['不是吧你，出门都不看天气\n快去躲雨', '啧，这么点小事也叫我']
    expect(extractRecentOpeners(recent)).toEqual(['不是吧', '啧'])
    const filteredSharp = buildVoiceFewShotMessages({ x: 0.95, y: -0.95 }, recent, 4)
    const firstBubbles = filteredSharp.filter(m => m.role === 'assistant').map(m => String(m.content).split('\n')[0]!)
    expect(firstBubbles.some(b => b.startsWith('不是吧'))).toBe(false)
    expect(firstBubbles.some(b => b.startsWith('啧'))).toBe(false)
  })

  it('sanitizes stage brackets, emojis, JSON arrays, Northern slang, and trailing periods while enforcing 1..4 bubbles', () => {
    const dirty = '["（微笑）在呢，咋了。", "*sighs* 好嘞，先去瘫会儿吧😂。", "那眯会儿呗，有活丢过来。"]'
    expect(sanitizeVoiceBubbles(dirty, ['备用'])).toEqual([
      '在呢，怎么啦',
      '好呀，先去躺着歇会儿吧',
      '先去歇会儿吧',
    ])

    // Restores missing technical anchors if LLM accidentally dropped one
    const withAnchor = sanitizeVoiceBubbles(
      '帮你记下来啦\n明天再查就行',
      ['报错 ECONNREFUSED 端口 5432 已记下'],
      [],
      ['ECONNREFUSED', '5432'],
    )
    expect(withAnchor.join('\n')).toContain('ECONNREFUSED')
    expect(withAnchor.join('\n')).toContain('5432')
  })

  it('calls the voice layer with 0 tools, 0.88 default temperature, multi-turn history, and falls back smoothly on error/off', async () => {
    store = openStore(':memory:')
    savePersona(store, { name: '糯糯', personality: '优雅、可爱、叛逆' })
    kvSet(store, 'plugin:mood:state:mood', { mood: 0.5, undertone: 0.4, grudge: 0, energy: 0.7, patience: 75, trust: 80, at: Date.now(), turns: 2, lastFeedback: 'positive', history: [], tone: { x: 0.85, y: -0.85 } })

    const voiceCalls: LanguageModelV4CallOptions[] = []
    const routerModel = new MockLanguageModelV4({
      doStream: async o => {
        const last = lastUserText(o)
        if (o.prompt.at(-1)?.role === 'tool') return streamOf({ text: 'done' })
        const cnv = /conversation_id="([a-z]+_[a-z0-9]+)"/.exec(last)?.[1]
        return streamOf({
          calls: [{
            name: 'reply',
            input: {
              conversation_id: cnv,
              bubbles: ['下暴雨没带伞很容易感冒，快去附近便利店躲雨。'],
            },
          }],
        })
      },
      doGenerate: async o => generateOf({ text: systemText(o) }),
    })
    const voiceModel = new MockLanguageModelV4({
      doGenerate: async o => {
        voiceCalls.push(o)
        return generateOf({
          text: '不是吧你，出门前都不看一眼天气预报的吗。\n（叉腰）还不快钻进旁边便利店躲一躲😂\n万一淋感冒了我就要找你麻烦了。',
        })
      },
    })

    const hub = new ModelHub(store, new MemorySecrets(), {
      language: (_p, _k, model) => (model === 'voice-vivid' ? voiceModel : routerModel),
      embedding: () => { throw new Error('unused') },
    })
    const p = hub.createProvider({ kind: 'openai', name: 'mock', apiKey: 'k' })
    hub.saveRole('router', { chain: [{ providerId: p.id, model: 'router-fast' }] })
    hub.saveRole('voice', { chain: [{ providerId: p.id, model: 'voice-vivid' }] })

    const bus = new Bus()
    runtime = new AgentRuntime(store, hub, bus)
    const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'nn-voice-')) })
    registerAgents(store, runtime, engine)

    const cnv = engine.mainConversation()
    engine.receiveMessage(cnv, '刚出地铁站就开始下暴雨，还没带伞，服了')
    for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 30)); await runtime.idle() }

    expect(voiceCalls).toHaveLength(1)
    const call = voiceCalls[0]!
    // 0 tools mounted on the voice call!
    expect(call.tools).toBeUndefined()
    expect(call.temperature).toBeCloseTo(VOICE_DEFAULT_TEMPERATURE)

    const assistantMsg = store.db.select().from(schema.messages).all().find(m => m.conversationId === cnv && m.role === 'assistant')!
    expect((assistantMsg.meta as { bubbles?: string[] }).bubbles).toEqual([
      '不是吧你，出门前都不看一眼天气预报的吗',
      '还不快钻进旁边便利店躲一躲',
      '万一淋感冒了我就要找你麻烦了',
    ])

    // When voice layer is switched off (enabled: false), VoiceRenderer bypasses in 0ms without calling voiceModel
    hub.saveRole('voice', { enabled: false, chain: [] })
    const renderer = new VoiceRenderer(store, hub)
    const bypassed = await renderer.render({
      conversationId: cnv,
      draftBubbles: ['直接原样返回。'],
      userText: '测试关闭声带层',
    })
    expect(bypassed.bypassed).toBe(true)
    expect(bypassed.bubbles).toEqual(['直接原样返回'])
    expect(voiceCalls).toHaveLength(1)
  })
})
