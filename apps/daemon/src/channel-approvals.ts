/**
 * Approvals in chat channels (docs/12-channels.md): when a task that came from a chat app (Telegram, Feishu, Discord…)
 * needs the owner's yes, and the owner turned on 允许在这里回答「要不要做」 for that channel, the question also goes to
 * the chat it came from, as buttons or as 「回复同意或拒绝」. An answer there is accepted only from the channel's allowed
 * accounts and only for that channel's own tasks; once answered anywhere, the chat's card is marked.
 */
import type { Bus } from '@nuonuo/agent-runtime'
import type { Engine, Reviewer } from '@nuonuo/core'
import type { SourceRegistry } from '@nuonuo/sources'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const OUTCOME = { approved: '已同意', denied: '已拒绝', expired: '已失效' } as const

export class ChannelApprovals {
  /** Approvals asked in a channel: where, so their answer can be marked there. */
  private asked = new Map<string, { source: string; threadId: string }>()
  private seen = new Set<string>()

  constructor(private bus: Bus, private engine: Engine, private reviewer: Reviewer, private sources: SourceRegistry) {
    // Approvals already waiting when the service starts are not asked again.
    for (const a of reviewer.pending()) this.seen.add(a.id)
    sources.onApprovalAnswer = (source, id, approve, by) => this.answer(source, id, approve, by)
  }

  register(): () => void {
    return this.bus.on(event => {
      if (event.type !== 'approval.updated') return
      try { this.update(String((event as { approvalId?: string }).approvalId)) } catch (error) { console.error('[channel-approvals]', error) }
    })
  }

  private update(id: string): void {
    const approval = this.reviewer.get(id)
    if (!approval) return
    const asked = this.asked.get(id)
    if (approval.status !== 'pending') {
      if (!asked) return
      this.asked.delete(id)
      const state = approval.status as keyof typeof OUTCOME
      this.sources.send({ messageId: `${id}:${state}`, source: asked.source, threadId: asked.threadId, text: OUTCOME[state] ?? approval.status, approval: { id, state: state in OUTCOME ? state : 'expired' } })
      return
    }
    if (this.seen.has(id)) return
    this.seen.add(id)
    const ticket = this.engine.ticket(approval.ticketId)
    const source = this.engine.replySource(undefined, ticket.id)
    if (source === 'webchat' || !ticket.threadId.startsWith(`${source}:`) || !this.sources.approvalsIn(source)) return
    const input = approval.input as { command?: string; card?: { title?: string } }
    const what = input.card?.title ?? approval.reason
    const text = `需要你确认（${clip(ticket.title, 40)}）：${clip(what, 200)}\n${clip(String(input.command ?? ''), 300)}`.trim()
    this.asked.set(id, { source, threadId: ticket.threadId })
    this.sources.send({ messageId: `${id}:ask`, source, threadId: ticket.threadId, text, approval: { id, state: 'pending' } })
  }

  private answer(source: string, id: string, approve: boolean, by: string): void {
    const approval = this.reviewer.get(id)
    if (!approval) throw new Error('没有这个确认')
    if (approval.status !== 'pending') throw new Error('这个确认已经处理过了')
    if (!this.engine.ticket(approval.ticketId).threadId.startsWith(`${source}:`)) throw new Error('这个确认不属于这里的任务')
    this.reviewer.decide(id, approve, `在 ${by} 回答`)
  }
}
