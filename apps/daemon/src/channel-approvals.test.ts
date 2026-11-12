import { Bus } from '@nuonuo/agent-runtime'
import type { Engine, Reviewer } from '@nuonuo/core'
import type { OutgoingMessage, SourceRegistry } from '@nuonuo/sources'
import { describe, expect, it } from 'vitest'
import { ChannelApprovals } from './channel-approvals'

function harness(opts: { approvalsIn?: boolean; source?: string } = {}) {
  const bus = new Bus()
  const approvals = new Map<string, { id: string; ticketId: string; status: string; reason: string; input: Record<string, unknown> }>()
  const decided: [string, boolean, string | undefined][] = []
  const reviewer = {
    pending: () => [...approvals.values()].filter(a => a.status === 'pending'),
    get: (id: string) => approvals.get(id),
    decide: (id: string, approve: boolean, note?: string) => { decided.push([id, approve, note]); approvals.get(id)!.status = approve ? 'approved' : 'denied'; bus.emit({ type: 'approval.updated', approvalId: id }) },
  } as unknown as Reviewer
  const tickets: Record<string, { id: string; title: string; threadId: string }> = {
    tkt_tg: { id: 'tkt_tg', title: '清理磁盘', threadId: 'telegram:42:0' },
    tkt_web: { id: 'tkt_web', title: '网页里的任务', threadId: 'webchat:cnv_1' },
  }
  const engine = { ticket: (id: string) => tickets[id]!, replySource: (_r: unknown, id: string) => (id === 'tkt_tg' ? opts.source ?? 'telegram' : 'webchat') } as unknown as Engine
  const sent: (OutgoingMessage & { source: string })[] = []
  const sources = { approvalsIn: () => opts.approvalsIn ?? true, send: (m: OutgoingMessage & { source: string }) => { sent.push(m) } } as unknown as SourceRegistry
  const bridge = new ChannelApprovals(bus, engine, reviewer, sources)
  bridge.register()
  const ask = (id: string, ticketId: string) => {
    approvals.set(id, { id, ticketId, status: 'pending', reason: '要删除文件', input: { command: 'rm -rf build' } })
    bus.emit({ type: 'approval.updated', approvalId: id })
  }
  return { ask, sent, decided, sources }
}

describe('approvals in chat channels', () => {
  it('asks in the chat the task came from, takes the answer from there, and marks the card', () => {
    const h = harness()
    h.ask('apv_1', 'tkt_tg')
    h.ask('apv_2', 'tkt_web')
    expect(h.sent).toEqual([expect.objectContaining({ source: 'telegram', threadId: 'telegram:42:0', approval: { id: 'apv_1', state: 'pending' }, text: expect.stringContaining('rm -rf build') })])
    expect(() => h.sources.onApprovalAnswer!('discord', 'apv_1', true, 'x')).toThrow('不属于这里')
    h.sources.onApprovalAnswer!('telegram', 'apv_1', true, 'Telegram @owner')
    expect(h.decided).toEqual([['apv_1', true, '在 Telegram @owner 回答']])
    expect(h.sent.at(-1)).toMatchObject({ approval: { id: 'apv_1', state: 'approved' }, text: '已同意' })
    expect(() => h.sources.onApprovalAnswer!('telegram', 'apv_1', false, 'x')).toThrow('已经处理过了')
  })

  it('stays out of channels where the owner did not allow it', () => {
    const h = harness({ approvalsIn: false })
    h.ask('apv_1', 'tkt_tg')
    expect(h.sent).toEqual([])
  })
})
