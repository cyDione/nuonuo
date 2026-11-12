/**
 * 通知 (设置 → 通知): which changes become a system notification, and how. The service decides once and sends a `notice`
 * event; the desktop app shows it natively, a browser tab shows it when it is in the background and notifications are on.
 * Things waiting for the owner's OK always notify. Quiet hours (设置 → 助理 → 安静时间) hold back everything else.
 *
 * Where a notice goes is a list of sinks: the app (desktop, browser tab and paired devices, all through the `notice`
 * event) and the chat apps the owner turned 「把通知也发到这里」 on for. A new outlet is one more sink, not a new path.
 */
import type { Bus } from '@nuonuo/agent-runtime'
import { kvGet, kvSet, type Store } from '@nuonuo/db'
import type { Feed, Ideas, Reviewer } from '@nuonuo/core'
import type { SourceRegistry } from '@nuonuo/sources'
import { persona } from '@nuonuo/core'
import { z } from 'zod'

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const NotifySettingsSchema = z.object({
  /** What it says to the owner (a reply, a finished task, a routine's result). */
  message: z.boolean(),
  /** A number it watches moved (a price, stock): 动态 items with a big number card. */
  price: z.boolean(),
  /** Any other new 动态 item. */
  feed: z.boolean(),
  /** A new batch of 点子. */
  ideas: z.boolean(),
  /** Off: no banners at all, except what waits for the owner's OK. */
  banner: z.boolean(),
  sound: z.boolean(),
  /** 糯糯's own chime (played by the app), or the system's notification sound. */
  tone: z.enum(['nuonuo', 'system']),
  /** The number on the Dock / taskbar icon (desktop app). */
  badge: z.boolean(),
  quiet: z.object({ on: z.boolean(), from: Time, to: Time }),
})
export type NotifySettings = z.infer<typeof NotifySettingsSchema>
export const DEFAULT_NOTIFY: NotifySettings = { message: true, price: true, feed: true, ideas: true, banner: true, sound: false, tone: 'nuonuo', badge: true, quiet: { on: false, from: '23:00', to: '08:00' } }
const KEY = 'settings:notify'

export function notifySettings(store: Store): NotifySettings {
  const saved = kvGet<Partial<NotifySettings>>(store, KEY) ?? {}
  return { ...DEFAULT_NOTIFY, ...saved, quiet: { ...DEFAULT_NOTIFY.quiet, ...saved.quiet } }
}
export function saveNotifySettings(store: Store, patch: Partial<NotifySettings>): NotifySettings {
  const next = NotifySettingsSchema.parse({ ...notifySettings(store), ...patch })
  kvSet(store, KEY, next)
  return next
}

/** Whether `at` (local time) falls in the quiet hours; a range like 23:00–08:00 runs over midnight. */
export function isQuiet(q: NotifySettings['quiet'], at: Date): boolean {
  if (!q.on || q.from === q.to) return false
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
  const now = at.getHours() * 60 + at.getMinutes(), from = minutes(q.from), to = minutes(q.to)
  return from < to ? now >= from && now < to : now >= from || now < to
}

export type NoticeKind = 'message' | 'price' | 'feed' | 'ideas' | 'approval' | 'test'
export interface Notice {
  type: 'notice'; id: string; kind: NoticeKind; title: string; body: string; hash: string; silent: boolean; chime: boolean
  /** The source the message or the waiting task belongs to (`telegram`, `webchat`…), when known. */
  origin?: string
}

/** One outlet for notices. `deliver` gets every notice that passed the settings; it must not throw. */
export interface NoticeSink { id: string; deliver(notice: Notice): void }

/** The app: the desktop shows it natively, a browser tab in the background and paired devices get the event. */
export const appSink = (bus: Bus): NoticeSink => ({ id: 'app', deliver: notice => bus.emit(notice as unknown as { type: string }) })

/**
 * Chat apps with 「把通知也发到这里」 on: a message in the owner's own chat there. What already reached that chat is not
 * repeated: a reply in one of its conversations, or a question it asked there because approvals are allowed in it.
 */
export function channelSink(sources: SourceRegistry): NoticeSink {
  return {
    id: 'channels',
    deliver(notice) {
      for (const { source, threadId } of sources.noticeTargets()) {
        if (notice.origin === source && (notice.kind === 'message' || (notice.kind === 'approval' && sources.approvalsIn(source)))) continue
        const text = notice.kind === 'approval' ? `${notice.title}：${notice.body}\n（在糯糯里确认）` : notice.title ? `${notice.title}\n${notice.body}` : notice.body
        sources.send({ messageId: `notice:${notice.id}:${source}`, source, threadId, text })
      }
    },
  }
}

/** Whether a notice of this kind goes out now under these settings. */
export function allowed(s: NotifySettings, kind: NoticeKind, at: Date): boolean {
  if (kind === 'approval' || kind === 'test') return true
  if (!s.banner || isQuiet(s.quiet, at)) return false
  return s[kind]
}

interface Parts {
  feed: Feed; ideas: Ideas; reviewer: Reviewer
  ticketConversation(id: string): string | null
  /** The source a task came from (where its replies go). */
  ticketSource?(id: string): string | null
  /** Where notices go; the app alone when left out. */
  sinks?: NoticeSink[]
}

export class Notices {
  private feedSince: number
  private ideasSince: number
  private approvals = new Set<string>()
  private sinks: NoticeSink[]

  constructor(private store: Store, private bus: Bus, private parts: Parts, private now: () => number = Date.now) {
    this.sinks = parts.sinks ?? [appSink(bus)]
    this.feedSince = now()
    this.ideasSince = parts.ideas.batch()?.at ?? 0
    for (const a of parts.reviewer.pending()) this.approvals.add(a.id)
  }

  register(): () => void {
    return this.bus.on(event => {
      try {
        if (event.type === 'message.created') this.message(String(event.messageId))
        else if (event.type === 'feed.updated') this.feed()
        else if (event.type === 'ideas.updated') this.ideas()
        else if (event.type === 'approval.updated') this.approval()
      } catch (error) { console.error('[notices]', error) }
    })
  }

  /** 试一下: a sample banner, whatever the settings. */
  test(): Notice { return this.send('test', `${persona(this.store).name}`, '通知是这个样子的。', '/settings/notifications') ?? this.sample() }

  private sample(): Notice { return { type: 'notice', id: 'test', kind: 'test', title: '', body: '', hash: '/', silent: true, chime: false } }

  private send(kind: NoticeKind, title: string, body: string, hash: string, id = `${kind}:${this.now()}`, origin?: string | null): Notice | undefined {
    const s = notifySettings(this.store)
    if (!allowed(s, kind, new Date(this.now()))) return undefined
    const notice: Notice = { type: 'notice', id, kind, title, body: body.slice(0, 200), hash, silent: !s.sound || s.tone === 'nuonuo', chime: s.sound && s.tone === 'nuonuo', ...(origin ? { origin } : {}) }
    for (const sink of this.sinks) {
      try { sink.deliver(notice) } catch (error) { console.error(`[notices] ${sink.id}`, error) }
    }
    return notice
  }

  private message(id: string) {
    const row = this.store.sqlite.prepare("SELECT m.conversation_id AS c, m.role, m.content, json_extract(m.meta, '$.delivery') AS d, c.source FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?")
      .get(id) as { c: string; role: string; content: string; d: unknown; source: string | null } | undefined
    // What 糯糯 says; not the owner's own words, incoming events or a reply's delivery receipts.
    if (!row || row.role !== 'assistant' || row.d) return
    this.send('message', persona(this.store).name, row.content, `/c/${row.c}`, `message:${id}`, row.source)
  }

  private feed() {
    const fresh = this.parts.feed.list().filter(i => i.at > this.feedSince)
    if (!fresh.length) return
    this.feedSince = Math.max(...fresh.map(i => i.at))
    for (const item of fresh.slice(0, 3)) this.send(item.card ? 'price' : 'feed', item.title, item.text, '/activity', `feed:${item.id}`)
  }

  private ideas() {
    const batch = this.parts.ideas.batch()
    if (!batch || batch.at <= this.ideasSince) return
    this.ideasSince = batch.at
    const cards = batch.cards.filter(c => !c.dismissed && !c.done)
    if (!cards.length) return
    this.send('ideas', `${persona(this.store).name}想到 ${cards.length} 个点子`, cards[0]!.text, '/ideas', `ideas:${batch.at}`)
  }

  private approval() {
    for (const a of this.parts.reviewer.pending()) {
      if (this.approvals.has(a.id)) continue
      this.approvals.add(a.id)
      const input = a.input as { card?: { title?: string }; command?: string }
      const conversation = this.parts.ticketConversation(a.ticketId)
      this.send('approval', '等你确认', input.card?.title ?? input.command ?? a.reason, conversation ? `/c/${conversation}` : '/waiting', `approval:${a.id}`, this.parts.ticketSource?.(a.ticketId))
    }
  }
}
