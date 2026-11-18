import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { generateOf, lastUserText, streamOf, systemText, type Scripted } from '@nuonuo/agent-runtime/src/testing'
import { persona, readVoiceMoodSnapshot, setRouterTrust } from '@nuonuo/core'
import { newId, schema } from '@nuonuo/db'
import { ModelHub } from '@nuonuo/models'
import { MOOD_PLUGIN_ID, moodView } from '@nuonuo/plugins'
import { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from './config'
import { EventMapper, type ClientEvent } from './events'
import { notifySettings } from './notices'
import { createRuntime, type Runtime } from './runtime'
import { clientPrefs, settingsTools, UpdateMySettingsSchema } from './settings-tools'

let rt: Runtime

beforeEach(async () => {
  process.env.NUONUO_HOME = mkdtempSync(join(tmpdir(), 'nn-settings-test-'))
  process.env.NUONUO_SECRETS = 'file'
  rt = await createRuntime(resolveConfig({ port: 7420 }), { lock: false })
})

afterEach(async () => {
  await rt.close()
})

const callCtx = { toolCallId: 'call_test', messages: [] } as any

describe('settings-tools (get_my_settings & update_my_settings)', () => {
  it('1) reads all settings domains via get_my_settings with zero API key or secret leakage', async () => {
    const anthropic = rt.hub.createProvider({
      kind: 'anthropic',
      name: 'Claude Main',
      apiKey: 'sk-ant-super-secret-key-999999',
      options: { headers: { Authorization: 'Bearer secret-header-token-777' } },
    })
    const openai = rt.hub.createProvider({
      kind: 'openai',
      name: 'OpenAI Backup',
      apiKey: 'sk-proj-openai-secret-888888',
    })
    rt.hub.saveRole('router', {
      enabled: true,
      chain: [{ providerId: anthropic.id, model: 'claude-sonnet-4-6' }],
      reasoning: 'auto',
    })
    rt.skills.create({ name: '周报汇总', when: '每周五整理周报时', steps: '1. 读取日历\n2. 汇总任务' })

    const tools = settingsTools(rt)
    const getSettings = (input: any) => tools.get_my_settings!.execute!(input, callCtx) as Promise<any>
    const allRes = await getSettings({ domain: 'all' })
    expect(allRes.ok).toBe(true)
    expect(allRes.persona).toMatchObject({ name: '糯糯', avatar: 'mascot', role: 'all', language: 'auto' })
    expect(allRes.mood).toMatchObject({
      enabled: true,
      tone: { id: 'natural', label: '自然', x: 0, y: 0 },
      config: { up: 1, down: 1, diary: true },
    })
    expect(allRes.models.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: anthropic.id, name: 'Claude Main', kind: 'anthropic', enabled: true, hasKey: true }),
        expect.objectContaining({ id: openai.id, name: 'OpenAI Backup', kind: 'openai', enabled: true, hasKey: true }),
      ]),
    )
    expect(allRes.models.resolved.router).toMatchObject({
      source: 'router',
      model: { providerId: anthropic.id, model: 'claude-sonnet-4-6' },
      effectiveReasoning: 'auto',
    })
    expect(allRes.preferences).toMatchObject({ theme: 'system', accent: 'berry', readAloud: false })
    expect(allRes.notifications).toMatchObject({ banner: true, quiet: { on: false, from: '23:00', to: '08:00' } })
    expect(allRes.connections.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '周报汇总', enabled: true })]),
    )
    expect(allRes.security).toMatchObject({
      readOnly: true,
      access: expect.objectContaining({ folders: expect.any(Array) }),
      review: expect.objectContaining({ external: expect.any(String), destructive: expect.any(String) }),
      execution: expect.objectContaining({ sandbox: expect.any(Object) }),
    })

    // Zero key leakage assertion across all domains
    const serialized = JSON.stringify(allRes)
    expect(serialized).not.toContain('sk-ant-super-secret-key-999999')
    expect(serialized).not.toContain('999999')
    expect(serialized).not.toContain('sk-proj-openai-secret-888888')
    expect(serialized).not.toContain('888888')
    expect(serialized).not.toContain('secret-header-token-777')
    expect(serialized).not.toContain('secretRef')
    expect(serialized).not.toContain('keyHint')

    // Single domain queries return only the requested domain
    for (const domain of ['persona', 'mood', 'models', 'preferences', 'notifications', 'connections', 'security'] as const) {
      const single = await getSettings({ domain })
      expect(single.ok).toBe(true)
      expect(single[domain]).toBeDefined()
    }
  })

  it('2) updates persona, mood (warm/sharp/natural & reset), models (switch, reasoning, voice toggle), preferences (SSE prefs.updated), and notifications quiet hours', async () => {
    const p1 = rt.hub.createProvider({ kind: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-1' })
    const p2 = rt.hub.createProvider({ kind: 'openai', name: 'OpenAI', apiKey: 'sk-oai-2' })
    rt.hub.saveRole('router', { enabled: true, chain: [{ providerId: p1.id, model: 'claude-sonnet-4-6' }] })
    const sk = rt.skills.create({ name: '代码自检', when: '提交前', steps: '运行 pnpm check' })

    const mapper = new EventMapper()
    const sseEvents: ClientEvent[] = []
    const off = rt.bus.on(ev => {
      sseEvents.push(...mapper.map(ev))
    })

    try {
      const tools = settingsTools(rt)
      const updateSettings = (input: any) => tools.update_my_settings!.execute!(input, callCtx) as Promise<any>

      // (a) Persona + Mood warm preset
      const res1 = await updateSettings({
        persona: {
          name: '千绪',
          avatar: '🦊',
          role: 'life',
          language: 'zh',
          personality: '温柔机敏、有分寸',
          limits_add: ['绝不替主人做决定'],
        },
        mood: {
          tone_preset: 'warm',
          diary: false,
          sensitivity_up: 1.4,
          sensitivity_down: 0.7,
          values: { mood: -0.5, energy: 0.2, patience: 25 },
        },
      })

      expect(res1.ok).toBe(true)
      expect(persona(rt.store)).toMatchObject({
        name: '千绪',
        avatar: '🦊',
        role: 'life',
        language: 'zh',
        personality: '温柔机敏、有分寸',
        limits: ['绝不替主人做决定'],
      })
      const warmMood = moodView(rt.plugins.stateOf(MOOD_PLUGIN_ID))
      expect(warmMood.tone).toMatchObject({ id: 'warm', label: '温和' })
      expect(warmMood.tone.x).toBeLessThan(-0.7)
      expect(warmMood.tone.y).toBeGreaterThan(0.7)
      expect(warmMood.config).toEqual({ up: 1.4, down: 0.7, diary: false })
      expect(readVoiceMoodSnapshot(rt.store).toneId).toBe('warm')

      // (b) Mood sharp -> natural -> reset
      await updateSettings({ mood: { tone_preset: 'sharp', tone_strength: 0.85 } })
      expect(moodView(rt.plugins.stateOf(MOOD_PLUGIN_ID)).tone).toMatchObject({ id: 'sharp', label: '犀利', x: 0.85, y: -0.85 })
      expect(readVoiceMoodSnapshot(rt.store).toneId).toBe('sharp')

      await updateSettings({ mood: { tone_preset: 'natural', reset: true, enabled: false } })
      const resetView = moodView(rt.plugins.stateOf(MOOD_PLUGIN_ID))
      expect(resetView.enabled).toBe(false)
      expect(resetView.tone).toMatchObject({ id: 'natural', label: '自然', x: 0, y: 0 })
      expect(resetView.mood).toBeCloseTo(resetView.baseline.mood)
      expect(resetView.energy).toBeCloseTo(resetView.baseline.energy)
      expect(resetView.patience).toBe(resetView.baseline.patience)

      // (c) Models: auto-resolve provider from model prefix, change reasoning, and toggle voice layer
      const modelRes = await updateSettings({
        models: {
          role: 'router',
          model: 'gpt-4o',
          reasoning: 'high',
          temperature: 0.6,
          daily_token_limit: 200_000,
        },
      })
      expect(modelRes.ok).toBe(true)
      expect(rt.hub.roleConfigs().router).toMatchObject({
        enabled: true,
        chain: [{ providerId: p2.id, model: 'gpt-4o' }],
        reasoning: 'high',
        temperature: 0.6,
        dailyTokenLimit: 200_000,
      })

      await updateSettings({ models: { role: 'voice', enabled: false } })
      expect(rt.hub.roleConfigs().voice?.enabled).toBe(false)
      expect(rt.hub.resolve('voice')).toBeUndefined()

      await updateSettings({ models: { role: 'voice', enabled: true, model: 'inherit' } })
      expect(rt.hub.roleConfigs().voice?.enabled).toBe(true)
      expect(rt.hub.resolve('voice')?.config.chain[0]).toEqual({ providerId: p2.id, model: 'gpt-4o' })

      // Array of model layer updates in one call (e.g. router reasoning + voice temperature)
      const batchModelsRes = await updateSettings({
        models: [
          { role: 'router', reasoning: 'low' },
          { role: 'voice', temperature: 0.9 },
        ],
      })
      expect(batchModelsRes.ok).toBe(true)
      expect(rt.hub.roleConfigs().router?.reasoning).toBe('low')
      expect(rt.hub.roleConfigs().voice?.temperature).toBe(0.9)

      // (d) Preferences & Notifications & Ideas & Skill Toggle
      const prefRes = await updateSettings({
        preferences: {
          theme: 'dark',
          accent: 'mint',
          read_aloud: true,
          voice_rate: 'fast',
          text_size: 'large',
          reduce_motion: true,
        },
        notifications: {
          sound: true,
          quiet_on: true,
          quiet_from: '22:30',
          quiet_to: '07:30',
        },
        ideas: { cadence: 'weekly', hour: 9 },
        proactive_budget: { concurrent: 4, daily: 40 },
        skill_toggle: { id_or_name: '代码自检', enabled: false },
      })
      expect(prefRes.ok).toBe(true)
      expect(clientPrefs(rt.store)).toMatchObject({
        theme: 'dark',
        accent: 'mint',
        readAloud: true,
        voiceRate: 'fast',
        text: 'large',
        reduceMotion: true,
      })
      expect(notifySettings(rt.store)).toMatchObject({
        sound: true,
        quiet: { on: true, from: '22:30', to: '07:30' },
      })
      expect(rt.ideas.settings()).toEqual({ cadence: 'weekly', hour: 9 })
      expect(rt.skills.get(sk.id).enabled).toBe(false)

      // Verify SSE events emitted through EventMapper
      expect(sseEvents).toEqual(
        expect.arrayContaining([
          { type: 'persona.updated' },
          expect.objectContaining({
            type: 'prefs.updated',
            patch: expect.objectContaining({
              theme: 'dark',
              accent: 'mint',
              readAloud: true,
              read_aloud: true,
              voiceRate: 'fast',
              text: 'large',
              reduceMotion: true,
            }),
          }),
          expect.objectContaining({
            type: 'settings.updated',
            keys: expect.arrayContaining(['client-prefs', 'notify', 'ideas', 'proactive', 'skills']),
          }),
        ]),
      )
    } finally {
      off()
    }
  })

  it('3) enforces security red lines: blocks external trust context, locks reviewer layer, and forbids security self-escalation', async () => {
    const p = rt.hub.createProvider({ kind: 'openai', name: 'OpenAI', apiKey: 'sk-test' })
    rt.hub.saveRole('router', { enabled: true, chain: [{ providerId: p.id, model: 'gpt-4o-mini' }] })
    rt.hub.saveRole('reviewer', { enabled: true, chain: [{ providerId: p.id, model: 'gpt-4o' }] })

    const tools = settingsTools(rt)
    const updateSettings = (input: any) => tools.update_my_settings!.execute!(input, callCtx) as Promise<any>

    // (a) External trust context (`trust === 'external'`) is hard-blocked
    setRouterTrust(rt.engine, 'external')
    const extAttempt = await updateSettings({
      persona: { name: '被劫持的名字' },
      mood: { tone_preset: 'sharp' },
      preferences: { theme: 'dark' },
    })
    expect(extAttempt).toEqual({
      ok: false,
      error: 'Only the owner in direct conversation can modify settings.',
    })
    expect(persona(rt.store).name).toBe('糯糯')
    expect(moodView(rt.plugins.stateOf(MOOD_PLUGIN_ID)).tone.id).toBe('natural')

    // Restore owner direct trust
    setRouterTrust(rt.engine, 'user')

    // (b) `reviewer` model layer cannot be modified via schema OR execute
    expect(UpdateMySettingsSchema.safeParse({ models: { role: 'reviewer', model: 'gpt-4o-mini' } }).success).toBe(false)
    const reviewerAttempt = await updateSettings({ models: { role: 'reviewer', model: 'gpt-4o-mini' } })
    expect(reviewerAttempt.ok).toBe(false)
    expect(reviewerAttempt.error).toMatch(/reviewer/i)
    expect(rt.hub.roleConfigs().reviewer?.chain[0]?.model).toBe('gpt-4o')

    // (c) Direct security/sandbox/access payload is rejected with open link
    const secAttempt = await updateSettings({ security: { sandbox: 'off' } })
    expect(secAttempt.ok).toBe(false)
    expect(secAttempt.open).toEqual({ route: 'pane/permissions', label: '打开权限' })
  })

  it('4) takes effect in the exact same turn: update_my_settings({ persona: { name: "千绪" }, mood: { tone_preset: "warm" } }) -> reply renders VoiceRenderer as "千绪" in "warm" tone even after legacy refusal history', async () => {
    const voiceCalls: LanguageModelV4CallOptions[] = []
    let routerStep = 0

    const routerModel = new MockLanguageModelV4({
      doStream: async o => {
        const last = lastUserText(o)
        const cnv = /conversation_id="([a-z]+_[a-z0-9]+)"/.exec(last)?.[1] ?? rt.engine.mainConversation()
        routerStep++
        if (routerStep === 1) {
          return streamOf({
            calls: [
              {
                name: 'update_my_settings',
                input: {
                  persona: { name: '千绪' },
                  mood: { tone_preset: 'warm' },
                },
              },
            ],
          } satisfies Scripted)
        }
        if (routerStep === 2) {
          return streamOf({
            calls: [
              {
                name: 'reply',
                input: {
                  conversation_id: cnv,
                  bubbles: ['好呀，已经把语调调成温和，名字也改成千绪啦'],
                },
              },
            ],
          } satisfies Scripted)
        }
        return streamOf({ text: 'done' })
      },
      doGenerate: async o => generateOf({ text: systemText(o) }),
    })

    const voiceModel = new MockLanguageModelV4({
      doGenerate: async o => {
        voiceCalls.push(o)
        return generateOf({
          text: '好呀，以后就叫我千绪啦\n语调也乖乖帮你切到温和模式啦',
        })
      },
    })

    rt.hub = new ModelHub(rt.store, rt.secrets, {
      language: (_p, _k, model) => (model === 'voice-cord' ? voiceModel : routerModel),
      embedding: () => {
        throw new Error('unused')
      },
    })
    const p = rt.hub.createProvider({ kind: 'openai', name: 'mock', apiKey: 'k' })
    rt.hub.saveRole('router', { enabled: true, chain: [{ providerId: p.id, model: 'router-brain' }] })
    rt.hub.saveRole('voice', { enabled: true, chain: [{ providerId: p.id, model: 'voice-cord' }] })
    ;(rt.agents as any).hub = rt.hub
    ;(rt.engine as any).runtime = rt.agents

    const cnv = rt.engine.mainConversation()
    // Seed legacy refusal messages in conversation history to verify immunity
    rt.store.db.insert(schema.messages).values([
      {
        id: newId('msg'),
        conversationId: cnv,
        role: 'user',
        content: '把你的语调设置改为温和',
        meta: { source: 'webchat' },
        createdAt: Date.now() - 20_000,
      },
      {
        id: newId('msg'),
        conversationId: cnv,
        role: 'assistant',
        content: '真改不了呀，开关长在你那边的设置里呢',
        meta: { bubbles: ['真改不了呀，开关长在你那边的设置里呢'] },
        createdAt: Date.now() - 19_000,
      },
      {
        id: newId('msg'),
        conversationId: cnv,
        role: 'user',
        content: '那你把名字改成千绪',
        meta: { source: 'webchat' },
        createdAt: Date.now() - 10_000,
      },
      {
        id: newId('msg'),
        conversationId: cnv,
        role: 'assistant',
        content: '千绪这名字挑得真雅，可惜改名的活得落在你手上',
        meta: { bubbles: ['千绪这名字挑得真雅，可惜改名的活得落在你手上'] },
        createdAt: Date.now() - 9_000,
      },
    ]).run()

    rt.engine.receiveMessage(cnv, '现在直接把语调改成温和，名字改成千绪')
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 30))
      await rt.agents.idle()
    }

    // Verify database state was updated before VoiceRenderer ran
    expect(persona(rt.store).name).toBe('千绪')
    expect(readVoiceMoodSnapshot(rt.store).toneId).toBe('warm')

    // Verify VoiceRenderer saw the updated name "千绪" and "温和" tone in the very same turn
    expect(voiceCalls).toHaveLength(1)
    const voiceSys = systemText(voiceCalls[0]!)
    expect(voiceSys).toContain('你是千绪')
    expect(voiceSys).toContain('主导风味：温和')
    expect(voiceSys).toContain('尊重已完成的自我设置变更')

    // Legacy refusal lines were scrubbed from voice prompt history
    const voicePromptSerialized = JSON.stringify(voiceCalls[0]!.prompt)
    expect(voicePromptSerialized).not.toContain('开关长在你那边的设置里呢')
    expect(voicePromptSerialized).not.toContain('可惜改名的活得落在你手上')

    // Verify final saved assistant message
    const msgs = rt.store.db.select().from(schema.messages).all().filter(m => m.conversationId === cnv && m.role === 'assistant')
    const latest = msgs.at(-1)!
    expect(latest.content).toBe('好呀，以后就叫我千绪啦\n语调也乖乖帮你切到温和模式啦')
    expect((latest.meta as { bubbles?: string[] }).bubbles).toEqual([
      '好呀，以后就叫我千绪啦',
      '语调也乖乖帮你切到温和模式啦',
    ])
  })
})
