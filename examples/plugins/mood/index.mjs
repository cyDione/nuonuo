// 心境: gives the assistant a mood of its own (心情, 精力, 信任) that moves with how conversations go and drifts back over
// time, and tunes how it talks to the moment (focused work, venting, both at once) without ever helping less.
//
// No model calls of its own: before each answer the plugin appends a short <mood> block to the main agent's input
// (inlineContext, so the prompt cache stays intact), and the agent reports the owner's state with mood_sync in the same
// step as its reply. A turn whose report is missing just leaves the mood as it was. Memory is not touched: facts about
// the owner stay with Nuonuo's own memory.

import { apply, context, initial, settle } from './mood.mjs'

/** @param {import('@nuonuo/plugin-sdk').PluginSdk} sdk */
export default function plugin({ definePlugin, tool, z }) {
  const read = ctx => settle(ctx.state.get('mood') ?? initial())

  return definePlugin({
    id: 'mood',
    name: '心境',
    description: '糯糯自己的心情、精力和对你的信任，随对话变化、随时间回落。',

    inlineContext(ctx, { text }) {
      return context(read(ctx), text)
    },

    routerTools: ctx => ({
      mood_sync: tool({
        description: 'Report how the owner was in the message you are answering, in the same step as your reply (never a step of its own). Nothing is posted; it only updates your mood.',
        inputSchema: z.object({
          emotion: z.enum(['neutral', 'happy', 'excited', 'anxious', 'frustrated', 'sad', 'angry', 'tired']).describe("The owner's main feeling in this message"),
          intensity: z.number().min(0).max(1).describe('How strong that feeling is, 0..1'),
          attitude: z.enum(['respectful', 'casual', 'dismissive', 'hostile', 'grateful']).describe('How the owner treated you'),
          feedback: z.enum(['positive', 'neutral', 'negative']).describe('How the owner took your previous answer'),
        }),
        execute: async report => {
          const { state, delta } = apply(read(ctx), report)
          ctx.state.set('mood', state)
          return { ok: true, delta }
        },
      }),
      mood_reset: tool({
        description: 'Put your mood, energy and trust back to where they started. Only when the owner asks for it.',
        inputSchema: z.object({}),
        execute: async () => { ctx.state.set('mood', initial()); return { ok: true } },
      }),
    }),
  })
}
