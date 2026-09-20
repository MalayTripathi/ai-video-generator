import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { stepIndex } from '../src/lib/config/pipeline'
import { SIGNUP_GRANT_CREDITS, PRICE_TABLE } from '../src/lib/config/credits'
import { runAdvanceToStoryboard } from '../src/app/api/projects/[id]/storyboard/advance/logic'
import type { getBalance as getBalanceType } from '../src/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '../src/lib/credits/signup-grant'

// The per-shot price is read from the config, never restated here: a re-priced storyboard
// must not turn these tests red for the wrong reason.
const PER_SHOT = PRICE_TABLE.storyboard!.generate_image!.credits

// Same fakes as image-prompts-advance.spec.ts, for the same reasons: getBalance needs a
// request context a bare test process lacks, and ensureSignupGrant is service-role.
const realGetBalance: typeof getBalanceType = async (userId) => {
  const { data, error } = await admin.from('credit_ledger').select('delta').eq('user_id', userId)
  if (error) {
    throw new Error(`getBalance failed: ${error.message}`)
  }
  return data.reduce((sum, row) => sum + row.delta, 0)
}

const realEnsureSignupGrant: typeof ensureSignupGrantType = async (userId) => {
  const { data: existing } = await admin
    .from('credit_ledger')
    .select('id')
    .eq('user_id', userId)
    .eq('dedupe_key', `signup_grant:${userId}`)
    .maybeSingle()
  if (existing) return

  await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'signup_grant',
    delta: SIGNUP_GRANT_CREDITS,
    dedupe_key: `signup_grant:${userId}`,
    price_version: 'test',
  })
}

// A user who never received a signup grant reads back a balance of 0 - the cleanest way to
// force the insufficient-balance branch.
const noopEnsureSignupGrant: typeof ensureSignupGrantType = async () => {}

async function seedProject(userId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Storyboard advance test',
      source_text: 'A short film for storyboard-advance tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'image_prompts',
      furthest_step: stepIndex('image_prompts'),
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShots(projectId: string, count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: `t${String(i).padStart(4, '0')}`,
    voice_over: 'Placeholder voice-over.',
  }))
  const { error } = await admin.from('shots').insert(rows)
  expect(error).toBeNull()
}

async function readProject(projectId: string) {
  const { data, error } = await admin
    .from('projects')
    .select('current_step, furthest_step')
    .eq('id', projectId)
    .single()
  expect(error).toBeNull()
  return data!
}

async function ledgerRowsFor(projectId: string) {
  const { count, error } = await admin
    .from('credit_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
  expect(error).toBeNull()
  return count
}

test.describe('runAdvanceToStoryboard', () => {
  test('sufficient balance advances the step and returns the required credits', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await seedProject(user.id)
      await seedShots(projectId, 3)

      const result = await runAdvanceToStoryboard({
        supabase: admin,
        projectId,
        userId: user.id,
        getBalance: realGetBalance,
        ensureSignupGrant: realEnsureSignupGrant,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.data.requiredCredits).toBe(3 * PER_SHOT)

      const project = await readProject(projectId)
      expect(project.current_step).toBe('storyboard')
      expect(project.furthest_step).toBe(stepIndex('storyboard'))
      // Pre-flight only: the real spend is recorded by the storyboard generation route.
      expect(await ledgerRowsFor(projectId)).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('insufficient balance returns 402, reports the numbers, and never calls advanceStep', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await seedProject(user.id)
      await seedShots(projectId, 1)

      const result = await runAdvanceToStoryboard({
        supabase: admin,
        projectId,
        userId: user.id,
        getBalance: realGetBalance,
        ensureSignupGrant: noopEnsureSignupGrant,
      })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.status).toBe(402)
      if (result.status === 402) {
        expect(result.requiredCredits).toBe(PER_SHOT)
        expect(result.balanceCredits).toBe(0)
      }

      // Load-bearing: the row must be provably unchanged - proves advanceStep was never
      // called on the insufficient-balance path.
      const project = await readProject(projectId)
      expect(project.current_step).toBe('image_prompts')
      expect(project.furthest_step).toBe(stepIndex('image_prompts'))
      expect(await ledgerRowsFor(projectId)).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('an already-advanced project is never refused on balance: it owns the step, and getting there spends nothing', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await seedProject(user.id, { furthest_step: stepIndex('storyboard') })
      await seedShots(projectId, 3)

      // No grant, so the balance reads 0 - the same call for a project still at Image
      // Prompts is the 402 above.
      const result = await runAdvanceToStoryboard({
        supabase: admin,
        projectId,
        userId: user.id,
        getBalance: realGetBalance,
        ensureSignupGrant: noopEnsureSignupGrant,
      })

      expect(result.ok).toBe(true)
      const project = await readProject(projectId)
      expect(project.current_step).toBe('storyboard')
      expect(project.furthest_step).toBe(stepIndex('storyboard'))
      expect(await ledgerRowsFor(projectId)).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test("requiredCredits scales with the project's persisted shot count", async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await seedProject(user.id)
      await seedShots(projectId, 8)

      const result = await runAdvanceToStoryboard({
        supabase: admin,
        projectId,
        userId: user.id,
        getBalance: realGetBalance,
        ensureSignupGrant: realEnsureSignupGrant,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.data.requiredCredits).toBe(8 * PER_SHOT)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('missing or unowned project returns 404', async () => {
    const { user } = await createTestSession()
    try {
      const result = await runAdvanceToStoryboard({
        supabase: admin,
        projectId: '00000000-0000-0000-0000-000000000000',
        userId: user.id,
        getBalance: realGetBalance,
        ensureSignupGrant: realEnsureSignupGrant,
      })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.status).toBe(404)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
