import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/database.types'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { secondary } from './fixed-users'
import { readBalance } from '../src/lib/credits/balance'
import { readLedgerGroups } from '../src/app/(app)/credits/data'
import { aggregateCreditsPeriod, type ProjectMeta } from '../src/app/(app)/credits/aggregate'
import { readRailFigures } from '../src/app/(app)/rail-figures'
import { aggregateUsage } from '../src/app/(app)/usage/aggregate'
import { getPeriodRange, type Period } from '../src/app/(app)/usage/period'
import { formatCost } from '../src/lib/format-cost'
import { formatCredits } from '../src/lib/format-credits'
import {
  oldGetLedgerRows,
  oldGetUsageRows,
  oldSumBalance,
  oldAggregateCreditsPeriod,
} from './helpers/credit-figures-reference'

// The rail, /credits balance and /credits breakdowns now sum in Postgres (security_invoker
// views) instead of in JS. These assert, for one seeded user, that every figure equals
// what the old row-by-row implementation (a frozen copy in helpers/) computes from the
// same rows - and that the views widen nobody's access. A fresh user: balance and month
// totals are global per-user facts.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const PERIODS: Period[] = ['this_month', 'last_month', 'all_time']

async function userClient(session: { access_token: string; refresh_token: string }) {
  const client = createClient<Database>(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await client.auth.setSession(session)
  expect(error).toBeNull()
  return client
}

async function seed(userId: string) {
  const now = new Date()
  const thisStart = new Date(getPeriodRange('this_month', now).start!)
  const lastStart = new Date(getPeriodRange('last_month', now).start!)
  const at = (base: Date, ms: number) => new Date(base.getTime() + ms).toISOString()
  const recent = at(now, -60_000)
  const lastMonth = at(lastStart, 3 * 86_400_000)
  const older = at(lastStart, -40 * 86_400_000)
  const boundary = thisStart.toISOString() // exactly the first instant of this month
  const justBefore = at(thisStart, -1) // last millisecond of last month

  const { data: projects, error: projectError } = await admin
    .from('projects')
    .insert([
      { user_id: userId, title: 'Alpha', source_text: 'Alpha film.', video_type: 'explainer', duration_target: '30-60s' },
      { user_id: userId, title: null, source_text: 'An untitled second film about the sea.', video_type: 'auto', duration_target: '1-2min' },
    ])
    .select('id')
  expect(projectError).toBeNull()
  const [p1, p2] = projects!.map((p) => p.id)

  let n = 0
  const spend = (createdAt: string, step: string, operation: string, delta: number, projectId: string | null) => ({
    user_id: userId,
    kind: 'spend',
    delta,
    step,
    operation,
    project_id: projectId,
    attempt_id: crypto.randomUUID(),
    pricing_mode: 'fixed',
    dedupe_key: `equiv:${userId}:${n++}`,
    price_version: 'test',
    created_at: createdAt,
  })
  const other = (createdAt: string, kind: string, delta: number, projectId: string | null = null) => ({
    user_id: userId,
    kind,
    delta,
    step: null,
    operation: null,
    project_id: projectId,
    attempt_id: null,
    pricing_mode: null,
    dedupe_key: `equiv:${userId}:${n++}`,
    price_version: 'test',
    created_at: createdAt,
  })
  const { error: ledgerError } = await admin.from('credit_ledger').insert([
    other(older, 'signup_grant', 5000),
    spend(recent, 'workbench', 'agent_turn', -17, p1),
    spend(recent, 'workbench', 'agent_turn', -4, p1),
    spend(recent, 'workbench', 'generate_shots', -8, p1),
    spend(recent, 'image_prompts', 'write_image_prompts', -29, p2),
    spend(boundary, 'storyboard', 'generate_image', -41, p2),
    spend(recent, 'workbench', 'derive_camera', -2, null),
    other(recent, 'refund', 4, p1),
    other(recent, 'adjustment', -3),
    spend(justBefore, 'storyboard', 'voiceover', -13, p1),
    spend(lastMonth, 'workbench', 'agent_turn', -6, p2),
    spend(lastMonth, 'workbench', 'agent_turn', -5, p2),
    other(lastMonth, 'adjustment', 11),
    spend(older, 'workbench', 'generate_shots', -9, p1),
  ])
  expect(ledgerError).toBeNull()

  const usage = (createdAt: string, status: string, cost: number | null, projectId: string | null, blocked = false) => ({
    user_id: userId,
    project_id: projectId,
    step: 'workbench',
    operation: 'agent_turn',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status,
    estimated_cost: cost,
    quoted_cost: cost,
    raw_usage: blocked ? { blocked: true } : null,
    created_at: createdAt,
  })
  const { error: usageError } = await admin.from('usage').insert([
    usage(recent, 'succeeded', 0.1, p1),
    usage(recent, 'succeeded', 0.2, p1),
    usage(recent, 'failed', 0.123456, p2),
    usage(recent, 'pending', 0.9, p2),
    usage(recent, 'succeeded', 0, null, true),
    usage(boundary, 'succeeded', 0.000001, null),
    usage(justBefore, 'succeeded', 0.5, p1),
    usage(lastMonth, 'failed', 0.33, p2),
    usage(older, 'succeeded', 1.25, p1),
  ])
  expect(usageError).toBeNull()

  const { data: meta } = await admin
    .from('projects')
    .select('id, title, source_text, video_type, duration_target')
    .in('id', [p1, p2])
  return meta as ProjectMeta[]
}

test.describe('credit figures computed in Postgres equal the old row-by-row figures', () => {
  test('balance, rail pair and every /credits breakdown match for all three periods; views widen no access', async () => {
    const { user, session } = await createTestSession()
    try {
      const projects = await seed(user.id)
      const client = (await userClient(session)) as SupabaseClient<Database>

      // Balance tile and the "has ledger rows" signal the layout's grant check reads.
      const allRows = await oldGetLedgerRows(client, user.id, 'all_time')
      const balance = await readBalance(client, user.id)
      expect(balance.balance).toBe(oldSumBalance(allRows))
      expect(balance.entries).toBe(allRows.length)
      expect(formatCredits(balance.balance)).toBe(formatCredits(oldSumBalance(allRows)))

      // Every /credits aggregation, per period - identical structure, order and numbers.
      for (const period of PERIODS) {
        const oldRows = await oldGetLedgerRows(client, user.id, period)
        const groups = await readLedgerGroups(client, user.id, period)
        expect(oldRows.length, period).toBeGreaterThan(groups.filter((g) => g.kind === 'spend').length - 1)
        expect(oldAggregateCreditsPeriod(oldRows, projects).spentThisPeriod, period).toBeGreaterThan(0)
        expect(aggregateCreditsPeriod(groups, projects), period).toEqual(oldAggregateCreditsPeriod(oldRows, projects))
      }

      // The rail pair.
      const rail = await readRailFigures(client, user.id)
      const oldSpend = aggregateUsage(await oldGetUsageRows(client, user.id, 'this_month'), []).settledTotal
      const oldCredits = oldAggregateCreditsPeriod(await oldGetLedgerRows(client, user.id, 'this_month'), []).spentThisPeriod
      expect(oldSpend).toBeGreaterThan(0)
      expect(rail.creditsSpentThisMonth).toBe(oldCredits)
      expect(formatCredits(rail.creditsSpentThisMonth)).toBe(formatCredits(oldCredits))
      // numeric is summed exactly by Postgres, float by the old JS: equal as displayed,
      // and within float noise as a raw value.
      expect(formatCost(rail.spendThisMonth)).toBe(formatCost(oldSpend))
      expect(Math.abs(rail.spendThisMonth - oldSpend)).toBeLessThan(1e-9)

      // Another signed-in user reads none of this user's rows through any view.
      const other = await userClient(secondary.session)
      for (const view of ['credit_balances', 'credit_ledger_monthly', 'usage_monthly_spend'] as const) {
        const { data, error } = await other.from(view).select('user_id').eq('user_id', user.id)
        expect(error, view).toBeNull()
        expect(data, view).toEqual([])
      }

      // anon has no privilege on the views at all.
      const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
      for (const view of ['credit_balances', 'credit_ledger_monthly', 'usage_monthly_spend'] as const) {
        const { error } = await anon.from(view).select('user_id').limit(1)
        expect(error?.code, view).toBe('42501')
      }
    } finally {
      await admin.from('usage').delete().eq('user_id', user.id)
      await admin.from('credit_ledger').delete().eq('user_id', user.id)
      await deleteTestUser(user.id)
    }
  })
})
