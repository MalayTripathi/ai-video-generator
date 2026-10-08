// FROZEN ORACLE - a verbatim copy of the credit/rail figure code as it stood before
// Perf Task 3 moved the sums into Postgres views (HEAD e5dff0b: credits/data.ts's
// getLedgerRows, usage/data.ts's getUsageRows, credits/aggregate.ts). It fetches raw rows
// and sums them in JS exactly as the app used to, so credit-figures-equivalence.spec.ts
// can assert the view-based figures equal today's for the same seeded data. Do not "fix"
// or modernise this file - its only job is to stay what the old implementation was.
import type { SupabaseClient } from '@supabase/supabase-js'
import { stepLabel, stepOperationLabel, type Step, type Operation } from '../../src/lib/config/pipeline'
import { displayTitle } from '../../src/lib/display-title'
import { videoTypeLabel } from '../../src/lib/video-type-labels'
import { durationConfig, type DurationTarget } from '../../src/lib/config/duration'
import { operationUnitLabel } from '../../src/app/(app)/credits/operation-unit-label'
import { getPeriodRange, type Period } from '../../src/app/(app)/usage/period'
import type { UsageRow } from '../../src/app/(app)/usage/aggregate'

export type LedgerRow = {
  id: string
  kind: string
  step: Step | null
  operation: Operation | null
  project_id: string | null
  message_id: string | null
  delta: number
  created_at: string
}

export async function oldGetLedgerRows(supabase: SupabaseClient, userId: string, period: Period): Promise<LedgerRow[]> {
  const { start, end } = getPeriodRange(period)

  let query = supabase
    .from('credit_ledger')
    .select('id, kind, step, operation, project_id, message_id, delta, created_at')
    .eq('user_id', userId)

  if (start) query = query.gte('created_at', start)
  if (end) query = query.lt('created_at', end)

  const { data } = await query

  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    step: row.step as Step | null,
    operation: row.operation as Operation | null,
    project_id: row.project_id,
    message_id: row.message_id,
    delta: row.delta,
    created_at: row.created_at,
  }))
}

export async function oldGetUsageRows(supabase: SupabaseClient, userId: string, period: Period): Promise<UsageRow[]> {
  const { start, end } = getPeriodRange(period)

  let query = supabase
    .from('usage')
    .select('id, project_id, step, operation, status, estimated_cost, quoted_cost, created_at, raw_usage')
    .eq('user_id', userId)

  if (start) query = query.gte('created_at', start)
  if (end) query = query.lt('created_at', end)

  const { data } = await query

  return (data ?? []).map((row) => ({
    id: row.id,
    project_id: row.project_id,
    step: row.step as Step,
    operation: row.operation as Operation,
    status: row.status,
    estimated_cost: row.estimated_cost,
    quoted_cost: row.quoted_cost,
    created_at: row.created_at,
    blocked: (row.raw_usage as { blocked?: boolean } | null)?.blocked === true,
  }))
}

export type ProjectMeta = {
  id: string
  title: string | null
  source_text: string | null
  video_type: string | null
  duration_target: string | null
}

export type OperationBreakdownRow = {
  step: Step
  operation: Operation
  label: string
  credits: number
  sharePct: number
  unitLabel: string
}

export type StepBreakdownGroup = {
  step: Step
  label: string
  credits: number
  operations: OperationBreakdownRow[]
}

export type ProjectBreakdownRow = {
  projectId: string
  title: string
  videoTypeLabel: string | null
  durationLabel: string | null
  total: number
  /** sharePct within each row is this project's own share, not the period's. */
  bySteps: OperationBreakdownRow[]
}

export type CreditsPeriodAggregation = {
  spentThisPeriod: number
  projectsWithSpendCount: number
  byStep: StepBreakdownGroup[]
  byProject: ProjectBreakdownRow[]
  isEmpty: boolean
}

/** SUM(delta) over whatever rows it's given - the balance tile calls this with
 * all-time rows regardless of the active period tab, since a balance is a
 * present-moment fact, not a periodic one. */
export function oldSumBalance(rows: { delta: number }[]): number {
  return rows.reduce((sum, row) => sum + row.delta, 0)
}

function buildOperationBreakdown(rows: LedgerRow[], denominatorTotal: number): OperationBreakdownRow[] {
  const groups = new Map<string, { step: Step; operation: Operation; credits: number; count: number }>()

  for (const row of rows) {
    if (row.step === null || row.operation === null) continue
    const key = `${row.step}:${row.operation}`
    const credits = -row.delta
    const existing = groups.get(key)
    if (existing) {
      existing.credits += credits
      existing.count += 1
    } else {
      groups.set(key, { step: row.step, operation: row.operation, credits, count: 1 })
    }
  }

  return [...groups.values()]
    .map((group) => ({
      step: group.step,
      operation: group.operation,
      label: stepOperationLabel(group.step, group.operation),
      credits: group.credits,
      sharePct: denominatorTotal > 0 ? (group.credits / denominatorTotal) * 100 : 0,
      unitLabel: operationUnitLabel(group.operation, group.count),
    }))
    .sort((a, b) => b.credits - a.credits)
}

function buildStepBreakdown(rows: LedgerRow[], denominatorTotal: number): StepBreakdownGroup[] {
  const operationRows = buildOperationBreakdown(rows, denominatorTotal)

  const bySteps = new Map<Step, OperationBreakdownRow[]>()
  for (const row of operationRows) {
    const list = bySteps.get(row.step) ?? []
    list.push(row)
    bySteps.set(row.step, list)
  }

  return [...bySteps.entries()]
    .map(([step, operations]) => ({
      step,
      label: stepLabel(step),
      credits: operations.reduce((sum, op) => sum + op.credits, 0),
      operations,
    }))
    .sort((a, b) => b.credits - a.credits)
}

/**
 * Aggregates a period's `credit_ledger` rows in memory, the same reasoning
 * usage/aggregate.ts documents for `usage`: a real GROUP BY needs `.rpc()`, which this
 * codebase forbids. Every output here is filtered to `kind === 'spend'` first - grants
 * and refunds move the balance but are never spend, so they must never appear in
 * spentThisPeriod, byStep, or byProject.
 */
export function oldAggregateCreditsPeriod(rows: LedgerRow[], projects: ProjectMeta[]): CreditsPeriodAggregation {
  const spendRows = rows.filter((row) => row.kind === 'spend')

  const spentThisPeriod = spendRows.reduce((sum, row) => sum + -row.delta, 0)

  const byStep = buildStepBreakdown(spendRows, spentThisPeriod)

  const projectMetaById = new Map(projects.map((project) => [project.id, project]))
  const projectSpendRows = spendRows.filter((row): row is LedgerRow & { project_id: string } => row.project_id !== null)
  const projectIds = [...new Set(projectSpendRows.map((row) => row.project_id))]

  const byProject: ProjectBreakdownRow[] = projectIds
    .map((projectId) => {
      const projectRows = projectSpendRows.filter((row) => row.project_id === projectId)
      const total = projectRows.reduce((sum, row) => sum + -row.delta, 0)
      const meta = projectMetaById.get(projectId)
      const durationLabel =
        meta?.duration_target && meta.duration_target in durationConfig
          ? durationConfig[meta.duration_target as DurationTarget].label
          : null

      return {
        projectId,
        title: meta ? displayTitle(meta) : 'Untitled project',
        videoTypeLabel: meta?.video_type ? videoTypeLabel(meta.video_type) : null,
        durationLabel,
        total,
        bySteps: buildOperationBreakdown(projectRows, total),
      }
    })
    .sort((a, b) => b.total - a.total)

  return {
    spentThisPeriod,
    projectsWithSpendCount: projectIds.length,
    byStep,
    byProject,
    isEmpty: rows.length === 0,
  }
}
