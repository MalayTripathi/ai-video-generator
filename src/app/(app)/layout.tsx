import type { ReactNode } from 'react'
import { getCurrentUser } from '@/lib/auth/current-user'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { Rail } from './dashboard/rail'
import { RailFiguresProvider } from '@/components/rail-figures-context'
import { loadRailFigures } from './rail-figures'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser()

  // First place application code runs for a signed-in user (auth.users inserts
  // happen Supabase-side, no application code in that path) - guarantees every
  // balance read anywhere in the app finds a row, without any read needing to grant
  // one itself. Never throws, so a transient failure here never breaks a page load.
  if (user) await ensureSignupGrant(user.id)

  // The same aggregation /usage and /credits use (request-memoized, so a visit to either
  // page this request reuses the query). Seeds the client store the rail reads from.
  const railFigures = user ? await loadRailFigures(user.id) : { spendThisMonth: 0, creditsSpentThisMonth: 0 }

  return (
    <RailFiguresProvider initial={railFigures}>
      <div className="flex h-screen">
        <Rail user={user ?? undefined} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
    </RailFiguresProvider>
  )
}
