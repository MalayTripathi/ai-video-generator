import { stepLabel, stepOperationLabel, type Step, type Operation } from '@/lib/config/pipeline'
import { displayTitle } from '@/lib/display-title'
import { videoTypeLabel } from '@/lib/video-type-labels'
import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import { operationUnitLabel } from './operation-unit-label'

/** What the aggregation reads: a single ledger row (entries defaults to 1), or a group
 * of rows Postgres already summed (delta = their summed delta, entries = how many). Both
 * produce identical figures, since every output is a sum and every count a sum of counts. */
export type LedgerAggregateRow = {
  kind: string
  step: Step | null
  operation: Operation | null
  project_id: string | null
  delta: number
  entries?: number
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

function buildOperationBreakdown(rows: LedgerAggregateRow[], denominatorTotal: number): OperationBreakdownRow[] {
  const groups = new Map<string, { step: Step; operation: Operation; credits: number; count: number }>()

  for (const row of rows) {
    if (row.step === null || row.operation === null) continue
    const key = `${row.step}:${row.operation}`
    const credits = -row.delta
    const count = row.entries ?? 1
    const existing = groups.get(key)
    if (existing) {
      existing.credits += credits
      existing.count += count
    } else {
      groups.set(key, { step: row.step, operation: row.operation, credits, count })
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

function buildStepBreakdown(rows: LedgerAggregateRow[], denominatorTotal: number): StepBreakdownGroup[] {
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
 * Shapes a period's ledger totals for /credits. Postgres does the row-level GROUP BY (the
 * credit_ledger_monthly view); this only rolls those few groups up by step and project.
 * Every output here is filtered to `kind === 'spend'` first - grants and refunds move
 * the balance but are never spend, so they must never appear in spentThisPeriod, byStep,
 * or byProject.
 */
export function aggregateCreditsPeriod(rows: LedgerAggregateRow[], projects: ProjectMeta[]): CreditsPeriodAggregation {
  const spendRows = rows.filter((row) => row.kind === 'spend')

  const spentThisPeriod = spendRows.reduce((sum, row) => sum + -row.delta, 0)

  const byStep = buildStepBreakdown(spendRows, spentThisPeriod)

  const projectMetaById = new Map(projects.map((project) => [project.id, project]))
  const projectSpendRows = spendRows.filter((row): row is LedgerAggregateRow & { project_id: string } => row.project_id !== null)
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
