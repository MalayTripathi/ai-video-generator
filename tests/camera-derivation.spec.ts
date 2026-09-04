import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { runCameraDerivation } from '../src/app/api/projects/[id]/shots/[shotId]/camera/logic'
import { successMessage, throwingGateway } from './helpers/claude-fakes'
import { LiveCallsBlockedError, type ClaudeGateway } from '../src/lib/claude'

let seq = 0
function nextShotIdentity() {
  seq++
  return { orderIndex: seq, shotKey: `cd${String(seq).padStart(3, '0')}` }
}

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Camera derivation test',
      source_text: 'A short film for camera-derivation tests.',
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

async function readShot(shotId: string) {
  const { data } = await admin.from('shots').select('*').eq('id', shotId).single()
  return data
}

async function readProject(projectId: string) {
  const { data } = await admin.from('projects').select('*').eq('id', projectId).single()
  return data
}

// Clicking the collapsed card itself is the expand affordance (canvas: no dedicated
// "Expand" button - the whole card is role="button" with cursor:pointer).
async function expandFirstCard(page: Page) {
  await page.getByTestId('shot-card').first().click()
}

// The camera/dialogue-speaker selects are a from-scratch ARIA combobox+listbox (canvas
// section 10 - a native <select>'s open menu can't be restyled by CSS at all, so it had
// to be custom-built), not a native <select> - Playwright's .selectOption() only works
// on real form elements, so tests interact via role queries instead.
async function chooseOption(page: Page, comboboxName: string, optionName: string) {
  await page.getByRole('combobox', { name: comboboxName }).click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
}

async function countCameraUsageRows(projectId: string, shotId: string) {
  const { data } = await admin
    .from('usage')
    .select('id')
    .eq('project_id', projectId)
    .eq('shot_id', shotId)
    .eq('operation', 'derive_camera')
  return data?.length ?? 0
}

test.describe('camera field editing and re-derivation', () => {
  test('changing a camera dropdown sets that field origin to override and leaves the other two untouched', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      shot_size: 'wide',
      shot_size_origin: 'auto',
      camera_angle: 'eye_level',
      camera_angle_origin: 'auto',
      camera_movement: 'static',
      camera_movement_origin: 'auto',
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await chooseOption(page, 'Shot size', 'Close up')

    await expect.poll(async () => (await readShot(shotId))?.shot_size_origin).toBe('override')
    const shotRow = await readShot(shotId)
    expect(shotRow?.shot_size).toBe('close_up')
    expect(shotRow?.camera_angle_origin).toBe('auto')
    expect(shotRow?.camera_movement_origin).toBe('auto')
  })

  test('a camera edit sets image_prompt_stale and video_prompt_stale but leaves voiceover_stale alone', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { camera_angle: 'eye_level', camera_angle_origin: 'auto' })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await chooseOption(page, 'Camera angle', 'Low')

    await expect.poll(async () => (await readShot(shotId))?.camera_angle_origin).toBe('override')
    const shotRow = await readShot(shotId)
    expect(shotRow?.image_prompt_stale).toBe(true)
    expect(shotRow?.video_prompt_stale).toBe(true)

    const projectRow = await readProject(projectId)
    expect(projectRow?.voiceover_stale).toBe(false)
  })

  test('a camera edit leaves image_prompt and video_prompt non-null', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      camera_movement: 'static',
      camera_movement_origin: 'auto',
      image_prompt: 'an existing image prompt',
      video_prompt: 'an existing video prompt',
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await chooseOption(page, 'Camera movement', 'Handheld')

    await expect.poll(async () => (await readShot(shotId))?.camera_movement_origin).toBe('override')
    const shotRow = await readShot(shotId)
    expect(shotRow?.image_prompt).toBe('an existing image prompt')
    expect(shotRow?.video_prompt).toBe('an existing video prompt')
  })

  test('no re-derivation is issued when all three camera fields are already override', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      shot_size_origin: 'override',
      camera_angle_origin: 'override',
      camera_movement_origin: 'override',
    })

    let cameraRequests = 0
    await page.route('**/api/projects/*/shots/*/camera', (route) => {
      cameraRequests++
      void route.continue()
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const descriptionField = page.getByLabel('Visual description')
    await descriptionField.fill('A brand new description naming nothing in particular.')
    await descriptionField.blur()

    await expect
      .poll(async () => (await readShot(shotId))?.visual_description)
      .toBe('A brand new description naming nothing in particular.')
    // Give a wrongly-issued request a moment to land before asserting it didn't.
    await page.waitForTimeout(500)

    expect(cameraRequests).toBe(0)
    expect(await countCameraUsageRows(projectId, shotId)).toBe(0)
  })

  test('a visual_description blur with no change issues no re-derivation and writes no usage row', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { visual_description: 'Unchanged description.' })

    let cameraRequests = 0
    await page.route('**/api/projects/*/shots/*/camera', (route) => {
      cameraRequests++
      void route.continue()
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await page.getByLabel('Visual description').click()
    await page.getByLabel('Voiceover').click() // moves focus away without editing

    await page.waitForTimeout(500)

    expect(cameraRequests).toBe(0)
    expect(await countCameraUsageRows(projectId, shotId)).toBe(0)
  })

  test('"Revert to auto" sends only the reverted field and applies the result in place', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId, {
      visual_description: 'A low angle shot of the castle at night.',
      camera_angle: 'top_down',
      camera_angle_origin: 'override',
      shot_size_origin: 'auto',
      camera_movement_origin: 'auto',
    })

    let requestBody: unknown = null
    await page.route('**/api/projects/*/shots/*/camera', async (route) => {
      requestBody = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: { camera_angle: { value: 'low', origin: 'derived' } } }),
      })
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await page.getByRole('button', { name: 'Revert to auto' }).click()

    await expect.poll(() => requestBody).toEqual({ revertField: 'camera_angle' })
    await expect(page.getByRole('combobox', { name: 'Camera angle' })).toHaveAttribute('data-value', 'low')
    await expect(page.getByText('Derived from your description')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Revert to auto' })).toHaveCount(0)
  })

  test('rapid triggers for the same shot coalesce - at most one call runs while another is queued', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId, {
      visual_description: 'A shot with no explicit camera terms.',
      camera_angle: 'top_down',
      camera_angle_origin: 'override',
      camera_movement: 'handheld',
      camera_movement_origin: 'override',
      shot_size_origin: 'auto',
    })

    const seenBodies: unknown[] = []
    await page.route('**/api/projects/*/shots/*/camera', async (route) => {
      seenBodies.push(route.request().postDataJSON())
      await new Promise((resolve) => setTimeout(resolve, 300))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          updated: {
            camera_angle: { value: 'low', origin: 'auto' },
            camera_movement: { value: 'static', origin: 'auto' },
          },
        }),
      })
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    // Two independent triggers (different fields) fired back to back while the first is
    // still in flight - the second must coalesce into a queued slot and still run after
    // the first completes, never dropped and never issued as a third overlapping call.
    await page.getByRole('button', { name: 'Revert to auto' }).first().click()
    await page.getByRole('button', { name: 'Revert to auto' }).click()

    await expect.poll(() => seenBodies.length).toBe(2)
    await expect(page.getByRole('button', { name: 'Revert to auto' })).toHaveCount(0)
    expect(seenBodies).toContainEqual({ revertField: 'camera_angle' })
    expect(seenBodies).toContainEqual({ revertField: 'camera_movement' })
  })

  test('nothing in this task writes current_step or furthest_step', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { shot_size: 'wide', shot_size_origin: 'auto' })
    const before = await readProject(projectId)

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await chooseOption(page, 'Shot size', 'Close up')
    await expect.poll(async () => (await readShot(shotId))?.shot_size_origin).toBe('override')

    const after = await readProject(projectId)
    expect(after?.current_step).toBe(before?.current_step)
    expect(after?.furthest_step).toBe(before?.furthest_step)
  })

  test('write-back applies to auto/derived fields, and to an override field only when Claude reports derived', async () => {
    const user = primary.user
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      visual_description: 'A wide shot at dawn, panning slowly.',
      shot_size: 'medium',
      shot_size_origin: 'auto',
      camera_angle: 'top_down',
      camera_angle_origin: 'override',
      camera_movement: 'handheld',
      camera_movement_origin: 'override',
    })

    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage(
          {
            shot_size: 'wide',
            shot_size_origin: 'derived',
            camera_angle: 'eye_level',
            camera_angle_origin: 'auto', // no new evidence -> the override stays untouched
            camera_movement: 'pan',
            camera_movement_origin: 'derived', // explicit new evidence -> the override is overwritten
          },
          'derive_camera'
        )
      },
    }

    const result = await runCameraDerivation({ gateway, supabase: admin, projectId, shotId, userId: user.id })
    expect(result.ok).toBe(true)

    const shotRow = await readShot(shotId)
    expect(shotRow?.shot_size).toBe('wide')
    expect(shotRow?.shot_size_origin).toBe('derived')
    // Untouched: this field's origin stayed 'override' - Claude found no new evidence.
    expect(shotRow?.camera_angle).toBe('top_down')
    expect(shotRow?.camera_angle_origin).toBe('override')
    // Overwritten: origin was 'override' going in, but Claude's explicit 'derived'
    // answer wins - the description-wins-over-manual-override rule.
    expect(shotRow?.camera_movement).toBe('pan')
    expect(shotRow?.camera_movement_origin).toBe('derived')

    expect(shotRow?.image_prompt_stale).toBe(true)
    expect(shotRow?.video_prompt_stale).toBe(true)
  })

  test('a pre-network blocked call settles as failed with zero cost and no stale pending row', async () => {
    const user = primary.user
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    const gateway = throwingGateway(new LiveCallsBlockedError())

    const result = await runCameraDerivation({ gateway, supabase: admin, projectId, shotId, userId: user.id })
    expect(result.ok).toBe(false)

    const { data: usageRows, error: usageError } = await admin
      .from('usage')
      .select('status, estimated_cost, raw_usage')
      .eq('project_id', projectId)
      .eq('shot_id', shotId)
      .eq('operation', 'derive_camera')
    expect(usageError).toBeNull()
    expect(usageRows!.length).toBe(1)
    expect(usageRows![0].status).toBe('failed')
    // Unlike an ordinary throw, this must be exactly 0, not merely non-null -
    // assertLiveCallsAllowed() throws before any request reaches Anthropic, so
    // retaining the pre-flight quote here would be a real cost inflation.
    expect(usageRows![0].estimated_cost).toBe(0)
    const raw = usageRows![0].raw_usage as { blocked?: boolean; billed?: boolean }
    expect(raw.blocked).toBe(true)
    expect(raw.billed).toBe(false)
  })

  test('a failed derivation leaves the shot camera values completely unchanged', async () => {
    const user = primary.user
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      shot_size: 'wide',
      shot_size_origin: 'auto',
      camera_angle: 'low',
      camera_angle_origin: 'derived',
      camera_movement: 'handheld',
      camera_movement_origin: 'override',
    })
    const before = await readShot(shotId)

    const gateway = throwingGateway('simulated network failure')
    const result = await runCameraDerivation({ gateway, supabase: admin, projectId, shotId, userId: user.id })
    expect(result.ok).toBe(false)

    const after = await readShot(shotId)
    expect(after?.shot_size).toBe(before?.shot_size)
    expect(after?.shot_size_origin).toBe(before?.shot_size_origin)
    expect(after?.camera_angle).toBe(before?.camera_angle)
    expect(after?.camera_angle_origin).toBe(before?.camera_angle_origin)
    expect(after?.camera_movement).toBe(before?.camera_movement)
    expect(after?.camera_movement_origin).toBe(before?.camera_movement_origin)
  })
})
