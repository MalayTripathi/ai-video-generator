import type { ReactNode } from 'react'
import { getCurrentUser } from '@/lib/auth/current-user'
import { createClient } from '@/lib/supabase/server'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { readBalance, type BalanceRead } from '@/lib/credits/balance'
import { Rail } from './dashboard/rail'
import { RailFiguresProvider } from '@/components/rail-figures-context'
import { loadRailFigures } from './rail-figures'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser()

  // The rail's figures (seeding the client store the rail reads from) and the balance read
  // that says whether this user has any ledger rows yet run together - neither needs the
  // other. A grant isn't spend, so granting afterwards never changes the rail's figures.
  let railFigures = { spendThisMonth: 0, creditsSpentThisMonth: 0 }
  if (user) {
    const supabase = await createClient()
    const [ledger, figures] = await Promise.all([
      readBalance(supabase, user.id).catch((): BalanceRead | null => null),
      loadRailFigures(user.id),
    ])
    railFigures = figures

    // First place application code runs for a signed-in user (auth.users inserts happen
    // Supabase-side, no application code in that path) - guarantees every balance read
    // anywhere in the app finds a row. Only a user with no ledger rows (or an unreadable
    // balance) needs it. Never throws, so a transient failure never breaks a page load.
    if (!ledger || ledger.entries === 0) await ensureSignupGrant(user.id)
  }

  return (
    <RailFiguresProvider initial={railFigures}>
      <div className="flex h-screen">
        <Rail user={user ?? undefined} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
    </RailFiguresProvider>
  )
}
