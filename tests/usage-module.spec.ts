import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
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
    const { user } = await createTestSession()
    try {
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
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('settleUsage does not throw when its UPDATE fails, and the row stays pending', async () => {
    const { user } = await createTestSession()
    try {
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
    } finally {
      await deleteTestUser(user.id)
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
    const { user } = await createTestSession()
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
      await deleteTestUser(user.id)
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
