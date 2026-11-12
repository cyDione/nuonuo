/**
 * Domain types, adapted for a single owner from dsh-superagent's model (MIT): a Source's events are Triggers on Threads;
 * the router turns them into Tickets (units of authorized work) whose Workers subscribe to the Threads they came from.
 */
export type ReportStatus = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

export interface HumanAction { question: string; options?: string[]; kind?: 'question' | 'handoff' }

export interface Report { status: ReportStatus; summary: string; humanAction?: HumanAction; files?: string[]; at: number }

export interface Attention extends HumanAction { at: number }

export interface Ended {
  at: number
  /** `person` covers both the panel's stop button and the router stopping on the owner's request. */
  by: 'person' | 'router' | 'worker' | 'system'
  outcome: 'completed' | 'stopped' | 'dropped' | 'merged' | 'closed'
  reason?: string
}

/** `explicit`: the owner (or an allowed account) asked. `proactive`: the owner's proactive strategy chose it; it works silently. */
export interface Mandate { by: 'owner' | 'policy'; strength: 'explicit' | 'proactive'; triggerIds: string[]; at: number; reason?: string; policy?: number }

export interface Ticket {
  id: string
  name: string
  title: string
  note: string | null
  threadId: string
  origin: { triggerIds: string[] }
  mandate: Mandate
  directory: string
  sessionId: string
  latestReport: Report | null
  attention: Attention | null
  ended: Ended | null
  createdAt: number
  updatedAt: number
}

/** Mutually exclusive, first match wins (the table of dsh-superagent's 003 Execution, simplified). */
export type TicketStage = 'person/approve' | 'person/answer' | 'person/blocked' | 'person/failed' | 'queued' | 'working' | 'idle' | 'ended'

export const STAGE_LABEL: Record<TicketStage, string> = {
  'person/approve': '等你批准',
  'person/answer': '等你回答',
  'person/blocked': '受阻',
  'person/failed': '失败',
  queued: '排队中',
  working: '进行中',
  idle: '等待中',
  ended: '已结束',
}

export const webchatThread = (conversationId: string) => `webchat:${conversationId}`
export const conversationOf = (threadId: string) => (threadId.startsWith('webchat:') ? threadId.slice('webchat:'.length) : undefined)
export const sourceOfThread = (threadId: string) => threadId.split(':')[0] ?? 'webchat'

/** An event from an external source, already translated by its Source kind. */
/** A file kept in the attachments folder (an uploads row): attached by the owner in the web, or sent in a chat app. */
export interface Attachment { id: string; name: string; mime: string; size: number; path: string }

export interface IncomingTrigger {
  /** Stable and derived from the source's own id, so re-reading the source never duplicates. */
  id: string
  source: string
  threadId: string
  actor: string
  human: boolean
  /** The message mentions the agent (or is a direct message). */
  addressed: boolean
  text: string
  at: number
  url?: string
  meta?: Record<string, unknown>
  /** Files that came with it, already kept in the attachments folder (SourceContext.saveFile). */
  attachments?: Attachment[]
  /** How the thread's mirror conversation is titled and linked. */
  thread: { title: string; url?: string; meta?: Record<string, unknown> }
}

/** What the engine needs from the source registry. */
export interface SourcePort {
  /** May this actor ask for work on this source? (The owner's own identity there, or an allowlisted account.) */
  allowed(source: string, actor: string): boolean
  /** Whether the source can carry replies back (GitHub can; routines cannot, so their replies stay in the web). */
  hasChannel(source: string): boolean
  /** Whether the source is a chat app (made with defineChannel): its replies stay short and the owner's words there count as chat. */
  isChannel?(source: string): boolean
  /** Queues a message for the source's channel inside the caller's transaction. */
  send(message: { messageId: string; source: string; threadId: string; text: string; ticketId?: string }): void
}
