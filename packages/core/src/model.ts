/**
 * Domain types, adapted for a single owner from dsh-superagent's model (MIT): a Source's events are Triggers on Threads;
 * the router turns them into Tickets (units of authorized work) whose Workers subscribe to the Threads they came from.
 */
export type ReportStatus = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

export interface HumanAction { question: string; options?: string[] }

export interface Report { status: ReportStatus; summary: string; humanAction?: HumanAction; at: number }

export interface Attention extends HumanAction { at: number }

export interface Ended {
  at: number
  /** `person` covers both the panel's stop button and the router stopping on the owner's request. */
  by: 'person' | 'router' | 'worker' | 'system'
  outcome: 'completed' | 'stopped' | 'dropped'
  reason?: string
}

export interface Mandate { by: 'owner'; strength: 'explicit'; triggerIds: string[]; at: number }

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
export type TicketStage = 'person/answer' | 'person/blocked' | 'person/failed' | 'queued' | 'working' | 'idle' | 'ended'

export const STAGE_LABEL: Record<TicketStage, string> = {
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
