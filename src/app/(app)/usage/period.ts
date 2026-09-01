export type Period = 'this_month' | 'last_month' | 'all_time'

export const PERIODS: { key: Period; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'all_time', label: 'All time' },
]

export function parsePeriod(raw: string | undefined): Period {
  return raw === 'last_month' || raw === 'all_time' ? raw : 'this_month'
}

/**
 * UTC calendar-month boundaries as ISO strings, [start, end) - end is exclusive so a
 * row exactly at a month boundary is never double-counted. `all_time` returns
 * start/end both null (no filter applied).
 */
export function getPeriodRange(period: Period, now: Date = new Date()): { start: string | null; end: string | null } {
  if (period === 'all_time') return { start: null, end: null }

  const monthOffset = period === 'last_month' ? -1 : 0
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 1))

  return { start: start.toISOString(), end: end.toISOString() }
}
