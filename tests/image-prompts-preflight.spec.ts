import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { checkImagePromptsAffordabilityForUser } from '../src/app/(app)/projects/[id]/image_prompts/actions'
import { creditsFor } from '../src/lib/config/credits'

async function seed(count: number) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({ user_id: primary.user.id, title: 'Preflight test', current_step: 'image_prompts', furthest_step: 3 })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  const { data: shots, error: shotsError } = await admin
    .from('shots')
    .insert(
      Array.from({ length: count }, (_, i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: `pf${i}${Math.random().toString(36).slice(2, 4)}`,
        voice_over: 'Voice over.',
      }))
    )
    .select('id, shot_key')
  expect(shotsError).toBeNull()
  return { projectId, shots: shots! }
}

const balanceOf = (n: number) => async () => n

test.describe('image prompts affordability preflight', () => {
  test('refuses with the route-consistent figures when the balance is short', async () => {
    const { projectId, shots } = await seed(3)
    const required = creditsFor({ step: 'image_prompts', operation: 'write_image_prompts', quantity: 3 })

    const result = await checkImagePromptsAffordabilityForUser(
      admin,
      primary.user.id,
      projectId,
      shots.map((s) => s.id),
      balanceOf(required - 1)
    )
    expect(result).toEqual({ ok: false, reason: 'insufficient', requiredCredits: required, balanceCredits: required - 1 })
  })

  test('allows exactly enough, and prices only the requested scope', async () => {
    const { projectId, shots } = await seed(3)
    const oneShot = creditsFor({ step: 'image_prompts', operation: 'write_image_prompts', quantity: 1 })

    expect(
      await checkImagePromptsAffordabilityForUser(admin, primary.user.id, projectId, [shots[0].id], balanceOf(oneShot))
    ).toEqual({ ok: true })
    expect(
      (await checkImagePromptsAffordabilityForUser(admin, primary.user.id, projectId, shots.map((s) => s.id), balanceOf(oneShot))).ok
    ).toBe(false)
  })

  test('never refuses a request that would replay a stored payload for free', async () => {
    const { projectId, shots } = await seed(1)
    const { error } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: 'failed',
      payload: { prompts: [{ shot_key: shots[0].shot_key, image_prompt: 'x'.repeat(80) }] } as never,
    })
    expect(error).toBeNull()

    expect(
      await checkImagePromptsAffordabilityForUser(admin, primary.user.id, projectId, [shots[0].id], balanceOf(0))
    ).toEqual({ ok: true })
  })

  test('is not a claim: the check writes no generations row', async () => {
    const { projectId, shots } = await seed(1)
    await checkImagePromptsAffordabilityForUser(admin, primary.user.id, projectId, [shots[0].id], balanceOf(0))
    const { data } = await admin.from('generations').select('id').eq('project_id', projectId)
    expect(data).toEqual([])
  })

  test("reports an error - never a balance figure - for another user's project or a shot outside it", async () => {
    const { projectId, shots } = await seed(1)
    const other = await seed(1)

    expect(
      await checkImagePromptsAffordabilityForUser(admin, secondary.user.id, projectId, [shots[0].id], balanceOf(0))
    ).toEqual({ ok: false, reason: 'error' })
    expect(
      await checkImagePromptsAffordabilityForUser(admin, primary.user.id, projectId, [other.shots[0].id], balanceOf(0))
    ).toEqual({ ok: false, reason: 'error' })
  })
})
