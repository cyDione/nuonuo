/**
 * Default-deny RBAC scope resolver for the unified `/v1/*` public API.
 * Every endpoint under `/v1/*` (except public `/v1/auth/*`) requires an authenticated Access Token and
 * defaults to requiring `admin` unless explicitly mapped to a narrower scope.
 */
import type { Scope } from './auth-service'
import type { ClientEvent } from './events'

/** Paths (relative to `/v1`, starting with `/`) that may also accept an ephemeral single-path resource ticket on GET. */
const RESOURCE_TICKET_PATTERNS: readonly RegExp[] = [
  /^\/uploads\/[^/]+$/,
  /^\/artifacts\/[^/]+$/,
  /^\/browser\/[^/]+\/screenshot$/,
  /^\/browser\/[^/]+\/steps\/\d+$/,
  /^\/browsers\/screenshot$/,
  /^\/computers\/[^/]+\/desktop\/screenshot$/,
]

export function allowsResourceTicket(v1SubPath: string, method: string): boolean {
  if (method !== 'GET') return false
  return RESOURCE_TICKET_PATTERNS.some(re => re.test(v1SubPath))
}

/**
 * Returns the minimum required scope for a `/v1/*` route (pass path stripped of `/v1`, e.g. `/conversations`).
 * Returns `null` when any valid authenticated session is sufficient (e.g. `/hello`, `/health`, `/events`).
 */
export function requiredScopeFor(v1SubPath: string, method: string): Scope | null {
  const m = method.toUpperCase()
  const isRead = m === 'GET' || m === 'HEAD'

  if (v1SubPath === '/hello' || v1SubPath === '/health' || v1SubPath === '/events') return null

  // Chat surface
  if (
    v1SubPath === '/conversations' ||
    v1SubPath.startsWith('/conversations/') ||
    v1SubPath === '/messages' ||
    v1SubPath.startsWith('/messages/') ||
    v1SubPath === '/uploads' ||
    v1SubPath.startsWith('/uploads/') ||
    v1SubPath === '/speech' ||
    v1SubPath === '/transcribe' ||
    v1SubPath === '/settings/client-prefs'
  ) {
    return 'chat'
  }
  if (isRead && (v1SubPath === '/persona' || v1SubPath === '/mood')) return 'chat'

  // Approvals surface
  if (v1SubPath === '/approvals' || v1SubPath.startsWith('/approvals/')) return 'approvals'

  // Tasks / workspace / memory / goals / feed / ideas / skills / instructions surface
  if (
    v1SubPath === '/tickets' ||
    v1SubPath.startsWith('/tickets/') ||
    v1SubPath === '/inbox' ||
    v1SubPath === '/router' ||
    v1SubPath === '/search' ||
    v1SubPath === '/artifacts' ||
    v1SubPath.startsWith('/artifacts/') ||
    v1SubPath === '/activity' ||
    v1SubPath.startsWith('/triggers/') ||
    v1SubPath === '/goals' ||
    v1SubPath.startsWith('/goals/') ||
    v1SubPath === '/feed' ||
    v1SubPath.startsWith('/feed/') ||
    v1SubPath === '/ideas' ||
    v1SubPath.startsWith('/ideas/') ||
    v1SubPath === '/memories' ||
    v1SubPath.startsWith('/memories/') ||
    v1SubPath === '/skills' ||
    v1SubPath.startsWith('/skills/') ||
    v1SubPath === '/instructions' ||
    v1SubPath.startsWith('/instructions/') ||
    v1SubPath === '/persona' ||
    v1SubPath === '/mood' ||
    v1SubPath.startsWith('/mood/')
  ) {
    return isRead ? 'tasks:read' : 'tasks:write'
  }

  // Read-only browser screenshots belong to tasks:read
  if (
    isRead &&
    (/^\/browser\/[^/]+\/(screenshot|state|steps\/\d+)$/.test(v1SubPath) || v1SubPath === '/browsers/screenshot')
  ) {
    return 'tasks:read'
  }

  // Default deny: everything else (providers, roles, permissions, settings, plugins, sources, computers, devices, system) requires admin.
  return 'admin'
}

/** Determines whether an SSE event may be delivered to a device with the given scopes. */
export function eventAllowedForScopes(event: ClientEvent, scopes: readonly Scope[]): boolean {
  if (scopes.includes('admin')) return true
  const has = (s: Scope) => scopes.includes(s)
  switch (event.type) {
    case 'message.created':
    case 'message.updated':
    case 'reply.delta':
    case 'conversation.updated':
    case 'persona.updated':
    case 'prefs.updated':
      return has('chat')
    case 'notice':
      return has('notices')
    case 'ticket.updated':
    case 'session.state':
    case 'worker.part':
    case 'activity.updated':
    case 'goals.updated':
    case 'skills.updated':
    case 'feed.updated':
    case 'ideas.updated':
      return has('tasks:read')
    case 'settings.updated':
      return false
  }
}
