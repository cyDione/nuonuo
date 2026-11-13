/**
 * The owner's calendar as one capability. The agents get one pair of tools (calendar_events, calendar_add) whatever
 * holds the events: the Mac's Calendar app, Google Calendar through Gmail, or a plugin's calendar. Each of those is a
 * backend; a new calendar service is one more backend, not another set of tools with its own permission rules.
 * Every backend follows the 日历 level in 权限, through the permission gate.
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { pendingNote, type ToolGate } from './gate'
import type { Ticket } from './model'
import type { Reviewer } from './review'

export interface CalendarEvent { id: string; title: string; start: string; end: string; allDay?: boolean; location?: string; calendar?: string; url?: string }
export interface NewCalendarEvent { title: string; start: string; end: string; allDay?: boolean; location?: string; notes?: string; calendar?: string }

/** One place the owner keeps events. `add` is left out by a read-only backend. */
export interface CalendarBackend {
  /** Stable id the agent passes back (`mac`, `gmail`, a plugin's source id). */
  id: string
  /** What the owner calls it: 「Mac 日历」, 「Google 日历」. */
  label: string
  /** Events overlapping [from, to), at most a couple of hundred; `calendar` narrows to one calendar inside the backend. */
  list(range: { from: string; to: string; calendar?: string }): Promise<CalendarEvent[]>
  add?(event: NewCalendarEvent): Promise<{ id: string; url?: string; calendar?: string }>
}

const iso = z.string().describe('ISO 8601 with offset, e.g. 2026-11-12T15:00:00+08:00')

/**
 * The calendar tools over the backends available now. Reads merge every backend, sorted by start; a change goes to the
 * named backend (or the only writable one), after the gate allows it under the 日历 level.
 */
export function calendarTools(backends: CalendarBackend[], gate: ToolGate, ticket: Ticket, sessionId: string): ToolSet {
  if (!backends.length || !gate.visible({ effect: 'read', app: 'calendar' })) return {}
  const ids = backends.map(b => b.id)
  const which = `Backends: ${backends.map(b => `${b.id} (${b.label}${b.add ? '' : ', read-only'})`).join(', ')}.`
  const t: ToolSet = {
    calendar_events: tool({
      description: `List the owner's events between two times, from every calendar they connected (or one backend). ${which}`,
      inputSchema: z.object({ from: iso, to: iso, backend: z.enum(ids as [string, ...string[]]).optional(), calendar: z.string().optional().describe('One calendar inside the backend, by name or id') }),
      execute: async ({ from, to, backend, calendar }) => {
        const chosen = backend ? backends.filter(b => b.id === backend) : backends
        const results = await Promise.allSettled(chosen.map(async b => (await b.list({ from, to, ...(calendar ? { calendar } : {}) })).map(e => ({ ...e, backend: b.id }))))
        const events = results.flatMap(r => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
        const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${chosen[i]!.label}：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []))
        if (failed.length === chosen.length && failed.length) throw new Error(failed.join('；'))
        return { events, ...(failed.length ? { unavailable: failed } : {}) }
      },
    }),
  }
  const writable = backends.filter(b => b.add)
  if (!writable.length || !gate.visible({ effect: 'write', app: 'calendar' })) return t
  const writeIds = writable.map(b => b.id)
  t.calendar_add = tool({
    description: `Add an event to the owner's calendar. Check calendar_events for conflicts first.${writable.length > 1 ? ` Say which backend: ${writeIds.join(', ')}.` : ''}`,
    inputSchema: z.object({
      title: z.string().min(1), start: iso, end: iso, all_day: z.boolean().optional(), location: z.string().optional(), notes: z.string().optional(),
      calendar: z.string().optional().describe('One calendar inside the backend'),
      backend: z.enum(writeIds as [string, ...string[]]).optional(),
    }),
    execute: async ({ backend, all_day, ...e }) => {
      const target = backend ? writable.find(b => b.id === backend) : writable.length === 1 ? writable[0] : undefined
      if (!target) throw new Error(`有好几个日历，请用 backend 指定加到哪个：${writeIds.join(', ')}`)
      const event: NewCalendarEvent = { ...e, allDay: Boolean(all_day) }
      const display = `在${target.label}里加「${e.title}」${e.start} – ${e.end}${e.location ? ` @ ${e.location}` : ''}`
      const decision = await gate.check(ticket, sessionId, { toolId: 'calendar', display, input: { backend: target.id, event } }, { effect: 'write', app: 'calendar' })
      if (decision.action === 'block') throw new Error(decision.reason)
      if (decision.action === 'escalate') return pendingNote(decision)
      return addTo(target, event)
    },
  })
  return t
}

async function addTo(backend: CalendarBackend, event: NewCalendarEvent): Promise<string> {
  const r = await backend.add!(event)
  return `已加到${backend.label}${r.calendar ? `「${r.calendar}」` : ''}：${event.title}（${r.id}）${r.url ? ` ${r.url}` : ''}`
}

/** Runs an approved calendar change: the backend is looked up again, since it may have gone since the card was shown. */
export function registerCalendarExecutor(reviewer: Reviewer | undefined, backends: () => CalendarBackend[]): void {
  reviewer?.registerExecutor('calendar', async input => {
    const backend = backends().find(b => b.id === input.backend && b.add)
    if (!backend) throw new Error(`日历「${String(input.backend)}」现在连不上了`)
    return addTo(backend, input.event as NewCalendarEvent)
  })
}
