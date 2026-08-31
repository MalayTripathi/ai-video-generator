import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Step, Operation } from '@/lib/config/pipeline'
import { TopBar } from '../dashboard/top-bar'
import { parsePeriod, getPeriodRange } from './period'
import { aggregateUsage, type UsageRow, type ProjectMeta } from './aggregate'
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

  const { start, end } = getPeriodRange(period)

  let usageQuery = supabase
    .from('usage')
    .select('id, project_id, step, operation, status, estimated_cost, quoted_cost, created_at')
    .eq('user_id', user.id)

  if (start) usageQuery = usageQuery.gte('created_at', start)
  if (end) usageQuery = usageQuery.lt('created_at', end)

  const { data: usageRows } = await usageQuery

  const rows: UsageRow[] = (usageRows ?? []).map((row) => ({
    id: row.id,
    project_id: row.project_id,
    step: row.step as Step,
    operation: row.operation as Operation,
    status: row.status,
    estimated_cost: row.estimated_cost,
    quoted_cost: row.quoted_cost,
    created_at: row.created_at,
  }))

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
