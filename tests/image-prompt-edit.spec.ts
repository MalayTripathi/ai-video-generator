import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { updateShotImagePromptForUser } from '../src/app/(app)/projects/[id]/image_prompts/actions'

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Image prompt edit test',
      current_step: 'image_prompts',
      furthest_step: 3,
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: 0,
      shot_key: `t${Math.random().toString(36).slice(2, 6)}`,
      voice_over: 'Placeholder voice-over.',
      image_prompt: 'The persisted prompt.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function readShot(shotId: string) {
  const { data, error } = await admin
    .from('shots')
    .select('image_prompt, image_prompt_stale, image_prompt_edited, video_prompt_stale')
    .eq('id', shotId)
    .single()
  expect(error).toBeNull()
  return data!
}

test.describe('updateShotImagePromptForUser', () => {
  test('a real edit saves the text and marks it edited', async () => {
    const shotId = await seedShot(await seedProject())

    const result = await updateShotImagePromptForUser(admin, shotId, '  My own wording.  ', primary.user.id)
    expect(result).toEqual({ field: 'image_prompt', success: true })

    const row = await readShot(shotId)
    expect(row.image_prompt).toBe('My own wording.')
    expect(row.image_prompt_edited).toBe(true)
  })

  test('an edit never touches staleness: a stale prompt stays stale, a fresh one stays fresh', async () => {
    const projectId = await seedProject()
    const staleShot = await seedShot(projectId, { image_prompt_stale: true, order_index: 0 })
    const freshShot = await seedShot(projectId, { image_prompt_stale: false, order_index: 1 })

    await updateShotImagePromptForUser(admin, staleShot, 'Edited once.', primary.user.id)
    await updateShotImagePromptForUser(admin, freshShot, 'Edited twice.', primary.user.id)

    expect((await readShot(staleShot)).image_prompt_stale).toBe(true)
    const fresh = await readShot(freshShot)
    expect(fresh.image_prompt_stale).toBe(false)
    expect(fresh.video_prompt_stale).toBe(false)
  })

  test('a no-op edit performs no write and does not mark the prompt edited', async () => {
    const shotId = await seedShot(await seedProject())

    const same = await updateShotImagePromptForUser(admin, shotId, 'The persisted prompt.', primary.user.id)
    const padded = await updateShotImagePromptForUser(admin, shotId, '  The persisted prompt. \n', primary.user.id)
    expect(same).toEqual({ field: 'image_prompt', success: true, unchanged: true })
    expect(padded).toEqual({ field: 'image_prompt', success: true, unchanged: true })

    expect((await readShot(shotId)).image_prompt_edited).toBe(false)
  })

  test('a blank prompt is rejected and the paid prompt is never nulled', async () => {
    const shotId = await seedShot(await seedProject())

    const result = await updateShotImagePromptForUser(admin, shotId, '   ', primary.user.id)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid')

    const row = await readShot(shotId)
    expect(row.image_prompt).toBe('The persisted prompt.')
    expect(row.image_prompt_edited).toBe(false)
  })

  test("another user's shot is indistinguishable from a missing one", async () => {
    const shotId = await seedShot(await seedProject())

    const result = await updateShotImagePromptForUser(admin, shotId, 'Not yours.', secondary.user.id)
    expect(result).toEqual({ field: 'image_prompt', success: false, error: 'Shot not found' })
    expect((await readShot(shotId)).image_prompt).toBe('The persisted prompt.')
  })

  test('is refused once later steps have started', async () => {
    const shotId = await seedShot(await seedProject({ furthest_step: 4 }))

    const result = await updateShotImagePromptForUser(admin, shotId, 'Too late.', primary.user.id)
    expect(result.success).toBe(false)
    expect((await readShot(shotId)).image_prompt).toBe('The persisted prompt.')
  })

  test('saving is not advancing: current_step and furthest_step are untouched', async () => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)

    await updateShotImagePromptForUser(admin, shotId, 'A real edit.', primary.user.id)

    const { data } = await admin.from('projects').select('current_step, furthest_step, status').eq('id', projectId).single()
    expect(data).toEqual({ current_step: 'image_prompts', furthest_step: 3, status: 'draft' })
  })
})
