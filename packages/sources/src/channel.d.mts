import type { z } from 'zod'
import type { FieldSpec, SourceContext, SourceKind } from './kind'

/** What a chat app can do. The channel layer, the prompt hint and (later) the settings card read only this. */
export interface ChannelCapabilities {
  /** How messages arrive: the assistant connects out (longpoll, websocket) or the app calls a public URL (webhook). */
  inbound: 'longpoll' | 'websocket' | 'webhook'
  /** `topic`: topics inside a chat (Telegram forum topics); `reply`: reply threads; `none`. */
  threads: 'none' | 'reply' | 'topic'
  /** When a group message counts as addressing the assistant. A private chat always does. */
  groups: { mention: boolean; replyToBot: boolean }
  format: 'plain' | 'markdown' | 'html'
  /** Characters per message; longer replies are split. */
  maxLength: number
  /** Can change a message already sent (used to mark an answered approval). Needs `edit()`. */
  edit: boolean
  /** Can show buttons (approvals become 同意 / 拒绝 buttons instead of a typed answer). */
  buttons: boolean
  typing: boolean
  files: { in: boolean; out: boolean; maxBytes?: number }
  /** Can write first (rather than only answer within a window). */
  proactive: boolean
}

export interface ChannelUser { id: string | number; name?: string; username?: string; bot?: boolean; /** The bot itself: ignored. */ self?: boolean }

/** A message from the app, in the shared shape. */
export interface ChannelMessage {
  /** The app's message id (unique within the chat). */
  id: string | number
  chat: { id: string | number; type: 'private' | 'group'; title?: string }
  topic?: string | number
  from: ChannelUser
  text?: string
  /** The bot was @-mentioned / the message replies to the bot. */
  mentioned?: boolean
  replyToBot?: boolean
  files?: { kind: 'image' | 'file' | 'voice'; name?: string }[]
  at?: number
  url?: string
}

/** A button press, with the button's id as `data`. */
export interface ChannelAction { data: string; from: ChannelUser; chat?: { id: string | number }; topic?: string | number }

/** The part of the WebSocket API the channel layer uses (Node's global WebSocket fits; tests pass a fake). */
export interface SocketLike {
  binaryType?: string
  send(data: string | ArrayBufferLike | Uint8Array): void
  close(code?: number): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void
}
export interface SocketHandlers {
  open?(): void
  /** Called at once for every frame; return true to consume it (an answer someone is waiting for) instead of queueing it. */
  immediate?(data: string | ArrayBuffer): boolean
  message(data: string | ArrayBuffer): void | Promise<void>; close?(event: { code?: number }): void; error?(error: unknown): void }

export interface ChannelTarget { chat: string; topic?: string }
export interface ChannelOut { text: string; buttons?: { id: string; label: string; style?: 'primary' | 'danger' }[] }

export interface ChannelIO<C> {
  readonly source: string
  readonly config: C & { allowed: string[]; approvals: boolean }
  readonly signal: AbortSignal
  state: SourceContext<C>['state']
  secret: SourceContext<C>['secret']
  log(...args: unknown[]): void
  facts(facts: Record<string, string>): void
  /** Reports the connection as up (health 「在线」). */
  online(detail?: string): void
  /** Waits, ending early when the source stops. */
  sleep(ms: number): Promise<void>
  /** Opens a WebSocket (binary frames arrive as ArrayBuffer). */
  socket(url: string): SocketLike
  /** Runs a connection until it closes (resolves) or fails to open (throws); closes it when the source stops. */
  runSocket(socket: SocketLike, handlers: SocketHandlers): Promise<void>
  /** Hands a received message to the channel layer. */
  message(m: ChannelMessage): Promise<void>
  /** Hands a button press to the channel layer; resolves to a short text for the app's toast, or undefined when it is not ours. */
  action(a: ChannelAction): Promise<string | undefined>
}

export interface ChannelSpec<C> extends Partial<Pick<SourceKind<C>, 'icon' | 'actions' | 'authorized' | 'http' | 'routerPrompt' | 'routerTools' | 'workerPrompt' | 'workerTools' | 'workerEnv' | 'writes' | 'defaultEnabled'>> {
  id: string
  title: string
  description?: string
  capabilities: Partial<ChannelCapabilities> & Pick<ChannelCapabilities, 'inbound'>
  /** The app's own settings; `allowed` and `approvals` are added by the channel layer. */
  config?: z.ZodObject<any>
  fields?: FieldSpec[]
  /** Placeholder of the allow-list field, e.g. 「你的 Telegram ID 或 @用户名」. */
  idHint?: string
  welcome?: string
  /** Connects and reads until the connection ends (resolve) or fails (throw); the layer reconnects with backoff. Optional for `inbound: 'webhook'`. */
  connect?(io: ChannelIO<C>): Promise<void>
  /**
   * For `inbound: 'webhook'`: the app calls the public URL `/plugin/<id>/<path>` (no owner token). Check the app's signature,
   * hand messages to `io.message` and answer the app; return undefined for a path that is not yours.
   */
  webhook?(io: ChannelIO<C>, request: Request, path: string, info: { public: boolean; origin: string }): Promise<Response | undefined>
  /** Reads once now (the settings page's 立即同步, tests). */
  poll?(io: ChannelIO<C>): Promise<void>
  /** Sends one message (already split and formatted). Throw ChannelError with `gone` when the chat is gone. */
  send(io: ChannelIO<C>, target: ChannelTarget, out: ChannelOut): Promise<{ id?: string; url?: string } | void>
  edit?(io: ChannelIO<C>, target: ChannelTarget, messageId: string, out: ChannelOut): Promise<void>
}

export declare class ChannelError extends Error {
  constructor(message: string, opts?: { status?: number; gone?: boolean; fatal?: boolean })
  status?: number
  gone: boolean
  fatal: boolean
}

export type DefineChannel = <C>(spec: ChannelSpec<C>) => SourceKind<C & { allowed: string[]; approvals: boolean }> & { capabilities: ChannelCapabilities }
export declare function makeDefineChannel(z: typeof import('zod').z): DefineChannel
export declare function channelThread(source: string, chat: string | number, topic?: string | number, epoch?: number): string
export declare function parseChannelThread(source: string, threadId: string): ChannelTarget | undefined
export declare function plainText(markdown: string): string
export declare function runSocket(socket: SocketLike, handlers: SocketHandlers, signal?: AbortSignal): Promise<void>
export declare function splitText(text: string, max: number): string[]
