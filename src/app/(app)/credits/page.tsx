import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { TopBar } from '../dashboard/top-bar'
import { parsePeriod } from '../usage/period'
import { readBalance } from '@/lib/credits/balance'
import { getLedgerGroups, readLedgerGroups } from './data'
import { aggregateCreditsPeriod, type ProjectMeta } from './aggregate'
import { PeriodSelector } from './period-selector'
import { CreditsSummary } from './credits-summary'
import { CreditsByStep } from './credits-by-step'
import { CreditsByProject } from './credits-by-project'
import { CreditsEmptyState } from './credits-empty-state'

export default async function CreditsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period: rawPeriod } = await searchParams
  const period = parsePeriod(rawPeriod)

  const supabase = await createClient()
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  // Balance is deliberately all-time regardless of the active tab - a balance is a
  // present-moment fact, not a periodic one (see credits-summary.tsx's sublabel). Both
  // figures are summed by Postgres (credit_balances, credit_ledger_monthly) and read in
  // parallel; the period read is request-memoized with the rail's on "This month".
  let [ledger, periodGroups] = await Promise.all([readBalance(supabase, user.id), getLedgerGroups(user.id, period)])

  // The layout grants a new user their signup credits too, but a layout and its page render
  // in parallel, so the reads above can land before that grant does - and a brand-new
  // user's first visit would show "No credit activity yet" or their balance depending only
  // on which query was faster. So a user with no ledger rows is granted here and re-read -
  // fresh, since the first reads' identical GETs are memoized for this whole render.
  if (ledger.entries === 0) {
    await ensureSignupGrant(user.id)
    ;[ledger, periodGroups] = await Promise.all([
      readBalance(supabase, user.id, { fresh: true }),
      readLedgerGroups(supabase, user.id, period, { fresh: true }),
    ])
  }

  const projectIds = [...new Set(periodGroups.map((row) => row.project_id).filter((id): id is string => id !== null))]

  let projects: ProjectMeta[] = []
  if (projectIds.length > 0) {
    const { data: projectRows } = await supabase
      .from('projects')
      .select('id, title, source_text, video_type, duration_target')
      .in('id', projectIds)
      .eq('user_id', user.id)
    projects = projectRows ?? []
  }

  const aggregation = aggregateCreditsPeriod(periodGroups, projects)

  return (
    <>
      <TopBar left={<h1 className="text-screen font-medium tracking-tight text-text-primary">Credits</h1>} />
      <PeriodSelector active={period} />

      {aggregation.isEmpty && ledger.entries === 0 ? (
        <CreditsEmptyState />
      ) : (
        <div className="flex flex-1 flex-col gap-rc-lg px-rc-lg py-rc-lg pb-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
          <CreditsSummary balance={ledger.balance} period={aggregation} />
          <CreditsByStep aggregation={aggregation} />
          <CreditsByProject aggregation={aggregation} />
        </div>
      )}
    </>
  )
}
