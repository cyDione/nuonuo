/** Helpers for scripted mock models in tests (also used by the daemon's tests). */
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { convertArrayToReadableStream } from 'ai/test'

const usage = (input = 10, output = 5) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
})

export type Scripted = { text?: string; calls?: { name: string; input: unknown }[]; inputTokens?: number }

let callSeq = 0
export function streamOf(step: Scripted): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  const parts: LanguageModelV4StreamPart[] = []
  if (step.text) parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: step.text }, { type: 'text-end', id: 't' })
  for (const call of step.calls ?? []) {
    const id = `call_${++callSeq}`
    const input = JSON.stringify(call.input)
    parts.push({ type: 'tool-input-start', id, toolName: call.name }, { type: 'tool-input-delta', id, delta: input }, { type: 'tool-input-end', id },
      { type: 'tool-call', toolCallId: id, toolName: call.name, input })
  }
  parts.push({ type: 'finish', finishReason: { unified: step.calls?.length ? 'tool-calls' : 'stop', raw: undefined }, usage: usage(step.inputTokens) })
  return { stream: convertArrayToReadableStream(parts) }
}

/** The text of every user message in a call's prompt, for scripted models that react to what they were sent. */
export function userTexts(options: LanguageModelV4CallOptions): string[] {
  return options.prompt.filter(m => m.role === 'user').map(m => (m.content as any[]).map(p => p.text ?? '').join(''))
}
export function lastUserText(options: LanguageModelV4CallOptions): string {
  return userTexts(options).at(-1) ?? ''
}
export function systemText(options: LanguageModelV4CallOptions): string {
  return options.prompt.filter(m => m.role === 'system').map(m => m.content as string).join('\n')
}

export function generateOf(step: Scripted) {
  return {
    content: [
      ...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
      ...(step.calls ?? []).map(c => ({ type: 'tool-call' as const, toolCallId: `call_${++callSeq}`, toolName: c.name, input: JSON.stringify(c.input) })),
    ],
    finishReason: { unified: (step.calls?.length ? 'tool-calls' : 'stop') as 'stop', raw: undefined },
    usage: usage(step.inputTokens), warnings: [],
  }
}
