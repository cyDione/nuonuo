import { AlarmClock, MessageSquare, Shield } from 'lucide-react'

/** The GitHub mark (lucide no longer ships brand icons). */
export function GithubIcon({ size = 14, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.34.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
}

export function SourceIcon({ source, size = 14, className }: { source: string; size?: number; className?: string }) {
  if (source === 'github') return <GithubIcon size={size} {...(className ? { className } : {})} />
  if (source === 'cron') return <AlarmClock size={size} {...(className ? { className } : {})} />
  if (source === 'watchdog') return <Shield size={size} {...(className ? { className } : {})} />
  return <MessageSquare size={size} {...(className ? { className } : {})} />
}

export const SOURCE_LABEL: Record<string, string> = { github: 'GitHub', cron: '定时任务', webchat: '对话', watchdog: 'Watchdog' }
