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
  computeBubbleBudget,
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
  it('ensures VOICE_STYLE_BANK across all 5 tones follows the 1:2:3 = 2:3:1 golden bubble distribution (0 four-bubble exemplars) with 0 slang or standby tails', () => {
    const forbidden =
      /咋了|好嘞|那眯会儿呗|甭|瘫会儿|摸摸鱼缓缓|有活丢过来|待命|随时叫我|随时喊我|随时找我|跟我说一声|闲着也是闲着|一句话[：:]|说白了[：:]|说说看/
    for (const [toneId, pairs] of Object.entries(VOICE_STYLE_BANK)) {
      expect(pairs.length, toneId).toBe(6)
      const oneBubble = pairs.filter(p => p.bubbles.length === 1).length
      const twoBubble = pairs.filter(p => p.bubbles.length === 2).length
      const threeBubble = pairs.filter(p => p.bubbles.length === 3).length
      const fourPlusBubble = pairs.filter(p => p.bubbles.length >= 4).length
      expect({ toneId, oneBubble, twoBubble, threeBubble, fourPlusBubble }).toEqual({
        toneId,
        oneBubble: 2,
        twoBubble: 3,
        threeBubble: 1,
        fourPlusBubble: 0,
      })
      for (const pair of pairs) {
        for (const b of pair.bubbles) {
          expect(b, `${toneId}:${b}`).not.toMatch(forbidden)
          expect(b.endsWith('。'), `${toneId}:${b}`).toBe(false)
        }
      }
    }
  })

  it('computes 3-tier bubble budgets (light / normal / rich) based on owner message length and density', () => {
    for (const shortInput of ['哈喽哇', '吃了吃了', '下午还没安排呢', '真的假的', '在干嘛', '刚醒', '好无聊啊', '哈哈哈哈', '今天不想动', '走了我去忙会儿']) {
      const b = computeBubbleBudget({
        userText: shortInput,
        draftTextWithoutCode: '哪怕大脑草稿写得比较长、甚至有二十五个字以上的寒暄，也必须按主人话量归入轻简档。',
        anchorsCount: 0,
        codeBlocksCount: 0,
      })
      expect(b.tier, shortInput).toBe('light')
      expect(b.targetBubbles, shortInput).toBe('1')
      expect(b.maxSpokenBubbles, shortInput).toBe(2)
      expect(b.bubbleGuide, shortInput).toContain('优先只回 1 条')
    }

    // Normal ordinary sentence (11~20 chars, no story/vent, <=1 anchor) -> maxSpokenBubbles = 2
    const normalCalm = computeBubbleBudget({
      userText: '今天中午准备去吃碗牛肉面吧',
      draftTextWithoutCode: '牛肉面挺好的，热乎乎吃一碗很舒服。',
      anchorsCount: 0,
      codeBlocksCount: 0,
    })
    expect(normalCalm.tier).toBe('normal')
    expect(normalCalm.maxSpokenBubbles).toBe(2)

    // Normal mishap/story sentence -> maxSpokenBubbles = 3
    const normalStory = computeBubbleBudget({
      userText: '刚出地铁站就开始下暴雨，还没带伞，服了',
      draftTextWithoutCode: '快去附近便利店躲雨别淋感冒了。',
      anchorsCount: 0,
      codeBlocksCount: 0,
    })
    expect(normalStory.tier).toBe('normal')
    expect(normalStory.maxSpokenBubbles).toBe(3)

    // Rich tier: >=2 technical anchors or code blocks
    const richTech = computeBubbleBudget({
      userText: '帮我看下 package.json 里的 name 和 test 脚本是啥',
      draftTextWithoutCode: '查好了，name 是 nuonuo，test 脚本是 vitest run。',
      anchorsCount: 3,
      codeBlocksCount: 0,
    })
    expect(richTech.tier).toBe('rich')
    expect(richTech.maxSpokenBubbles).toBe(3)
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

  it('fast-paths closing short words (行吧/嗯/哦/好的/ok) in 0ms and bypasses tasks, code blocks, 2-item lists, headings, tables, or non-chat', () => {
    expect(matchClosingFastPath('行吧', ['好嘞'], { x: 0, y: 0 })).toEqual(['嗯哼'])
    expect(matchClosingFastPath('行吧', ['嗯'], { x: 0.9, y: -0.8 })).toEqual(['哼'])
    expect(matchClosingFastPath('好的', ['嗯'], { x: -0.9, y: 0.8 })).toEqual(['嗯呐'])
    expect(matchClosingFastPath('知道了', ['好喔'], { x: 0, y: 0 })).toEqual(['好喔'])
    expect(matchClosingFastPath('刚出地铁站就开始下暴雨', ['快躲雨'], { x: 0, y: 0 })).toBeUndefined()

    expect(shouldBypassVoice({ draftText: '普通短句回复', isChatSource: false })).toBe(true)
    expect(shouldBypassVoice({ draftText: '普通短句回复', detailed: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '任务已完成，共清理 3 个临时目录。', isChatSource: true, ticketId: 'tkt_123' })).toBe(true)
    expect(shouldBypassVoice({ draftText: '```ts\nconst a = 1\n```', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '用下面这段代码即可：\n```ts\nconst a = 1\n```\n跑完记得重启。', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '| A | B |\n|---|---|\n| 1 | 2 |', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '# 标题一\n简短说明', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '- 接口 A: 18ms\n- 接口 B: 42ms', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '1. 第一步检查配置\n2. 第二步启动服务', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '1、第一步\n2、第二步', isChatSource: true })).toBe(true)
    expect(shouldBypassVoice({ draftText: '帮你查好啦，name 是 pulseboard-sla-bench。', isChatSource: true })).toBe(false)
  })

  it('dynamically blends few-shot messages with 1-bubble and 2-bubble exemplars and filters out recently used openers', () => {
    const naturalMsgs = buildVoiceFewShotMessages({ x: 0, y: 0 }, [], 5)
    expect(naturalMsgs).toHaveLength(10) // 5 user + 5 assistant turns
    const assistantCounts = naturalMsgs.filter(m => m.role === 'assistant').map(m => String(m.content).split('\n').length)
    expect(assistantCounts).toContain(1)
    expect(assistantCounts).toContain(2)
    expect(assistantCounts.filter(n => n === 3).length).toBeLessThanOrEqual(1)
    expect(assistantCounts.some(n => n >= 4)).toBe(false)

    // Diagonal blend (0.6, -0.5) mixes sharp (+1,-1) and secondary quadrant while keeping 1 & 2 bubble balance
    const blendMsgs = buildVoiceFewShotMessages({ x: 0.6, y: -0.5 }, [], 5)
    const blendCounts = blendMsgs.filter(m => m.role === 'assistant').map(m => String(m.content).split('\n').length)
    expect(blendCounts).toContain(1)
    expect(blendCounts).toContain(2)
    expect(blendCounts.filter(n => n === 3).length).toBeLessThanOrEqual(1)

    // Anti-repetition gate filters out '不是吧' and '啧' when they were used in the last assistant turns
    const recent = ['不是吧你，出门都不看天气\n快去躲雨', '啧，这么点小事也叫我']
    expect(extractRecentOpeners(recent)).toEqual(['不是吧', '啧'])
    const filteredSharp = buildVoiceFewShotMessages({ x: 0.95, y: -0.95 }, recent, 4)
    const firstBubbles = filteredSharp.filter(m => m.role === 'assistant').map(m => String(m.content).split('\n')[0]!)
    expect(firstBubbles.some(b => b.startsWith('不是吧'))).toBe(false)
    expect(firstBubbles.some(b => b.startsWith('啧'))).toBe(false)
  })

  it('sanitizes stage brackets, emojis, JSON arrays, Northern slang, quote-dissection, and standby tails while enforcing maxSpokenBubbles', () => {
    const dirty = '["（微笑）在呢，咋了。", "*sighs* 好嘞，先去瘫会儿吧😂。", "那眯会儿呗，有活丢过来。"]'
    expect(sanitizeVoiceBubbles(dirty, ['备用'])).toEqual([
      '在呢，怎么啦',
      '好呀，先去躺着歇会儿吧',
      '先去歇会儿吧',
    ])

    // Strips trailing standby tails ("我下午本来也就在这边待着，又跑不了", "想好干什么了跟我说一声就行", "反正我今天闲着也是闲着")
    expect(
      sanitizeVoiceBubbles(
        '真呀，骗你干嘛\n我下午本来也就在这边待着，又跑不了\n想好干什么了跟我说一声就行',
        ['真呀'],
        [],
        [],
        2,
      ),
    ).toEqual(['真呀，骗你干嘛'])

    expect(
      sanitizeVoiceBubbles(
        '空着就空着嘛，多难得\n别又急着给自己塞一堆活\n真想动弹的话，我陪你一起挑\n反正我今天闲着也是闲着',
        ['空着多难得'],
        [],
        [],
        2,
      ),
    ).toEqual(['空着就空着嘛，多难得', '别又急着给自己塞一堆活'])

    // Strips quote-dissecting lines ("听你这两个“吃了”", "“哇”字拖这么长")
    expect(
      sanitizeVoiceBubbles(
        '听你这两个“吃了”，怎么有点敷衍我\n不是饿着肚子硬说饱了吧',
        ['吃饱就好'],
        [],
        [],
        2,
      ),
    ).toEqual(['不是饿着肚子硬说饱了吧'])

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

  it('forces single-bubble whole-block output (0ms bypass, no meta.bubbles) for ticket_id task reports, short lists, code blocks, headings, and tables even if Router passes bubbles[]', async () => {
    store = openStore(':memory:')
    savePersona(store, { name: '糯糯', personality: '优雅、可爱、叛逆' })

    const voiceCalls: LanguageModelV4CallOptions[] = []
    let nextReplyInput: Record<string, unknown> = {}
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
              ...nextReplyInput,
            },
          }],
        })
      },
      doGenerate: async o => generateOf({ text: systemText(o) }),
    })
    const voiceModel = new MockLanguageModelV4({
      doGenerate: async o => {
        voiceCalls.push(o)
        return generateOf({ text: '在呢，刚发了会儿呆' })
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
    const engine = new Engine(store, runtime, bus, { home: mkdtempSync(join(tmpdir(), 'nn-voice-single-')) })
    registerAgents(store, runtime, engine)

    const cnv = engine.mainConversation()
    const renderer = new VoiceRenderer(store, hub)

    // 1. Direct VoiceRenderer.render bypass checks (0ms, 0 LLM calls) for ticketId, codeBlock, 2-item list, heading, table
    for (const sample of [
      { ticketId: 'tkt_demo', draftText: '后台任务已完成，共处理 12 个文件。' },
      { draftText: '配置修改如下：\n```ts\nexport const PORT = 7420;\n```' },
      { draftText: '- 接口 A: 18ms\n- 接口 B: 42ms' },
      { draftText: '### 检查汇总\n全部通过。' },
      { draftText: '| 模块 | 状态 |\n|---|---|\n| core | ok |' },
    ]) {
      const res = await renderer.render({
        conversationId: cnv,
        isChatSource: true,
        ...sample,
      })
      expect(res.bypassed, sample.draftText).toBe(true)
      expect(res.bubbles, sample.draftText).toEqual([sample.draftText])
    }
    expect(voiceCalls).toHaveLength(0)

    // 2. Router reply tool with ticket_id + accidental bubbles[] -> saved as 1 single complete bubble without meta.bubbles
    const { triggerId } = engine.receiveMessage(cnv, '帮我检查一下当前目录结构并汇总')
    const ticket = engine.startTask({ triggerIds: [triggerId], title: '检查目录' })
    nextReplyInput = {
      ticket_id: ticket.id,
      bubbles: ['目录检查完成。', '共有 packages/core 和 apps/web 两个主目录。'],
    }
    engine.receiveMessage(cnv, '进度怎么样了')
    for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 30)); await runtime.idle() }

    const assistantMsgs = store.db.select().from(schema.messages).all().filter(m => m.conversationId === cnv && m.role === 'assistant')
    const taskReplyMsg = assistantMsgs.at(-1)!
    expect(taskReplyMsg.ticketId).toBe(ticket.id)
    expect(taskReplyMsg.content).toBe('目录检查完成\n共有 packages/core 和 apps/web 两个主目录')
    expect((taskReplyMsg.meta as { bubbles?: string[] }).bubbles).toBeUndefined()
    expect(voiceCalls).toHaveLength(0)

    // 3. Router reply tool with 2-item short list or code block in bubbles[] -> saved as 1 single complete bubble without meta.bubbles
    nextReplyInput = {
      bubbles: ['- 接口 A: 18ms', '- 接口 B: 42ms'],
    }
    engine.receiveMessage(cnv, '把那两个接口的耗时列一下')
    for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 30)); await runtime.idle() }

    const listReplyMsg = store.db.select().from(schema.messages).all().filter(m => m.conversationId === cnv && m.role === 'assistant').at(-1)!
    expect(listReplyMsg.content).toBe('- 接口 A: 18ms\n- 接口 B: 42ms')
    expect((listReplyMsg.meta as { bubbles?: string[] }).bubbles).toBeUndefined()
    expect(voiceCalls).toHaveLength(0)

    // 4. Casual short greeting ('哈喽哇') still invokes VoiceRenderer normally
    nextReplyInput = {
      bubbles: ['在呢，下午正好空着。'],
    }
    engine.receiveMessage(cnv, '哈喽哇')
    for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 30)); await runtime.idle() }
    expect(voiceCalls).toHaveLength(1)
  })
})
