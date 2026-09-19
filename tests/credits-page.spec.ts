import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { sumBalance, aggregateCreditsPeriod, type ProjectMeta } from '../src/app/(app)/credits/aggregate'
import type { LedgerRow } from '../src/app/(app)/credits/data'
import { operationUnitLabel } from '../src/app/(app)/credits/operation-unit-label'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { SIGNUP_GRANT_CREDITS } from '../src/lib/config/credits'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

function row(overrides: Partial<LedgerRow> & Pick<LedgerRow, 'kind'>): LedgerRow {
  return {
    id: crypto.randomUUID(),
    step: null,
    operation: null,
    project_id: null,
    message_id: null,
    delta: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

test.describe('sumBalance', () => {
  test('sums delta across every kind, unlike the period aggregation which filters to spend', () => {
    const rows = [
      row({ kind: 'signup_grant', delta: 5000 }),
      row({ kind: 'spend', delta: -17 }),
      row({ kind: 'refund', delta: 17 }),
    ]
    expect(sumBalance(rows)).toBe(5000)
  })
})

test.describe('aggregateCreditsPeriod', () => {
  test('groups spend rows by step, then by operation within - leaf credits and percentages sum to the period total', () => {
    const rows: LedgerRow[] = [
      row({ kind: 'spend', step: 'workbench', operation: 'agent_turn', delta: -17 }),
      row({ kind: 'spend', step: 'workbench', operation: 'generate_shots', delta: -8 }),
      row({ kind: 'spend', step: 'workbench', operation: 'derive_camera', delta: -3 }),
    ]

    const aggregation = aggregateCreditsPeriod(rows, [])

    expect(aggregation.spentThisPeriod).toBe(28)
    expect(aggregation.byStep.length).toBe(1)
    expect(aggregation.byStep[0].step).toBe('workbench')
    expect(aggregation.byStep[0].credits).toBe(28)

    const leaves = aggregation.byStep[0].operations
    expect(leaves.map((r) => r.credits).reduce((a, b) => a + b, 0)).toBe(28)
    expect(leaves.map((r) => r.sharePct).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6)
  })

  test('a signup_grant row is excluded from spentThisPeriod, byStep and byProject entirely', () => {
    const rows: LedgerRow[] = [
      row({ kind: 'signup_grant', delta: 5000 }),
      row({ kind: 'spend', step: 'workbench', operation: 'agent_turn', delta: -17, project_id: 'p1' }),
    ]
    const projects: ProjectMeta[] = [{ id: 'p1', title: 'P1', source_text: null, video_type: null, duration_target: null }]

    const aggregation = aggregateCreditsPeriod(rows, projects)

    expect(aggregation.spentThisPeriod).toBe(17)
    expect(aggregation.byStep.every((g) => g.operations.every((op) => op.operation !== undefined))).toBe(true)
    // The grant never contributes a step/operation group nor a project row.
    const totalAcrossSteps = aggregation.byStep.reduce((sum, g) => sum + g.credits, 0)
    expect(totalAcrossSteps).toBe(17)
    expect(aggregation.byProject.length).toBe(1)
    expect(aggregation.byProject[0].total).toBe(17)
  })

  test('a refund row is excluded from spentThisPeriod, byStep and byProject entirely', () => {
    const rows: LedgerRow[] = [
      row({ kind: 'spend', step: 'workbench', operation: 'agent_turn', delta: -17, project_id: 'p1' }),
      row({ kind: 'refund', delta: 17, project_id: 'p1' }),
    ]

    const aggregation = aggregateCreditsPeriod(rows, [])

    expect(aggregation.spentThisPeriod).toBe(17)
    expect(aggregation.byProject[0].total).toBe(17)
  })

  test('a spend row with a null project_id is counted in spentThisPeriod and byStep but excluded from byProject', () => {
    const rows: LedgerRow[] = [
      row({ kind: 'spend', step: 'workbench', operation: 'agent_turn', delta: -17, project_id: null }),
    ]

    const aggregation = aggregateCreditsPeriod(rows, [])

    expect(aggregation.spentThisPeriod).toBe(17)
    expect(aggregation.byStep[0].credits).toBe(17)
    expect(aggregation.byProject.length).toBe(0)
    expect(aggregation.projectsWithSpendCount).toBe(0)
  })

  test('a user with no ledger rows for the period gets isEmpty: true', () => {
    expect(aggregateCreditsPeriod([], []).isEmpty).toBe(true)
  })
})

test.describe('operationUnitLabel', () => {
  test('counts actions with a unit word suited to the operation, never "calls"', () => {
    expect(operationUnitLabel('agent_turn', 17)).toBe('17 turns')
    expect(operationUnitLabel('agent_turn', 1)).toBe('1 turn')
    expect(operationUnitLabel('generate_shots', 1)).toBe('1 generation')
    expect(operationUnitLabel('derive_camera', 2)).toBe('2 derivations')
    // A future priced operation not yet listed falls back to a generic word rather
    // than breaking.
    expect(operationUnitLabel('merge', 3)).toBe('3 actions')
  })

  test('one agent turn counts once regardless of how many underlying Claude calls it made', () => {
    // aggregateCreditsPeriod groups by ledger row, and the ledger writes exactly one
    // row per turn (Task 5) regardless of how many Claude calls that turn made -
    // there is no "callCount" concept here at all, unlike the dollar page's usage rows.
    const rows: LedgerRow[] = [row({ kind: 'spend', step: 'workbench', operation: 'agent_turn', delta: -17 })]
    const aggregation = aggregateCreditsPeriod(rows, [])
    expect(aggregation.byStep[0].operations[0].unitLabel).toBe('1 turn')
  })
})

test.describe('credits page: no usage import (gate 10)', () => {
  test('no file under src/app/(app)/credits/ imports from usage/ except the shared period.ts, and none queries the usage table', () => {
    const dir = path.resolve(__dirname, '../src/app/(app)/credits')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8')
      expect(source.includes("from('usage')")).toBe(false)
      expect(source.includes('.from("usage")')).toBe(false)

      const usageImports = [...source.matchAll(/from\s+['"](\.\.\/usage\/[^'"]+)['"]/g)].map((m) => m[1])
      for (const imp of usageImports) {
        expect(imp).toBe('../usage/period')
      }
    }
  })
})

test.describe('credit_ledger RLS', () => {
  test('a user cannot see another user\'s credit_ledger rows', async () => {
    const { user: userA } = await createTestSession()
    const { user: userB, session: sessionB } = await createTestSession()
    try {
      const { error: insertError } = await admin.from('credit_ledger').insert({
        user_id: userA.id,
        kind: 'signup_grant',
        delta: 5000,
        dedupe_key: `signup_grant:${userA.id}`,
        price_version: 'test',
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
      const { data: rowsForB, error: selectErrorB } = await anonB
        .from('credit_ledger')
        .select('id')
        .eq('user_id', userA.id)
      expect(selectErrorB).toBeNull()
      expect(rowsForB!.length).toBe(0)

      const { data: ownRowsForA } = await admin.from('credit_ledger').select('id').eq('user_id', userA.id)
      expect(ownRowsForA!.length).toBe(1)
    } finally {
      await deleteTestUser(userA.id)
      await deleteTestUser(userB.id)
    }
  })
})

test.describe('credits page', () => {
  // The layout grants a new user their signup credits on first load, but the layout and the
  // page render in parallel, so a page that read the ledger without granting first would show
  // "No credit activity yet" or the balance depending only on which query landed first - and
  // that empty state's own copy says it appears before the account has a balance. The page
  // grants first (idempotently), so a brand-new user always sees the balance they were given.
  test("a brand-new user's first visit shows their signup balance, never the empty state", async ({ page, context }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/credits')
      await expect(page.getByTestId('credits-balance')).toHaveText(SIGNUP_GRANT_CREDITS.toLocaleString('en-US'))
      await expect(page.getByText('No credit activity yet')).toHaveCount(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('the balance tile is identical across all three period tabs, unlike spent-this-period', async ({ page, context }) => {
    const { user, cookie } = await createTestSession()
    try {
      const now = new Date()
      const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))

      const { error: insertError } = await admin.from('credit_ledger').insert([
        {
          user_id: user.id,
          kind: 'signup_grant',
          delta: 5000,
          dedupe_key: `signup_grant:${user.id}`,
          price_version: 'test',
          created_at: lastMonth.toISOString(),
        },
        {
          user_id: user.id,
          kind: 'spend',
          delta: -17,
          step: 'workbench',
          operation: 'agent_turn',
          attempt_id: crypto.randomUUID(),
          pricing_mode: 'dynamic',
          dedupe_key: `agent_turn:${crypto.randomUUID()}`,
          price_version: 'test',
          created_at: lastMonth.toISOString(),
        },
      ])
      expect(insertError).toBeNull()

      await context.addCookies([cookie])

      await page.goto('/credits?period=this_month')
      await expect(page.getByTestId('credits-balance')).toHaveText('4,983')
      // Nothing spent this month - the spend above is all dated last month.
      await expect(page.getByTestId('credits-spent-this-period')).toHaveText('0')

      await page.goto('/credits?period=last_month')
      await expect(page.getByTestId('credits-balance')).toHaveText('4,983')
      await expect(page.getByTestId('credits-spent-this-period')).toHaveText('17')

      await page.goto('/credits?period=all_time')
      await expect(page.getByTestId('credits-balance')).toHaveText('4,983')
      await expect(page.getByTestId('credits-spent-this-period')).toHaveText('17')
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
