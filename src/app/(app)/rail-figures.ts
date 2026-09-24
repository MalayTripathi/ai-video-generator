import { getUsageRows } from './usage/data'
import { aggregateUsage } from './usage/aggregate'
import { getLedgerRows } from './credits/data'
import { aggregateCreditsPeriod } from './credits/aggregate'
import type { RailFigures } from '@/components/rail-figures-context'

// The rail's two "Usage spending" figures, for the layout's first paint and for any route
// that hands the client a fresh pair. Two independent reads: the dollar figure from `usage`,
// the credit figure from `credit_ledger` - never joined, and the credit figure is never
// derived from `usage`. Both reuse the same aggregation /usage and /credits use, with an
// empty projects list since the rail needs only the period totals.
export async function loadRailFigures(userId: string): Promise<RailFigures> {
  const [usageRows, ledgerRows] = await Promise.all([
    getUsageRows(userId, 'this_month'),
    getLedgerRows(userId, 'this_month'),
  ])
  return {
    spendThisMonth: aggregateUsage(usageRows, []).settledTotal,
    creditsSpentThisMonth: aggregateCreditsPeriod(ledgerRows, []).spentThisPeriod,
  }
}

// For routes that attach a fresh pair to their response: a failed read must never fail the
// action it rides on, so it logs and yields null (the client then keeps what it shows).
export async function tryLoadRailFigures(userId: string): Promise<RailFigures | null> {
  try {
    return await loadRailFigures(userId)
  } catch (err) {
    console.error('[rail] figures unreadable:', err)
    return null
  }
}
