import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { Rail } from './dashboard/rail'
import { getUsageRows } from './usage/data'
import { aggregateUsage } from './usage/aggregate'
import { getLedgerRows } from './credits/data'
import { aggregateCreditsPeriod } from './credits/aggregate'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // First place application code runs for a signed-in user (auth.users inserts
  // happen Supabase-side, no application code in that path) - guarantees every
  // balance read anywhere in the app finds a row, without any read needing to grant
  // one itself. Never throws, so a transient failure here never breaks a page load.
  if (user) await ensureSignupGrant(user.id)

  // Reuses the same aggregation path /usage itself uses, rather than a second query
  // shape - just with an empty projects list, since the rail only needs settledTotal,
  // not byProject. getUsageRows is request-memoized (React cache()), so a visit to
  // /usage this same request doesn't re-run this query.
  const rows = user ? await getUsageRows(user.id, 'this_month') : []
  const spendThisMonth = aggregateUsage(rows, []).settledTotal

  // Same pattern, against credit_ledger instead of usage - request-memoized via
  // getLedgerRows, so a visit to /credits this same request reuses it too.
  const creditsRows = user ? await getLedgerRows(user.id, 'this_month') : []
  const creditsSpentThisMonth = aggregateCreditsPeriod(creditsRows, []).spentThisPeriod

  return (
    <div className="flex h-screen">
      <Rail user={user ?? undefined} spendThisMonth={spendThisMonth} creditsSpentThisMonth={creditsSpentThisMonth} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
