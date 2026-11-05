import { tool } from 'ai'
import { z } from 'zod'
import type { AgentRuntime } from '../runtime'

export function recallTool(runtime: AgentRuntime) {
  return {
    recall: tool({
      description: 'Read an object by its id: blob_… (spilled output, paged), tkt_… (task), trg_… (message), cnv_… (conversation), ses_… (a helper\'s session log, paged), or a thread id such as github:owner/repo#12 (its events and the work on it). Results inline the ids of related objects so you can follow the chain.',
      inputSchema: z.object({ ref: z.string().regex(/^([a-z]+_[a-z0-9]+|[a-z]+:\S+)$/), page: z.number().int().min(1).optional() }),
      execute: async ({ ref, page }) => runtime.recall(ref, page),
    }),
  }
}
