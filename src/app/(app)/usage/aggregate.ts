import { STALE_AFTER_MS } from '@/lib/generations/claim'
import { stepOperationLabel, type Step, type Operation } from '@/lib/config/pipeline'
import { displayTitle } from '@/lib/display-title'
import { videoTypeLabel } from '@/lib/video-type-labels'
import { durationConfig, type DurationTarget } from '@/lib/config/duration'

export type UsageRow = {
  id: string
  project_id: string | null
  step: Step
  operation: Operation
  status: string
  estimated_cost: number | null
  quoted_cost: number | null
  created_at: string
  /** Derived from raw_usage.blocked - a call assertLiveCallsAllowed() refused before
   * any request reached the provider. Never a real call, so excluded from callCount. */
  blocked: boolean
}

export type ProjectMeta = {
  id: string
  title: string | null
  source_text: string | null
  video_type: string | null
  duration_target: string | null
}

export type StepBreakdownRow = {
  step: Step
  operation: Operation
  label: string
  cost: number
  sharePct: number
  callCount: number
}

export type ProjectBreakdownRow = {
  projectId: string | null
  title: string
  videoTypeLabel: string | null
  durationLabel: string | null
  total: number
  /** sharePct within each row is this project's own share, not the grand total's. */
  bySteps: StepBreakdownRow[]
}

export type CalibrationSummary = {
  count: number
  meanDelta: number
  meanRatio: number | null
}

export type UsageAggregation = {
  settledTotal: number
  pendingTotal: number
  projectsWithSpendCount: number
  byStep: StepBreakdownRow[]
  byProject: ProjectBreakdownRow[]
  anomalies: {
    stalePending: { count: number; total: number }
    /** Refused by assertLiveCallsAllowed() before any request reached the provider - cost nothing. */
    blocked: { count: number; total: number }
    /** Genuinely failed, non-blocked calls - billed for what was used. */
    failed: { count: number; total: number }
  }
  calibration: CalibrationSummary
  isEmpty: boolean
}

function sumCost(rows: UsageRow[]): number {
  return rows.reduce((sum, row) => sum + (row.estimated_cost ?? 0), 0)
}

function buildStepBreakdown(rows: UsageRow[], denominatorTotal: number): StepBreakdownRow[] {
  const groups = new Map<string, { step: Step; operation: Operation; cost: number; callCount: number }>()

  for (const row of rows) {
    const key = `${row.step}:${row.operation}`
    const cost = row.estimated_cost ?? 0
    const existing = groups.get(key)
    if (existing) {
      existing.cost += cost
      existing.callCount += 1
    } else {
      groups.set(key, { step: row.step, operation: row.operation, cost, callCount: 1 })
    }
  }

  return [...groups.values()]
    .map((group) => ({
      step: group.step,
      operation: group.operation,
      label: stepOperationLabel(group.step, group.operation),
      cost: group.cost,
      sharePct: denominatorTotal > 0 ? (group.cost / denominatorTotal) * 100 : 0,
      callCount: group.callCount,
    }))
    .sort((a, b) => b.cost - a.cost)
}

/**
 * Compares each settled row's measured estimated_cost against its immutable
 * quoted_cost - the calibration signal for estimateInputTokens's known
 * downward-biased estimate and for eventually setting SPEND_CAP_MONTHLY_USD from
 * evidence rather than a guess (see CLAUDE.md). A settled row with no quoted_cost
 * (pre-migration data) is excluded rather than treated as zero delta. A blocked row is
 * excluded too - it settles at estimated_cost 0 by design, so its ratio is always 0 and
 * would drag the mean toward zero for a call that was never actually measured.
 */
function buildCalibration(settledRows: UsageRow[]): CalibrationSummary {
  const eligible = settledRows.filter(
    (row): row is UsageRow & { quoted_cost: number } => row.quoted_cost !== null && !row.blocked
  )

  const meanDelta =
    eligible.length > 0
      ? eligible.reduce((sum, row) => sum + ((row.estimated_cost ?? 0) - row.quoted_cost), 0) / eligible.length
      : 0

  const ratioRows = eligible.filter((row) => row.quoted_cost > 0)
  const meanRatio =
    ratioRows.length > 0
      ? ratioRows.reduce((sum, row) => sum + (row.estimated_cost ?? 0) / row.quoted_cost, 0) / ratioRows.length
      : null

  return { count: eligible.length, meanDelta, meanRatio }
}

/**
 * Aggregates a period's `usage` rows in memory - the answer to "what does a project
 * cost, and what share is Step 7" needs a GROUP BY that supabase-js can't express
 * without `.rpc()`, which this codebase forbids (see CLAUDE.md's Provider calls
 * section). This is fine at hundreds of rows. Once a user accumulates thousands of
 * `usage` rows, this must become a Postgres VIEW with `security_invoker` (never a
 * function/`.rpc()`) so the database does the grouping - do not scale this function
 * further, replace it.
 *
 * "Settled" = status IN ('succeeded', 'failed') - both are measured costs (a failed
 * call, e.g. a max_tokens truncation, is billed in full, per the reserve-then-settle
 * docblock). "Pending" is reported separately everywhere in this aggregation, never
 * merged into a settled figure - a pending row carries a worst-case pre-flight quote,
 * and folding it into byStep/byProject would misrepresent which step actually costs
 * the most, the exact inflation risk the summary total is split to avoid.
 */
export function aggregateUsage(rows: UsageRow[], projects: ProjectMeta[], now: Date = new Date()): UsageAggregation {
  const settledRows = rows.filter((row) => row.status === 'succeeded' || row.status === 'failed')
  const pendingRows = rows.filter((row) => row.status === 'pending')
  const blockedRows = rows.filter((row) => row.blocked)
  const failedRows = rows.filter((row) => row.status === 'failed' && !row.blocked)

  const settledTotal = sumCost(settledRows)
  const pendingTotal = sumCost(pendingRows)

  // Blocked rows (assertLiveCallsAllowed refused before any request reached the
  // provider) settle at estimated_cost 0, so they never move settledTotal - but they
  // must also never inflate callCount, since a blocked call was never a call.
  const byStep = buildStepBreakdown(
    settledRows.filter((row) => !row.blocked),
    settledTotal
  )

  const projectMetaById = new Map(projects.map((project) => [project.id, project]))
  const projectIds = [...new Set(settledRows.map((row) => row.project_id))]
  const projectsWithSpendCount = projectIds.filter((id) => id !== null).length

  const byProject: ProjectBreakdownRow[] = projectIds
    .map((projectId) => {
      const projectRows = settledRows.filter((row) => row.project_id === projectId)
      const total = sumCost(projectRows)
      const meta = projectId ? projectMetaById.get(projectId) : undefined
      const durationLabel =
        meta?.duration_target && meta.duration_target in durationConfig
          ? durationConfig[meta.duration_target as DurationTarget].label
          : null

      return {
        projectId,
        title: projectId ? (meta ? displayTitle(meta) : 'Untitled project') : 'Deleted project',
        videoTypeLabel: meta?.video_type ? videoTypeLabel(meta.video_type) : null,
        durationLabel,
        total,
        bySteps: buildStepBreakdown(
          projectRows.filter((row) => !row.blocked),
          total
        ),
      }
    })
    .sort((a, b) => b.total - a.total)

  // Anchored on created_at (when the reservation was written) - `usage` has no
  // started_at of its own the way `generations` does, and created_at is set once at
  // reserveUsage's INSERT, so it plays the same role here.
  const staleBefore = now.getTime() - STALE_AFTER_MS
  const stalePendingRows = pendingRows.filter((row) => new Date(row.created_at).getTime() < staleBefore)

  return {
    settledTotal,
    pendingTotal,
    projectsWithSpendCount,
    byStep,
    byProject,
    anomalies: {
      stalePending: { count: stalePendingRows.length, total: sumCost(stalePendingRows) },
      blocked: { count: blockedRows.length, total: sumCost(blockedRows) },
      failed: { count: failedRows.length, total: sumCost(failedRows) },
    },
    calibration: buildCalibration(settledRows),
    isEmpty: rows.length === 0,
  }
}
