/** Task-initiated browser takeover (NeedsYou handoff), powered by Figma section 34's BrowserTakeoverModal. */
import { BrowserTakeoverModal, useBrowsers } from './browser'

export function HandoffModal({ ticketId, reason, onClose }: { ticketId: string; reason: string; onClose(): void }) {
  const browsers = useBrowsers(true)
  if (browsers.isPending) return null
  const pages = browsers.data?.pages ?? []
  const computer = browsers.data?.computer ?? null
  const cloudMatch = pages.find(p => p.kind === 'cloud' && (p.tab === ticketId || p.key.endsWith(`:${ticketId}`) || p.browser === 'desktop'))
  const anyMatch = cloudMatch ?? pages.find(p => p.tab === ticketId || p.key === `local:${ticketId}` || p.key.endsWith(`:${ticketId}`))
  const fallbackKey = computer?.hasDesktop ? `cloud:${computer.id}:desktop:browser` : `local:${ticketId}`
  return <BrowserTakeoverModal targetKey={anyMatch?.key ?? fallbackKey} reason={reason} onClose={onClose} />
}
