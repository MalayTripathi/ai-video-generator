import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Constraint, unique-index, and RLS coverage for credit_ledger's schema - a
// different concern from tests/enums-drift.spec.ts (which only covers the
// STEPS/OPERATIONS TS-array-vs-CHECK-constraint pairings), so this lives in its own
// file. No application code reads or writes this table yet (see CLAUDE.md/the
// C-credits-2 task) - every insert below goes through `admin` (service role,
// bypasses RLS) except the RLS tests, which build a client scoped to a fixed user's
// own real session token via setSession, same pattern as usage-page.spec.ts's RLS
// test.

function validSpend(overrides: Record<string, unknown> = {}) {
  const attemptId = crypto.randomUUID()
  return {
    user_id: primary.user.id,
    kind: 'spend',
    delta: -1,
    step: 'workbench',
    operation: 'agent_turn',
    attempt_id: attemptId,
    pricing_mode: 'fixed',
    dedupe_key: `agent_turn:${attemptId}`,
    price_version: 'test',
    ...overrides,
  }
}

function validAdjustment(overrides: Record<string, unknown> = {}) {
  return {
    user_id: primary.user.id,
    kind: 'adjustment',
    delta: 5,
    dedupe_key: `adjustment-test:${crypto.randomUUID()}`,
    price_version: 'test',
    ...overrides,
  }
}

test.describe('credit_ledger constraints', () => {
  test('rejects delta = 0', async () => {
    const { error } = await admin.from('credit_ledger').insert(validAdjustment({ delta: 0 }))
    expect(error).not.toBeNull()
  })

  test('rejects a spend row with a non-negative delta', async () => {
    const { error } = await admin.from('credit_ledger').insert(validSpend({ delta: 1 }))
    expect(error).not.toBeNull()
  })

  test('rejects a signup_grant or refund row with a non-positive delta', async () => {
    const { error: grantError } = await admin.from('credit_ledger').insert({
      user_id: primary.user.id,
      kind: 'signup_grant',
      delta: -1,
      dedupe_key: `signup-grant-negative-test:${crypto.randomUUID()}`,
      price_version: 'test',
    })
    expect(grantError).not.toBeNull()

    const { error: refundError } = await admin.from('credit_ledger').insert({
      user_id: primary.user.id,
      kind: 'refund',
      delta: -1,
      dedupe_key: `refund-negative-test:${crypto.randomUUID()}`,
      price_version: 'test',
    })
    expect(refundError).not.toBeNull()
  })

  test('rejects a spend row missing step, operation, attempt_id, or pricing_mode', async () => {
    const { error: noStep } = await admin.from('credit_ledger').insert(validSpend({ step: null }))
    expect(noStep).not.toBeNull()

    const { error: noOperation } = await admin.from('credit_ledger').insert(validSpend({ operation: null }))
    expect(noOperation).not.toBeNull()

    const { error: noAttemptId } = await admin.from('credit_ledger').insert(validSpend({ attempt_id: null }))
    expect(noAttemptId).not.toBeNull()

    const { error: noPricingMode } = await admin.from('credit_ledger').insert(validSpend({ pricing_mode: null }))
    expect(noPricingMode).not.toBeNull()
  })

  test('rejects a non-refund row that sets refunds_ledger_id', async () => {
    const { data: target, error: targetError } = await admin
      .from('credit_ledger')
      .insert(validAdjustment())
      .select('id')
      .single()
    expect(targetError).toBeNull()

    const { error } = await admin.from('credit_ledger').insert(validAdjustment({ refunds_ledger_id: target!.id }))
    expect(error).not.toBeNull()
  })
})

test.describe('credit_ledger unique dedupe_key index', () => {
  test('rejects a duplicate (user_id, dedupe_key) and permits the same dedupe_key for a different user', async () => {
    const dedupeKey = `dupe-test:${crypto.randomUUID()}`

    const { error: firstError } = await admin.from('credit_ledger').insert(validAdjustment({ dedupe_key: dedupeKey }))
    expect(firstError).toBeNull()

    const { error: dupeError } = await admin.from('credit_ledger').insert(validAdjustment({ dedupe_key: dedupeKey }))
    expect(dupeError?.code).toBe('23505')

    const { error: otherUserError } = await admin
      .from('credit_ledger')
      .insert(validAdjustment({ user_id: secondary.user.id, dedupe_key: dedupeKey }))
    expect(otherUserError).toBeNull()
  })
})

test.describe('credit_ledger RLS', () => {
  test('an authenticated client sees only its own rows', async () => {
    const { error: primaryError } = await admin
      .from('credit_ledger')
      .insert(validAdjustment({ dedupe_key: `rls-select-primary:${crypto.randomUUID()}` }))
    expect(primaryError).toBeNull()

    const { error: secondaryError } = await admin
      .from('credit_ledger')
      .insert(validAdjustment({ user_id: secondary.user.id, dedupe_key: `rls-select-secondary:${crypto.randomUUID()}` }))
    expect(secondaryError).toBeNull()

    const scopedToPrimary = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error: setSessionError } = await scopedToPrimary.auth.setSession(primary.session)
    expect(setSessionError).toBeNull()

    const { data: rows, error: selectError } = await scopedToPrimary.from('credit_ledger').select('user_id')
    expect(selectError).toBeNull()
    expect(rows!.length).toBeGreaterThan(0)
    expect(rows!.every((r) => r.user_id === primary.user.id)).toBe(true)
  })

  test('an authenticated client cannot insert, update, or delete', async () => {
    const scopedToPrimary = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error: setSessionError } = await scopedToPrimary.auth.setSession(primary.session)
    expect(setSessionError).toBeNull()

    // INSERT has no policy at all, so Postgres raises a real RLS-violation error
    // (42501) at write time - a thrown error, detected here by presence, never by
    // matching its message.
    const { error: insertError } = await scopedToPrimary
      .from('credit_ledger')
      .insert(validAdjustment({ dedupe_key: `rls-write-denial:${crypto.randomUUID()}` }))
    expect(insertError).not.toBeNull()

    const { data: seeded, error: seedError } = await admin
      .from('credit_ledger')
      .insert(validAdjustment({ dedupe_key: `rls-write-denial-target:${crypto.randomUUID()}` }))
      .select('id, delta')
      .single()
    expect(seedError).toBeNull()

    // UPDATE/DELETE behave differently under RLS: with no matching policy, the row is
    // simply invisible to the operation rather than triggering a thrown error - both
    // report zero rows affected (empty `data`, `error: null`). Detected by the
    // resulting row count plus re-reading the row via `admin` afterward, never by a
    // message string.
    const { data: updateResult, error: updateError } = await scopedToPrimary
      .from('credit_ledger')
      .update({ delta: 999 })
      .eq('id', seeded!.id)
      .select('id')
    expect(updateError).toBeNull()
    expect(updateResult!.length).toBe(0)

    const { data: afterUpdate } = await admin.from('credit_ledger').select('delta').eq('id', seeded!.id).single()
    expect(afterUpdate!.delta).toBe(seeded!.delta)

    const { data: deleteResult, error: deleteError } = await scopedToPrimary
      .from('credit_ledger')
      .delete()
      .eq('id', seeded!.id)
      .select('id')
    expect(deleteError).toBeNull()
    expect(deleteResult!.length).toBe(0)

    const { data: afterDelete, error: afterDeleteError } = await admin
      .from('credit_ledger')
      .select('id')
      .eq('id', seeded!.id)
      .single()
    expect(afterDeleteError).toBeNull()
    expect(afterDelete!.id).toBe(seeded!.id)
  })
})

test.describe('credit_ledger valid rows per kind', () => {
  test('inserts successfully for every kind via the service role', async () => {
    const { error: signupError } = await admin.from('credit_ledger').insert({
      user_id: primary.user.id,
      kind: 'signup_grant',
      delta: 100,
      dedupe_key: `signup-grant-valid:${crypto.randomUUID()}`,
      price_version: 'test',
    })
    expect(signupError).toBeNull()

    const { data: spendRow, error: spendError } = await admin
      .from('credit_ledger')
      .insert(validSpend())
      .select('id')
      .single()
    expect(spendError).toBeNull()

    const { error: refundError } = await admin.from('credit_ledger').insert({
      user_id: primary.user.id,
      kind: 'refund',
      delta: 1,
      dedupe_key: `refund-valid:${crypto.randomUUID()}`,
      price_version: 'test',
      refunds_ledger_id: spendRow!.id,
    })
    expect(refundError).toBeNull()

    const { error: adjustmentError } = await admin.from('credit_ledger').insert(validAdjustment())
    expect(adjustmentError).toBeNull()
  })
})
