/** In-process event bus: the runtime and the domain publish here; the daemon forwards events to browsers over SSE. */
import { EventEmitter } from 'node:events'

export type BusEvent =
  | { type: 'session.state'; sessionId: string; role: string; ticketId?: string | null; state: SessionState }
  | { type: 'session.part'; sessionId: string; role: string; ticketId?: string | null; part: StreamPart }
  | { type: 'session.message'; sessionId: string; role: string; ticketId?: string | null }
  | { type: string; [key: string]: unknown }

export type SessionState = 'idle' | 'queued' | 'running' | 'error'

/** The subset of model stream parts worth showing live. */
export type StreamPart =
  | { kind: 'step-start' }
  | { kind: 'text'; delta: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'tool-input-start'; id: string; tool: string }
  | { kind: 'tool-input-delta'; id: string; delta: string }
  | { kind: 'tool-call'; id: string; tool: string; input: unknown }
  | { kind: 'tool-result'; id: string; tool: string; output: unknown }
  | { kind: 'error'; message: string }

export class Bus {
  private emitter = new EventEmitter().setMaxListeners(100)
  emit(event: BusEvent): void { this.emitter.emit('event', event) }
  on(listener: (event: BusEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
