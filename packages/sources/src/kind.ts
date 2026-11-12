/**
 * The Source plugin protocol (after dsh-superagent's SourceKind, MIT): a kind reads events from somewhere, turns them into
 * Triggers, writes replies back through its channel, and can lend the agents tools, prompt text and environment.
 * Its settings form is generated from `fields`, so a new source needs no UI code.
 */
import type { TurnContext } from '@nuonuo/agent-runtime'
import type { Engine, LocalApp, Ticket } from '@nuonuo/core'
import type { Store } from '@nuonuo/db'
import type { ToolSet } from 'ai'
import type { z } from 'zod'
import type { ChannelCapabilities } from './channel.mjs'

/** `links`: shortcuts shown under the field (e.g. where to create the OAuth client whose ID goes here). */
interface FieldBase { key: string; label: string; hint?: string; advanced?: true; links?: { label: string; href: string }[] }
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; placeholder?: string }
  | FieldBase & { type: 'list'; placeholder?: string }
  | FieldBase & { type: 'select'; options: { value: string; label: string }[] }
  /** Stored in the secret store (keychain), never in the settings database; the form only shows whether it is set. */
  | FieldBase & { type: 'secret'; placeholder?: string }

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
  /** Secrets owned by this source (tokens obtained at runtime, e.g. an OAuth refresh token), kept in the secret store. */
  secret: { get(name: string): string | undefined; set(name: string, value: string): void; delete(name: string): void }
  /**
   * Keeps a file that came in (a photo sent in a chat app) in the attachments folder; pass the result as the trigger's
   * `attachments` so the agent can open it. Absent when the service has no attachments folder (tests).
   */
  saveFile?(file: { name: string; mime?: string; bytes: Uint8Array }): Promise<SavedFile>
  /** Posts a notice to the owner in this source's own conversation (no model involved). */
  notify(text: string, opts?: { title?: string }): void
  /**
   * Answers an approval (「要不要做」) on the owner's behalf, for a chat channel whose owner turned on 允许在这里回答.
   * Accepted only for a task that came from this source's own threads. `by` says who answered (shown in the audit).
   */
  approvals?: { answer(id: string, approve: boolean, by: string): void | Promise<void> }
}

/** A file kept by `saveFile`: the same shape as a file the owner attached in the web. */
/** `transcript`: what a voice message says, when the owner set a model for the 听写 layer. */
export interface SavedFile { id: string; name: string; mime: string; size: number; path: string; transcript?: string }

export interface SourceAction { id: string; label: string; path: string; show?: 'authorized' | 'unauthorized'; confirm?: string; primary?: true }

/** An OAuth device-flow code for the owner to enter on the provider's page. */
export interface DeviceCode { userCode: string; verificationUri: string; expiresIn: number; poll: string }

export interface OutgoingMessage {
  messageId: string
  threadId: string
  text: string
  ticketId?: string
  /**
   * Set when the message asks for (or reports the answer to) an approval, sent only to channels that declare
   * capabilities and whose owner allowed approvals there. `pending` asks; the other states mark the earlier card.
   */
  approval?: { id: string; state: 'pending' | 'approved' | 'denied' | 'expired' }
}

export interface SourceKind<C = any> {
  id: string
  title: string
  description: string
  /**
   * A Lucide icon name (kebab-case: `mail`, `send`, `calendar`…) shown next to the source's conversations and activity;
   * `github` is the GitHub mark. The UI falls back to a speech bubble for a name it does not ship.
   */
  icon?: string
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** What a chat app can do (sources made with `defineChannel`); see channel.d.mts. */
  capabilities?: ChannelCapabilities
  /** Built-in sources that run until switched off. */
  defaultEnabled?: boolean
  /**
   * Buttons on the settings card. The UI calls `http(path)` (POST) and then, by the answer:
   * `{ url }` opens that page (an OAuth consent page); `{ device: DeviceCode }` shows the code to enter and polls `device.poll`
   * until it answers `{ status: 'done' | 'error' }`; anything else just refreshes the card.
   * `show` limits a button to when the source is (not) authorized; `confirm` asks first.
   */
  actions?: SourceAction[]
  /** Whether the source holds an authorization (an OAuth token); drives `show` on actions and the settings card. */
  authorized?(ctx: SourceContext<C>): boolean
  /** Begins reading; the returned function stops it. Called when the source is enabled with a valid configuration. */
  start(ctx: SourceContext<C>): (() => void | Promise<void>) | void
  /** Reads once now (the settings page's "sync now", tests). */
  poll?(ctx: SourceContext<C>): Promise<void>
  /** May this account ask for work through this source? */
  allowed?(ctx: SourceContext<C>, actor: string): boolean
  /** Sends a message; `gone` when the conversation can never receive it. Throws to retry later. */
  send?(ctx: SourceContext<C>, message: OutgoingMessage): Promise<{ url?: string } | 'gone'>
  threadInfo?(ctx: SourceContext<C>, threadId: string): string | undefined
  /**
   * Where the owner's notices go in this source, when the owner turned that on (a channel's 「把通知也发到这里」):
   * a thread `send` can start a message in. Undefined: no notices here.
   */
  homeThread?(ctx: SourceContext<C>): string | undefined
  routerPrompt?(ctx: SourceContext<C>): string | undefined
  routerTools?(ctx: SourceContext<C>): ToolSet
  workerPrompt?(ctx: SourceContext<C>, ticket: Ticket): string | undefined
  workerTools?(ctx: SourceContext<C>, ticket: Ticket, turn: TurnContext): ToolSet
  /** Worker tools that act in the account (write a draft, add an event): left out while the owner set it to 只能看 in 权限. */
  writes?: string[]
  /**
   * Tools that reach one of the owner's apps, by tool name (`gcal_add: 'calendar'`: Google Calendar is 日历 too). They
   * follow that app's level in 权限 (直接做 / 先问你 / 只能看 / 不允许) like the app's own tools.
   */
  apps?: Record<string, LocalApp>
  workerEnv?(ctx: SourceContext<C>, ticket: Ticket): Record<string, string>
  /**
   * HTTP endpoints of the source, under /api/sources/<id>/http/<path> (owner only) and, when `public` is true, also under
   * /plugin/<id>/<path> without the owner's token (for OAuth callbacks; the kind must check its own state parameter).
   */
  http?(ctx: SourceContext<C>, request: Request, path: string, info: { public: boolean; origin: string }): Promise<Response | undefined>
}
