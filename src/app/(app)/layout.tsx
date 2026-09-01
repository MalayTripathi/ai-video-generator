import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { Rail } from './dashboard/rail'
import { getUsageRows } from './usage/data'
import { aggregateUsage } from './usage/aggregate'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Reuses the same aggregation path /usage itself uses, rather than a second query
  // shape - just with an empty projects list, since the rail only needs settledTotal,
  // not byProject. getUsageRows is request-memoized (React cache()), so a visit to
  // /usage this same request doesn't re-run this query.
  const rows = user ? await getUsageRows(user.id, 'this_month') : []
  const spendThisMonth = aggregateUsage(rows, []).settledTotal

  return (
    <div className="flex h-screen">
      <Rail user={user ?? undefined} spendThisMonth={spendThisMonth} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
