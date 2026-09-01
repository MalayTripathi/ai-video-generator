import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TopBar } from '../dashboard/top-bar'
import { parsePeriod } from './period'
import { getUsageRows } from './data'
import { aggregateUsage, type ProjectMeta } from './aggregate'
import { PeriodSelector } from './period-selector'
import { UsageSummary } from './usage-summary'
import { UsageByStep } from './usage-by-step'
import { UsageByProject } from './usage-by-project'
import { UsageAnomalies } from './usage-anomalies'
import { UsageEmptyState } from './usage-empty-state'

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period: rawPeriod } = await searchParams
  const period = parsePeriod(rawPeriod)

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const rows = await getUsageRows(user.id, period)

  const projectIds = [...new Set(rows.map((row) => row.project_id).filter((id): id is string => id !== null))]

  let projects: ProjectMeta[] = []
  if (projectIds.length > 0) {
    const { data: projectRows } = await supabase
      .from('projects')
      .select('id, title, source_text, video_type, duration_target')
      .in('id', projectIds)
      .eq('user_id', user.id)
    projects = projectRows ?? []
  }

  const aggregation = aggregateUsage(rows, projects)

  return (
    <>
      <TopBar left={<h1 className="text-screen font-medium tracking-tight text-text-primary">Usage</h1>} />
      <PeriodSelector active={period} />

      {aggregation.isEmpty ? (
        <UsageEmptyState />
      ) : (
        <div className="flex flex-1 flex-col gap-rc-lg px-rc-lg py-rc-lg pb-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
          <UsageSummary aggregation={aggregation} />
          <UsageByStep aggregation={aggregation} />
          <UsageByProject aggregation={aggregation} />
          <UsageAnomalies aggregation={aggregation} />
        </div>
      )}
    </>
  )
}
