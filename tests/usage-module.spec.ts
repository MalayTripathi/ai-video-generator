import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { reserveUsage, settleUsage, quoteClaudeCall, assertWithinAllowance, AllowanceExceededError } from '../src/lib/usage'

async function insertProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({ user_id: userId, title: 'Untitled project', current_step: 'workbench' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function insertGeneration(projectId: string) {
  const { data, error } = await admin
    .from('generations')
    .insert({ project_id: projectId, step: 'workbench', operation: 'generate_shots', shot_id: null, state: 'generating' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

const MODEL = 'claude-haiku-4-5-20251001'

test.describe('reserveUsage / settleUsage', () => {
  test('reserveUsage throws when the insert violates a CHECK constraint, and writes no row', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const generationId = await insertGeneration(projectId)
      const { quotedBreakdown } = quoteClaudeCall({ model: MODEL, estimatedInputTokens: 10, maxTokens: 100 })

      await expect(
        reserveUsage({
          supabase: admin,
          userId: user.id,
          projectId,
          generationId,
          shotId: null,
          // Bypasses TS to force the `usage` table's step CHECK constraint to fail -
          // the deterministic way to exercise "insert fails -> throw" without a
          // production-only DI seam.
          step: 'not_a_real_step' as never,
          operation: 'generate_shots',
          provider: 'anthropic',
          model: MODEL,
          quotedCost: 0.01,
          quotedBreakdown,
        })
      ).rejects.toThrow()

      const { data: rows } = await admin.from('usage').select('id').eq('project_id', projectId)
      expect(rows!.length).toBe(0)
    }
  })

  test('settleUsage does not throw when its UPDATE fails, and the row stays pending', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const generationId = await insertGeneration(projectId)
      const { estimatedCost, quotedBreakdown } = quoteClaudeCall({ model: MODEL, estimatedInputTokens: 10, maxTokens: 100 })

      const { usageId } = await reserveUsage({
        supabase: admin,
        userId: user.id,
        projectId,
        generationId,
        shotId: null,
        step: 'workbench',
        operation: 'generate_shots',
        provider: 'anthropic',
        model: MODEL,
        quotedCost: estimatedCost,
        quotedBreakdown,
      })

      const { data: before } = await admin.from('usage').select('status').eq('id', usageId).single()
      expect(before!.status).toBe('pending')

      await expect(
        settleUsage({
          supabase: admin,
          usageId,
          provider: 'anthropic',
          model: MODEL,
          // Bypasses TS to force the `usage` table's status CHECK constraint to fail
          // on the UPDATE.
          status: 'not_a_real_status' as never,
          breakdown: { input_tokens: 10, output_tokens: 10 },
        })
      ).resolves.toBeUndefined()

      const { data: after } = await admin.from('usage').select('status').eq('id', usageId).single()
      expect(after!.status).toBe('pending')
    }
  })

  test('reserveUsage writes quoted_cost equal to estimated_cost', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const generationId = await insertGeneration(projectId)
      const { estimatedCost, quotedBreakdown } = quoteClaudeCall({ model: MODEL, estimatedInputTokens: 10, maxTokens: 100 })

      const { usageId } = await reserveUsage({
        supabase: admin,
        userId: user.id,
        projectId,
        generationId,
        shotId: null,
        step: 'workbench',
        operation: 'generate_shots',
        provider: 'anthropic',
        model: MODEL,
        quotedCost: estimatedCost,
        quotedBreakdown,
      })

      const { data } = await admin.from('usage').select('estimated_cost, quoted_cost').eq('id', usageId).single()
      // Compared against the DB-read estimated_cost, not the in-memory `estimatedCost`
      // variable - numeric(12,6) rounds the raw JS float on write, so a value read back
      // is the only thing guaranteed byte-identical to another value read back.
      expect(data!.quoted_cost).toBe(data!.estimated_cost)
    }
  })

  test('settleUsage changes estimated_cost and leaves quoted_cost byte-identical', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const generationId = await insertGeneration(projectId)
      // A deliberately small quote (few estimated input tokens, small max_tokens) paired
      // with a much larger real breakdown at settle, so measured cost is guaranteed to
      // differ from the quote.
      const { estimatedCost: quotedCost, quotedBreakdown } = quoteClaudeCall({
        model: MODEL,
        estimatedInputTokens: 10,
        maxTokens: 50,
      })

      const { usageId } = await reserveUsage({
        supabase: admin,
        userId: user.id,
        projectId,
        generationId,
        shotId: null,
        step: 'workbench',
        operation: 'generate_shots',
        provider: 'anthropic',
        model: MODEL,
        quotedCost,
        quotedBreakdown,
      })

      // Read back what reserve actually persisted - `numeric(12,6)` rounds the raw JS
      // float on write, so comparing against the in-memory `quotedCost` variable would
      // be comparing two different roundings of the same number. The DB-read value
      // right after reserve is the true baseline "byte-identical" is measured against.
      const { data: afterReserve } = await admin
        .from('usage')
        .select('estimated_cost, quoted_cost')
        .eq('id', usageId)
        .single()

      await settleUsage({
        supabase: admin,
        usageId,
        provider: 'anthropic',
        model: MODEL,
        status: 'succeeded',
        breakdown: { input_tokens: 50_000, output_tokens: 50_000 },
      })

      const { data: afterSettle } = await admin
        .from('usage')
        .select('estimated_cost, quoted_cost')
        .eq('id', usageId)
        .single()

      expect(afterSettle!.quoted_cost).toBe(afterReserve!.quoted_cost)
      expect(afterSettle!.estimated_cost).not.toBe(afterReserve!.estimated_cost)
    }
  })

  test("a row settled 'failed' with no usage data keeps estimated_cost equal to quoted_cost", async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const generationId = await insertGeneration(projectId)
      const { estimatedCost: quotedCost, quotedBreakdown } = quoteClaudeCall({
        model: MODEL,
        estimatedInputTokens: 10,
        maxTokens: 100,
      })

      const { usageId } = await reserveUsage({
        supabase: admin,
        userId: user.id,
        projectId,
        generationId,
        shotId: null,
        step: 'workbench',
        operation: 'generate_shots',
        provider: 'anthropic',
        model: MODEL,
        quotedCost,
        quotedBreakdown,
      })

      // The fully-unmeasured throw path: no breakdown at all.
      await settleUsage({
        supabase: admin,
        usageId,
        provider: 'anthropic',
        model: MODEL,
        status: 'failed',
        error: 'simulated network failure before any response',
      })

      // Compared against each other, not the in-memory `quotedCost` variable - see the
      // note in the "reserve writes quoted_cost equal to estimated_cost" test above.
      const { data } = await admin.from('usage').select('estimated_cost, quoted_cost').eq('id', usageId).single()
      expect(data!.estimated_cost).toBe(data!.quoted_cost)
    }
  })
})

test.describe('assertWithinAllowance', () => {
  test('enabled: a quote that would exceed the ceiling is refused, and no new usage row is written', async () => {
    const { user } = await createTestSession()
    const originalEnabled = process.env.SPEND_CAP_ENABLED
    const originalCeiling = process.env.SPEND_CAP_MONTHLY_USD
    try {
      const projectId = await insertProject(user.id)

      // Fixture: a prior settled row this month, most of the way to a $1 ceiling.
      const { error: fixtureError } = await admin.from('usage').insert({
        user_id: user.id,
        project_id: projectId,
        step: 'workbench',
        operation: 'generate_shots',
        provider: 'anthropic',
        model: MODEL,
        status: 'succeeded',
        estimated_cost: 0.9,
      })
      expect(fixtureError).toBeNull()

      process.env.SPEND_CAP_ENABLED = '1'
      process.env.SPEND_CAP_MONTHLY_USD = '1'

      await expect(
        assertWithinAllowance({ supabase: admin, userId: user.id, quotedCost: 0.5 })
      ).rejects.toBeInstanceOf(AllowanceExceededError)

      const { data: rows } = await admin.from('usage').select('id').eq('user_id', user.id)
      expect(rows!.length).toBe(1) // only the fixture row - the refused call wrote nothing
    } finally {
      if (originalEnabled === undefined) delete process.env.SPEND_CAP_ENABLED
      else process.env.SPEND_CAP_ENABLED = originalEnabled
      if (originalCeiling === undefined) delete process.env.SPEND_CAP_MONTHLY_USD
      else process.env.SPEND_CAP_MONTHLY_USD = originalCeiling
      await deleteTestUser(user.id)
    }
  })

  test('enabled: a quote within the ceiling is allowed', async () => {
    // Shares the persistent primary user - safe here because this test only checks
    // that the call resolves, never an exact row count or sum (unlike the "exceeds the
    // ceiling" test above, which needs its own fresh user for exactly that reason).
    const user = primary.user
    const originalEnabled = process.env.SPEND_CAP_ENABLED
    const originalCeiling = process.env.SPEND_CAP_MONTHLY_USD
    try {
      process.env.SPEND_CAP_ENABLED = '1'
      process.env.SPEND_CAP_MONTHLY_USD = '100'

      await expect(
        assertWithinAllowance({ supabase: admin, userId: user.id, quotedCost: 0.01 })
      ).resolves.toBeUndefined()
    } finally {
      if (originalEnabled === undefined) delete process.env.SPEND_CAP_ENABLED
      else process.env.SPEND_CAP_ENABLED = originalEnabled
      if (originalCeiling === undefined) delete process.env.SPEND_CAP_MONTHLY_USD
      else process.env.SPEND_CAP_MONTHLY_USD = originalCeiling
    }
  })

  test('disabled (default): performs no query at all', async () => {
    const originalEnabled = process.env.SPEND_CAP_ENABLED
    try {
      delete process.env.SPEND_CAP_ENABLED

      const throwingSupabase = {
        from() {
          throw new Error('assertWithinAllowance queried while disabled')
        },
      }

      await expect(
        assertWithinAllowance({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: throwingSupabase as any,
          userId: 'irrelevant-user-id',
          quotedCost: 999_999,
        })
      ).resolves.toBeUndefined()
    } finally {
      if (originalEnabled === undefined) delete process.env.SPEND_CAP_ENABLED
      else process.env.SPEND_CAP_ENABLED = originalEnabled
    }
  })
})
