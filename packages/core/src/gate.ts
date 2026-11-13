/**
 * The one permission gate for the agents' tools. A tool does not carry its own checks: whoever lends it (a source, a
 * plugin, an MCP server, the local apps) declares a policy (what it does and what it reaches), and this gate turns
 * the owner's 权限 settings and the review layer into one decision: hide the tool, run it, ask the owner, or block.
 *
 * Shell commands keep their own classifier (risk from the command line, the sandbox, folders), reached through
 * `shell()` here so every path an agent can act through is in one place.
 */
import type { Tool, ToolSet } from 'ai'
import { APP_NAMES, type LocalAccess, type LocalApp } from './access'
import type { GateDecision, Reviewer } from './review'
import type { Ticket } from './model'

export interface ToolPolicy {
  /** `read` tools are never gated; `write` tools change something outside the task. */
  effect: 'read' | 'write'
  /** One of the owner's apps the tool reaches (Google Calendar is 日历 too): follows that app's level in 权限. */
  app?: LocalApp
  /** The connected source the tool acts in: its writes disappear while the owner set it to 只能看. */
  source?: string
  /** Code the app cannot vouch for (a third-party plugin): each write is asked, whatever 权限 says. */
  thirdParty?: boolean
  /** Writes pass the review layer: allow / deny lists, the external-action level and the reviewer model (MCP servers marked for review). */
  review?: boolean
}

/** What the gate needs to know about one call. `toolId` names the executor that runs it after an approval. */
export interface ToolCall { toolId: string; display: string; input: Record<string, unknown> }

export const pendingNote = (d: { approvalId: string; reason: string }) => `[需要主人批准（${d.approvalId}）：${d.reason}。批准后会自动执行，结果作为新消息送达。]`

export class ToolGate {
  constructor(private access: LocalAccess, private reviewer: Reviewer | undefined) {}

  /** Whether the tool is offered at all: hidden when its app is off, and writes hidden at 只能看. */
  visible(policy: ToolPolicy | undefined): boolean {
    if (!policy) return true
    if (policy.app) {
      const level = this.access.app(policy.app)
      if (level === 'off' || (policy.effect === 'write' && level === 'read')) return false
    }
    if (policy.effect === 'write' && policy.source && this.access.settings().sources[policy.source] === 'read') return false
    return true
  }

  /** Decides one call. Visibility is checked again, since settings may change between offering a tool and its call. */
  async check(ticket: Ticket, sessionId: string, call: ToolCall, policy: ToolPolicy | undefined): Promise<GateDecision> {
    if (!policy || policy.effect === 'read') return { action: 'allow', by: 'normal' }
    if (policy.app) {
      const level = this.access.app(policy.app)
      const name = APP_NAMES[policy.app]
      if (level === 'off' || level === 'read') return this.block(ticket, call, `按主人的设置，「${name}」${level === 'read' ? '只能看，不能改' : '不允许使用'}`)
      // Without a review layer (tests, embedded use) 先问你 cannot ask, and runs as before; a plugin's write never does.
      if (policy.thirdParty && !this.reviewer) return this.block(ticket, call, `要改「${name}」需要主人批准，但审批没有启用`)
      if ((level === 'ask' || policy.thirdParty) && this.reviewer) {
        return this.reviewer.askOwner(ticket, sessionId, call.toolId, call.display, { ...call.input, label: `改${name}` }, `要改你的「${name}」，按设置先问你`)
      }
    }
    if (policy.source && this.access.settings().sources[policy.source] === 'read') return this.block(ticket, call, '按主人的设置，这个来源只能看，不能在里面做事')
    if (policy.thirdParty && !policy.app) {
      if (!this.reviewer) return this.block(ticket, call, '这是插件的写操作，需要主人批准，但审批没有启用')
      return this.reviewer.askOwner(ticket, sessionId, call.toolId, call.display, call.input, '第三方插件要做改动，先问你')
    }
    if (policy.review && this.reviewer) return this.reviewer.gateTool(ticket, sessionId, call.toolId, call.display, call.input)
    if (policy.app) this.reviewer?.audit({ ticketId: ticket.id, actor: 'system', action: 'review', tool: call.toolId, input: call.display, risk: 'external', decision: 'allow', reason: '按你的权限设置直接做' })
    return { action: 'allow', by: 'normal' }
  }

  /** A shell command, through the reviewer's command classifier. */
  shell(ticket: Ticket, sessionId: string, command: string, cwd: string, remote?: { tool: string; input: Record<string, unknown> }): Promise<GateDecision> {
    if (!this.reviewer) return Promise.resolve({ action: 'allow', by: 'normal' })
    return this.reviewer.gateShell(ticket, sessionId, command, cwd, remote)
  }

  /**
   * Applies the policies to a set of tools: hidden ones are left out, gated writes ask or block before they run.
   * An approved call runs later through the executor registered under its toolId (`source:<name>` or `plugin:<name>`).
   */
  wrap(tools: ToolSet, policyOf: (name: string) => ToolPolicy | undefined, ticket: Ticket, sessionId: string, describe: (name: string, args: unknown, policy: ToolPolicy) => string = defaultDisplay): ToolSet {
    const out: ToolSet = {}
    for (const [name, t] of Object.entries(tools)) {
      const policy = policyOf(name)
      if (!this.visible(policy)) continue
      if (!policy || policy.effect === 'read' || !t.execute) { out[name] = t; continue }
      const run = t.execute.bind(t)
      const toolId = policy.thirdParty && !policy.app ? `plugin:${name}` : `source:${name}`
      this.reviewer?.registerExecutor(toolId, async input => String(await run(input.args as never, { toolCallId: 'approved', messages: [] } as never)))
      out[name] = {
        ...t,
        execute: async (args: unknown, options: unknown) => {
          const input = policy.thirdParty && !policy.app ? { args, label: `插件 ${name}` } : { args }
          const decision = await this.check(ticket, sessionId, { toolId, display: describe(name, args, policy), input }, policy)
          if (decision.action === 'block') throw new Error(decision.reason)
          if (decision.action === 'escalate') return pendingNote(decision)
          return run(args as never, options as never)
        },
      } as Tool
    }
    return out
  }

  private block(ticket: Ticket, call: ToolCall, reason: string): GateDecision {
    this.reviewer?.audit({ ticketId: ticket.id, actor: 'rule', action: 'review', tool: call.toolId, input: call.display, risk: 'external', decision: 'block', reason })
    return { action: 'block', by: 'rule', reason }
  }
}

function defaultDisplay(name: string, args: unknown, policy: ToolPolicy): string {
  return `${policy.app ? APP_NAMES[policy.app] : '插件'}：${name} ${JSON.stringify(args)}`
}
