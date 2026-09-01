import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { aggregateUsage, type UsageRow, type ProjectMeta } from '../src/app/(app)/usage/aggregate'
import { getPeriodRange } from '../src/app/(app)/usage/period'
import { STALE_AFTER_MS } from '../src/lib/generations/claim'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

function row(overrides: Partial<UsageRow> & Pick<UsageRow, 'step' | 'operation' | 'status'>): UsageRow {
  return {
    id: crypto.randomUUID(),
    project_id: null,
    estimated_cost: 0,
    quoted_cost: null,
    created_at: new Date().toISOString(),
    blocked: false,
    ...overrides,
  }
}

test.describe('aggregateUsage', () => {
  test('step totals and percentages are correct against a known fixture', () => {
    const rows: UsageRow[] = [
      row({ step: 'workbench', operation: 'generate_shots', status: 'succeeded', estimated_cost: 0.02 }),
      row({ step: 'workbench', operation: 'generate_shots', status: 'failed', estimated_cost: 0.01 }),
      row({ step: 'image_prompts', operation: 'write_prompts', status: 'succeeded', estimated_cost: 0.03 }),
    ]

    const aggregation = aggregateUsage(rows, [])

    expect(aggregation.settledTotal).toBeCloseTo(0.06, 6)

    const workbenchRow = aggregation.byStep.find((r) => r.step === 'workbench' && r.operation === 'generate_shots')
    expect(workbenchRow?.cost).toBeCloseTo(0.03, 6)
    expect(workbenchRow?.callCount).toBe(2)
    expect(workbenchRow?.sharePct).toBeCloseTo(50, 6)
    expect(workbenchRow?.label).toBe('Workbench — New shots')

    const promptsRow = aggregation.byStep.find((r) => r.step === 'image_prompts' && r.operation === 'write_prompts')
    expect(promptsRow?.cost).toBeCloseTo(0.03, 6)
    expect(promptsRow?.callCount).toBe(1)
    expect(promptsRow?.sharePct).toBeCloseTo(50, 6)
  })

  test('a row with a null project_id appears under the deleted-project grouping and is included in the period total', () => {
    const rows: UsageRow[] = [
      row({ step: 'workbench', operation: 'generate_shots', status: 'succeeded', estimated_cost: 0.05, project_id: null }),
    ]

    const aggregation = aggregateUsage(rows, [])

    expect(aggregation.settledTotal).toBeCloseTo(0.05, 6)
    expect(aggregation.byProject.length).toBe(1)
    expect(aggregation.byProject[0].projectId).toBeNull()
    expect(aggregation.byProject[0].title).toBe('Deleted project')
    expect(aggregation.byProject[0].total).toBeCloseTo(0.05, 6)
    // A null-project row has no owning project, so it never counts toward
    // "projects with spend".
    expect(aggregation.projectsWithSpendCount).toBe(0)
  })

  test('pending rows are excluded from the settled total and reported separately', () => {
    const projects: ProjectMeta[] = [
      { id: 'p1', title: 'Test project', source_text: null, video_type: 'narrated_story', duration_target: '30-60s' },
    ]
    const rows: UsageRow[] = [
      row({ step: 'workbench', operation: 'generate_shots', status: 'succeeded', estimated_cost: 0.02, project_id: 'p1' }),
      row({ step: 'workbench', operation: 'generate_shots', status: 'pending', estimated_cost: 10, project_id: 'p1' }),
    ]

    const aggregation = aggregateUsage(rows, projects)

    expect(aggregation.settledTotal).toBeCloseTo(0.02, 6)
    expect(aggregation.pendingTotal).toBeCloseTo(10, 6)
    expect(aggregation.byStep[0].cost).toBeCloseTo(0.02, 6)
    expect(aggregation.byStep[0].callCount).toBe(1)
    expect(aggregation.byProject[0].total).toBeCloseTo(0.02, 6)
  })

  test('the stale-pending anomaly boundary derives from STALE_AFTER_MS, not a literal', () => {
    const now = new Date('2026-08-31T12:00:00.000Z')
    const staleRow = row({
      step: 'workbench',
      operation: 'generate_shots',
      status: 'pending',
      estimated_cost: 0.5,
      created_at: new Date(now.getTime() - STALE_AFTER_MS - 1_000).toISOString(),
    })
    const freshRow = row({
      step: 'workbench',
      operation: 'generate_shots',
      status: 'pending',
      estimated_cost: 0.5,
      created_at: new Date(now.getTime() - STALE_AFTER_MS + 1_000).toISOString(),
    })

    const aggregation = aggregateUsage([staleRow, freshRow], [], now)

    expect(aggregation.anomalies.stalePending.count).toBe(1)
    expect(aggregation.anomalies.stalePending.total).toBeCloseTo(0.5, 6)
  })

  test('calibration is skipped when no settled row has a quoted_cost', () => {
    const rows: UsageRow[] = [
      row({ step: 'workbench', operation: 'generate_shots', status: 'succeeded', estimated_cost: 0.05, quoted_cost: null }),
      row({ step: 'workbench', operation: 'generate_shots', status: 'failed', estimated_cost: 0.01, quoted_cost: null }),
    ]

    const aggregation = aggregateUsage(rows, [])

    expect(aggregation.calibration.count).toBe(0)
    expect(aggregation.calibration.meanDelta).toBe(0)
    expect(aggregation.calibration.meanRatio).toBeNull()
  })

  test('calibration averages the delta and ratio across settled rows that have a quoted_cost', () => {
    const rows: UsageRow[] = [
      row({ step: 'workbench', operation: 'generate_shots', status: 'succeeded', estimated_cost: 0.03, quoted_cost: 0.02 }),
      row({ step: 'image_prompts', operation: 'write_prompts', status: 'failed', estimated_cost: 0.01, quoted_cost: 0.02 }),
      // Excluded: no quoted_cost (pre-migration row).
      row({ step: 'workbench', operation: 'generate_shots', status: 'succeeded', estimated_cost: 0.5, quoted_cost: null }),
      // Excluded: not settled.
      row({ step: 'workbench', operation: 'generate_shots', status: 'pending', estimated_cost: 5, quoted_cost: 0.5 }),
    ]

    const aggregation = aggregateUsage(rows, [])

    expect(aggregation.calibration.count).toBe(2)
    expect(aggregation.calibration.meanDelta).toBeCloseTo(0, 6) // (+0.01 + -0.01) / 2
    expect(aggregation.calibration.meanRatio).toBeCloseTo(1.0, 6) // (1.5 + 0.5) / 2
  })

  test('blocked rows do not count toward the settled total or the per-step call count', () => {
    const rows: UsageRow[] = [
      row({ step: 'workbench', operation: 'generate_shots', status: 'succeeded', estimated_cost: 0.02 }),
      row({ step: 'workbench', operation: 'generate_shots', status: 'failed', estimated_cost: 0, blocked: true }),
    ]

    const aggregation = aggregateUsage(rows, [])

    expect(aggregation.settledTotal).toBeCloseTo(0.02, 6)
    const workbenchRow = aggregation.byStep.find((r) => r.step === 'workbench' && r.operation === 'generate_shots')
    expect(workbenchRow?.callCount).toBe(1)
    // Still a real event worth seeing in Anomalies, but under its own "blocked" bucket,
    // not "failed" - a blocked call was refused before any request was sent, which is a
    // different story from a call that reached the provider and failed.
    expect(aggregation.anomalies.blocked.count).toBe(1)
    expect(aggregation.anomalies.failed.count).toBe(0)
  })

  test('calibration excludes blocked rows even when they carry a quoted_cost', () => {
    const rows: UsageRow[] = [
      row({
        step: 'workbench',
        operation: 'generate_shots',
        status: 'failed',
        estimated_cost: 0,
        quoted_cost: 0.02,
        blocked: true,
      }),
      row({
        step: 'workbench',
        operation: 'generate_shots',
        status: 'succeeded',
        estimated_cost: 0.03,
        quoted_cost: 0.02,
      }),
    ]

    const aggregation = aggregateUsage(rows, [])

    // Only the non-blocked settled row counts - if the blocked row's 0/0.02 ratio were
    // included, the mean would be dragged toward 0 instead of reading the one real
    // calibration point.
    expect(aggregation.calibration.count).toBe(1)
    expect(aggregation.calibration.meanDelta).toBeCloseTo(0.01, 6)
    expect(aggregation.calibration.meanRatio).toBeCloseTo(1.5, 6)
  })

  test('calibration is empty when every row present is blocked', () => {
    const rows: UsageRow[] = [
      row({
        step: 'workbench',
        operation: 'generate_shots',
        status: 'failed',
        estimated_cost: 0,
        quoted_cost: 0.02,
        blocked: true,
      }),
    ]

    const aggregation = aggregateUsage(rows, [])

    expect(aggregation.calibration.count).toBe(0)
    expect(aggregation.calibration.meanRatio).toBeNull()
  })

  test('anomalies.blocked and anomalies.failed are independently non-zero only when that kind of row exists', () => {
    const onlyBlocked = aggregateUsage(
      [row({ step: 'workbench', operation: 'generate_shots', status: 'failed', estimated_cost: 0, blocked: true })],
      []
    )
    expect(onlyBlocked.anomalies.blocked.count).toBe(1)
    expect(onlyBlocked.anomalies.failed.count).toBe(0)

    const onlyFailed = aggregateUsage(
      [row({ step: 'workbench', operation: 'generate_shots', status: 'failed', estimated_cost: 0.01 })],
      []
    )
    expect(onlyFailed.anomalies.blocked.count).toBe(0)
    expect(onlyFailed.anomalies.failed.count).toBe(1)
  })

  test('a user with no rows for the period gets isEmpty: true', () => {
    const aggregation = aggregateUsage([], [])
    expect(aggregation.isEmpty).toBe(true)
  })
})

test.describe('getPeriodRange', () => {
  test('a row outside the selected period is excluded by the returned bounds', () => {
    const now = new Date('2026-08-31T12:00:00.000Z')
    const { start, end } = getPeriodRange('this_month', now)
    expect(start).toBe('2026-08-01T00:00:00.000Z')
    expect(end).toBe('2026-09-01T00:00:00.000Z')

    const inPeriod = (createdAt: string) => (!start || createdAt >= start) && (!end || createdAt < end)

    expect(inPeriod('2026-07-31T23:59:59.999Z')).toBe(false) // just before the month - excluded
    expect(inPeriod('2026-08-15T00:00:00.000Z')).toBe(true) // inside the month - included
    expect(inPeriod('2026-09-01T00:00:00.000Z')).toBe(false) // next month's boundary - excluded

    const lastMonth = getPeriodRange('last_month', now)
    expect(lastMonth).toEqual({ start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' })

    expect(getPeriodRange('all_time', now)).toEqual({ start: null, end: null })
  })
})

test.describe('usage RLS', () => {
  test('a user cannot see another user\'s usage rows', async () => {
    const { user: userA } = await createTestSession()
    const { user: userB, session: sessionB } = await createTestSession()
    try {
      const { error: insertError } = await admin.from('usage').insert({
        user_id: userA.id,
        project_id: null,
        step: 'workbench',
        operation: 'generate_shots',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        status: 'succeeded',
        estimated_cost: 0.05,
      })
      expect(insertError).toBeNull()

      const anonB = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { error: setSessionError } = await anonB.auth.setSession({
        access_token: sessionB!.access_token,
        refresh_token: sessionB!.refresh_token,
      })
      expect(setSessionError).toBeNull()

      // Even explicitly filtering for A's own user_id, B's scoped client sees nothing -
      // RLS, not app-level filtering, is what's hiding the row.
      const { data: rowsForB, error: selectErrorB } = await anonB.from('usage').select('id').eq('user_id', userA.id)
      expect(selectErrorB).toBeNull()
      expect(rowsForB!.length).toBe(0)

      const { data: ownRowsForA } = await admin.from('usage').select('id').eq('user_id', userA.id)
      expect(ownRowsForA!.length).toBe(1)
    } finally {
      await deleteTestUser(userA.id)
      await deleteTestUser(userB.id)
    }
  })
})

test.describe('usage page', () => {
  test('empty state renders for a user with no usage rows', async ({ page, context }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/usage')
      await expect(page.getByText('No spend yet')).toBeVisible()
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

test.describe('rail usage spending', () => {
  // Asserts an exact dollar figure for "this user, this month" - like the allowance-
  // ceiling test in usage-module.spec.ts, this needs its own fresh createTestSession()
  // user rather than the shared primary/secondary fixed users, which accumulate usage
  // rows across every run and so can't support an exact-total assertion.
  test('shows settled, non-blocked spend for the current month, excluding pending and blocked rows', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      const { error: insertError } = await admin.from('usage').insert([
        {
          user_id: user.id,
          project_id: null,
          step: 'workbench',
          operation: 'generate_shots',
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          status: 'succeeded',
          estimated_cost: 0.05,
        },
        // Pending: a worst-case reservation, not settled spend - must not inflate the rail.
        {
          user_id: user.id,
          project_id: null,
          step: 'workbench',
          operation: 'generate_shots',
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          status: 'pending',
          estimated_cost: 10,
        },
        // Blocked: refused before any request was sent - already $0, but must not even
        // count as a "call" toward the figure conceptually.
        {
          user_id: user.id,
          project_id: null,
          step: 'workbench',
          operation: 'generate_shots',
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          status: 'failed',
          estimated_cost: 0,
          raw_usage: { blocked: true, billed: false, reason: 'test fixture' },
        },
      ])
      expect(insertError).toBeNull()

      await context.addCookies([cookie])
      await page.goto('/dashboard')

      await expect(page.getByRole('link', { name: 'Usage spending' })).toContainText('$0.05')
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
