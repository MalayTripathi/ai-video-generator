import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

let seq = 0
function nextShotIdentity() {
  seq++
  return { orderIndex: seq, shotKey: `dl${String(seq).padStart(3, '0')}` }
}

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Shot deletion test',
      source_text: 'A short film for shot-deletion tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
      video_model: 'mochi-1',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = data!.id as string

  const { error: generationError } = await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    state: 'succeeded',
  })
  expect(generationError).toBeNull()

  return projectId
}

async function seedShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const { orderIndex, shotKey } = nextShotIdentity()
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: orderIndex,
      shot_key: shotKey,
      voice_over: 'Original voiceover text.',
      visual_description: 'Original visual description.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedUsageRow(overrides: Record<string, unknown>) {
  const { error } = await admin.from('usage').insert({
    user_id: primary.user.id,
    model: 'test-model',
    provider: 'anthropic',
    status: 'succeeded',
    ...overrides,
  })
  expect(error).toBeNull()
}

async function readShot(shotId: string) {
  const { data } = await admin.from('shots').select('*').eq('id', shotId).single()
  return data
}

async function readProject(projectId: string) {
  const { data } = await admin.from('projects').select('*').eq('id', projectId).single()
  return data
}

async function readShots(projectId: string) {
  const { data } = await admin
    .from('shots')
    .select('*')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })
  return data ?? []
}

// Clicking the collapsed card itself expands it (see shot-editing.spec.ts).
async function expandCard(page: Page, index = 0) {
  await page.getByTestId('shot-card').nth(index).click()
}

test.describe('shot deletion', () => {
  test('the bin trigger is visible on a collapsed card without hover or expanding it', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench`)

    await expect(page.getByTestId('delete-shot-trigger')).toBeVisible()
  })

  test('confirmation names the shot and offers cancel/delete', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    const shotNumber = (await readShot(shotId))!.order_index + 1

    await page.goto(`/projects/${projectId}/workbench`)
    await page.getByTestId('delete-shot-trigger').click()

    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByText(`Delete shot ${shotNumber}?`)).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Delete shot' })).toBeVisible()
  })

  // The modal deliberately shows no spend figure (see docs/decisions.md) - this only
  // proves prior spend on the shot has no bearing on whether deletion is allowed.
  test('a shot with settled usage rows still deletes once confirmed - spend never blocks deletion', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    await seedUsageRow({
      project_id: projectId,
      shot_id: shotId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      estimated_cost: 0.42,
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await page.getByTestId('delete-shot-trigger').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete shot' }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => readShot(shotId)).toBeNull()
  })

  test('cancelling the confirmation deletes nothing', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench`)
    await page.getByTestId('delete-shot-trigger').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await readShot(shotId)).not.toBeNull()
  })

  test('deleting removes the shot, cascades its dialogue rows, re-sequences order_index, renumbers on screen, and sets voiceover_stale', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotA = await seedShot(projectId, { visual_description: 'First shot.' })
    const shotB = await seedShot(projectId, { visual_description: 'Second shot - about to be deleted.' })
    const shotC = await seedShot(projectId, { visual_description: 'Third shot.' })

    const { data: character, error: characterError } = await admin
      .from('elements')
      .insert({ project_id: projectId, name: 'Narrator', type: 'character' })
      .select('id')
      .single()
    expect(characterError).toBeNull()
    const { error: bindError } = await admin
      .from('shot_elements')
      .insert({ shot_id: shotB, element_id: character!.id })
    expect(bindError).toBeNull()
    const { error: dialogueError } = await admin.from('shot_dialogue').insert({
      project_id: projectId,
      shot_id: shotB,
      element_id: character!.id,
      line: 'A line that should disappear with its shot.',
      order_index: 0,
    })
    expect(dialogueError).toBeNull()

    const [beforeA, beforeB, beforeC] = await Promise.all([readShot(shotA), readShot(shotB), readShot(shotC)])
    const projectBefore = await readProject(projectId)
    expect(projectBefore?.voiceover_stale).toBe(false)

    await page.goto(`/projects/${projectId}/workbench`)
    // Shot B is the second card - expand it to use the expanded-state trigger. Scoped
    // to that card: every card renders its own delete trigger.
    await expandCard(page, 1)
    await page.getByTestId('shot-card').nth(1).getByTestId('delete-shot-trigger').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete shot' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await expect.poll(async () => readShots(projectId).then((rows) => rows.length)).toBe(2)

    const remaining = await readShots(projectId)
    expect(remaining.map((r) => r.id)).toEqual([shotA, shotC])
    // Contiguous, zero-based order_index.
    expect(remaining.map((r) => r.order_index)).toEqual([0, 1])
    // shot_key is stable and immutable on survivors.
    expect(remaining[0].shot_key).toBe(beforeA?.shot_key)
    expect(remaining[1].shot_key).toBe(beforeC?.shot_key)

    const { data: dialogueRows } = await admin.from('shot_dialogue').select('id').eq('shot_id', shotB)
    expect(dialogueRows ?? []).toHaveLength(0)

    const projectAfter = await readProject(projectId)
    expect(projectAfter?.voiceover_stale).toBe(true)

    // Display numbers renumber - the surviving second card now reads "Shot 2" and shows
    // shot C's content, not shot B's.
    await expect(page.getByTestId('shot-card').nth(1).getByText('Shot 2')).toBeVisible()
    await expect(page.getByTestId('shot-card').nth(1)).toContainText('Third shot.')
    await expect(page.getByTestId('shot-card')).toHaveCount(2)

    void beforeB // seeded only to prove the delete target existed; not asserted further
  })

  // The lock threshold (furthest_step >= stepIndex('storyboard')) is duplicated inline
  // in three places with no shared helper (see the comment above deleteShotForUser).
  // Asserting both sides of the boundary via stepIndex('storyboard') itself - never a
  // literal - is what makes this test (and its two siblings in agent-turn.spec.ts)
  // catch a future STEPS reorder: all three recompute the same way, so they can only
  // drift apart if one site stops calling stepIndex('storyboard') at all.
  test('deleteShotForUser succeeds exactly one step below the lock, and is refused exactly at it', async () => {
    const { deleteShotForUser } = await import('../src/app/(app)/projects/[id]/workbench/actions')

    const openProjectId = await seedProject({ furthest_step: stepIndex('storyboard') - 1 })
    const openShotId = await seedShot(openProjectId)
    const openResult = await deleteShotForUser(admin, openShotId, primary.user.id)
    expect(openResult.success).toBe(true)
    expect(await readShot(openShotId)).toBeNull()

    const projectId = await seedProject({ furthest_step: stepIndex('storyboard') })
    const shotId = await seedShot(projectId)
    const before = await readShot(shotId)

    const result = await deleteShotForUser(admin, shotId, primary.user.id)

    expect(result.success).toBe(false)
    const after = await readShot(shotId)
    expect(after).not.toBeNull()
    expect(after?.order_index).toBe(before?.order_index)
  })
})
