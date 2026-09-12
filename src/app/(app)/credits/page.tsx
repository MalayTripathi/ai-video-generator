import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TopBar } from '../dashboard/top-bar'
import { parsePeriod } from '../usage/period'
import { getLedgerRows } from './data'
import { sumBalance, aggregateCreditsPeriod, type ProjectMeta } from './aggregate'
import { PeriodSelector } from './period-selector'
import { CreditsSummary } from './credits-summary'
import { CreditsByStep } from './credits-by-step'
import { CreditsByProject } from './credits-by-project'
import { CreditsEmptyState } from './credits-empty-state'

export default async function CreditsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period: rawPeriod } = await searchParams
  const period = parsePeriod(rawPeriod)

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Balance is deliberately all-time regardless of the active tab - a balance is a
  // present-moment fact, not a periodic one (see credits-summary.tsx's sublabel). This
  // call collapses into the one below via getLedgerRows' request memoization when the
  // active tab is already "All time".
  const allTimeRows = await getLedgerRows(user.id, 'all_time')
  const periodRows = await getLedgerRows(user.id, period)

  const projectIds = [...new Set(periodRows.map((row) => row.project_id).filter((id): id is string => id !== null))]

  let projects: ProjectMeta[] = []
  if (projectIds.length > 0) {
    const { data: projectRows } = await supabase
      .from('projects')
      .select('id, title, source_text, video_type, duration_target')
      .in('id', projectIds)
      .eq('user_id', user.id)
    projects = projectRows ?? []
  }

  const balance = sumBalance(allTimeRows)
  const aggregation = aggregateCreditsPeriod(periodRows, projects)

  return (
    <>
      <TopBar left={<h1 className="text-screen font-medium tracking-tight text-text-primary">Credits</h1>} />
      <PeriodSelector active={period} />

      {aggregation.isEmpty && allTimeRows.length === 0 ? (
        <CreditsEmptyState />
      ) : (
        <div className="flex flex-1 flex-col gap-rc-lg px-rc-lg py-rc-lg pb-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
          <CreditsSummary balance={balance} period={aggregation} />
          <CreditsByStep aggregation={aggregation} />
          <CreditsByProject aggregation={aggregation} />
        </div>
      )}
    </>
  )
}
