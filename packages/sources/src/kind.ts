/**
 * The Source plugin protocol (after dsh-superagent's SourceKind, MIT): a kind reads events from somewhere, turns them into
 * Triggers, writes replies back through its channel, and can lend the agents tools, prompt text and environment.
 * Its settings form is generated from `fields`, so a new source needs no UI code.
 */
import type { TurnContext } from '@super-agent/agent-runtime'
import type { Engine, Ticket } from '@super-agent/core'
import type { Store } from '@super-agent/db'
import type { ToolSet } from 'ai'
import type { z } from 'zod'

interface FieldBase { key: string; label: string; hint?: string; advanced?: true }
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; placeholder?: string }
  | FieldBase & { type: 'list'; placeholder?: string }
  | FieldBase & { type: 'select'; options: { value: string; label: string }[] }

export type Health = { status: 'off' | 'starting' | 'ok' | 'error'; detail?: string; at: number }

export interface SourceContext<C> {
  readonly id: string
  readonly config: C
  readonly engine: Engine
  readonly store: Store
  readonly signal: AbortSignal
  /** Small persistent state owned by this source (cursors, caches). */
  state: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
  /** Facts shown on the settings card (the account in use, ...). */
  facts(facts: Record<string, string>): void
  health(status: Health['status'], detail?: string): void
  log(...args: unknown[]): void
}

export interface OutgoingMessage { messageId: string; threadId: string; text: string; ticketId?: string }

export interface SourceKind<C = any> {
  id: string
  title: string
  description: string
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** Built-in sources that run until switched off. */
  defaultEnabled?: boolean
  /** Begins reading; the returned function stops it. Called when the source is enabled with a valid configuration. */
  start(ctx: SourceContext<C>): (() => void | Promise<void>) | void
  /** Reads once now (the settings page's "sync now", tests). */
  poll?(ctx: SourceContext<C>): Promise<void>
  /** May this account ask for work through this source? */
  allowed?(ctx: SourceContext<C>, actor: string): boolean
  /** Sends a message; `gone` when the conversation can never receive it. Throws to retry later. */
  send?(ctx: SourceContext<C>, message: OutgoingMessage): Promise<{ url?: string } | 'gone'>
  threadInfo?(ctx: SourceContext<C>, threadId: string): string | undefined
  routerPrompt?(ctx: SourceContext<C>): string | undefined
  routerTools?(ctx: SourceContext<C>): ToolSet
  workerPrompt?(ctx: SourceContext<C>, ticket: Ticket): string | undefined
  workerTools?(ctx: SourceContext<C>, ticket: Ticket, turn: TurnContext): ToolSet
  workerEnv?(ctx: SourceContext<C>, ticket: Ticket): Record<string, string>
}
