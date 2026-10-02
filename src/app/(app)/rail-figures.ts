import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/database.types'
import { getPeriodRange } from './usage/period'
import { getLedgerGroups, readLedgerGroups, type LedgerGroup } from './credits/data'
import { aggregateCreditsPeriod } from './credits/aggregate'
import type { RailFigures } from '@/components/rail-figures-context'

// The rail's dollar figure: this UTC month's settled spend, summed by Postgres (the
// usage_monthly_spend view, security_invoker). A failed read shows 0, as the row-by-row
// read it replaced did.
async function readSpendThisMonth(supabase: SupabaseClient<Database>, userId: string): Promise<number> {
  const { start } = getPeriodRange('this_month')
  const { data, error } = await supabase
    .from('usage_monthly_spend')
    .select('settled_cost')
    .eq('user_id', userId)
    .eq('month', start!)
    .maybeSingle()
  if (error) {
    console.error('[rail] month spend unreadable:', error.message)
    return 0
  }
  return data?.settled_cost ?? 0
}

function creditsSpent(groups: LedgerGroup[]): number {
  return aggregateCreditsPeriod(groups, []).spentThisPeriod
}

// The rail's two "Usage spending" figures, from two independent reads: the dollar figure
// from `usage`, the credit figure from `credit_ledger` - never joined, and the credit
// figure is never derived from `usage`. Both are aggregated in Postgres. Takes its client
// so a test can read through a user's own JWT client.
export async function readRailFigures(supabase: SupabaseClient<Database>, userId: string): Promise<RailFigures> {
  const [spendThisMonth, groups] = await Promise.all([
    readSpendThisMonth(supabase, userId),
    readLedgerGroups(supabase, userId, 'this_month'),
  ])
  return { spendThisMonth, creditsSpentThisMonth: creditsSpent(groups) }
}

// For the layout's first paint and for any route that hands the client a fresh pair. The
// ledger half is request-memoized, so /credits on "This month" reuses it.
export async function loadRailFigures(userId: string): Promise<RailFigures> {
  const supabase = await createClient()
  const [spendThisMonth, groups] = await Promise.all([
    readSpendThisMonth(supabase, userId),
    getLedgerGroups(userId, 'this_month'),
  ])
  return { spendThisMonth, creditsSpentThisMonth: creditsSpent(groups) }
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
