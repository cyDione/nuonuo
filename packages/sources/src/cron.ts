/** A small 5-field cron (minute hour day-of-month month day-of-week), in local time. */
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const

export interface Cron { fields: Set<number>[]; domStar: boolean; dowStar: boolean; source: string }

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron 需要 5 个字段（分 时 日 月 周），收到 "${expr}"`)
  const fields = parts.map((part, i) => {
    const [lo, hi] = RANGES[i]!
    const set = new Set<number>()
    for (const piece of part.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece)
      if (!m) throw new Error(`无法解析 cron 字段 "${piece}"`)
      const step = m[2] ? Number(m[2]) : 1
      let [a, b] = m[1] === '*' ? [lo, hi] : m[1]!.split('-').map(Number) as [number, number?]
      if (b === undefined) b = m[2] ? hi : a
      if (a < lo || b > hi || a > b || step < 1) throw new Error(`cron 字段 "${piece}" 超出范围 ${lo}-${hi}`)
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v)
    }
    return set
  })
  return { fields, domStar: parts[2] === '*', dowStar: parts[4] === '*', source: expr.trim() }
}

export function cronMatches(cron: Cron, d: Date): boolean {
  const [min, hour, dom, mon, dow] = cron.fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !mon.has(d.getMonth() + 1)) return false
  // Standard cron: when both day fields are restricted, either may match.
  const domOk = dom.has(d.getDate()), dowOk = dow.has(d.getDay())
  if (cron.domStar && cron.dowStar) return true
  if (cron.domStar) return dowOk
  if (cron.dowStar) return domOk
  return domOk || dowOk
}

/** The next matching minute strictly after `after` (searches up to ~1 year). */
export function nextRun(cron: Cron, after: Date): Date | undefined {
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(cron, d)) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  return undefined
}

/** The latest matching minute in (after, until], if any. */
export function lastRunBetween(cron: Cron, after: number, until: number): Date | undefined {
  const d = new Date(until)
  d.setSeconds(0, 0)
  for (let t = d.getTime(); t > after; t -= 60_000) {
    const at = new Date(t)
    if (cronMatches(cron, at)) return at
  }
  return undefined
}
