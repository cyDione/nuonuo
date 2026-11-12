import { APICallError } from '@ai-sdk/provider'
import { openStore, schema, type Store } from '@nuonuo/db'
import { MockLanguageModelV4, MockSpeechModelV4, MockTranscriptionModelV4 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelFactory } from './factory'
import { ModelHub } from './hub'
import { roleSpec } from './roles'
import { MemorySecrets } from './secrets'

let store: Store
afterEach(() => store?.close())

const response = { timestamp: new Date(0), modelId: 'm' }

describe('speech layers', () => {
  function setup(failFirst = false) {
    store = openStore(':memory:')
    const heard: Uint8Array[] = []
    let calls = 0
    const factory: ModelFactory = {
      language: () => new MockLanguageModelV4(),
      embedding: () => { throw new Error('none') },
      transcription: (_p, _k, model) => new MockTranscriptionModelV4({ modelId: model, doGenerate: async ({ audio }) => {
        calls++
        if (failFirst && calls === 1) throw new APICallError({ message: 'busy', url: 'x', requestBodyValues: {}, statusCode: 503, isRetryable: true })
        heard.push(audio as Uint8Array)
        return { text: ' 明天提醒我买菜 ', segments: [], language: 'zh', durationInSeconds: 2, warnings: [], response }
      } }),
      speech: () => new MockSpeechModelV4({ doGenerate: async ({ text }) => ({ audio: new TextEncoder().encode(`mp3:${text}`), warnings: [], response }) }),
    }
    const hub = new ModelHub(store, new MemorySecrets(), factory)
    const id = hub.createProvider({ kind: 'openai', name: 'o', apiKey: 'k' }).id
    return { hub, id, heard }
  }

  it('are off until the owner picks a model, and listed as speech layers', async () => {
    const { hub } = setup()
    expect(roleSpec('transcribe').kind).toBe('transcription')
    expect(roleSpec('speech').kind).toBe('speech')
    expect(await hub.transcribe(new Uint8Array([1]))).toBeUndefined()
    expect(await hub.speak('你好')).toBeUndefined()
  })

  it('transcribe and speak through the layer, writing a ledger row per call', async () => {
    const { hub, id, heard } = setup()
    hub.saveRole('transcribe', { chain: [{ providerId: id, model: 'whisper-1' }] })
    hub.saveRole('speech', { chain: [{ providerId: id, model: 'tts-1' }] })
    expect(await hub.transcribe(new Uint8Array([1, 2]))).toEqual({ text: '明天提醒我买菜', language: 'zh' })
    expect(heard[0]).toEqual(new Uint8Array([1, 2]))
    const audio = await hub.speak('好的')
    expect(new TextDecoder().decode(audio!.bytes)).toBe('mp3:好的')
    expect(audio!.mime).toMatch(/^audio\//)
    expect(store.db.select().from(schema.usageLedger).all().map(r => [r.role, r.model, r.ok])).toEqual([['transcribe', 'whisper-1', true], ['speech', 'tts-1', true]])
  })

  it('falls back along the chain', async () => {
    const { hub, id } = setup(true)
    hub.saveRole('transcribe', { chain: [{ providerId: id, model: 'a' }, { providerId: id, model: 'b' }] })
    expect((await hub.transcribe(new Uint8Array([1])))?.text).toBe('明天提醒我买菜')
    expect(store.db.select().from(schema.usageLedger).all().map(r => [r.model, r.ok])).toEqual([['a', false], ['b', true]])
  })
})
