import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { runCameraDerivation } from '../src/app/api/projects/[id]/shots/[shotId]/camera/logic'
import { successMessage, throwingGateway } from './helpers/claude-fakes'
import { LiveCallsBlockedError, type ClaudeGateway } from '../src/lib/claude'
import { CAMERA_FIELD_NAMES } from '../src/lib/prompts/camera-derivation'

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

  // Change B: the old "all three overridden -> skip the call entirely" guard is gone.
  // An explicit new description is real evidence and must always be checked, even when
  // every camera field is currently a manual choice - write-back still only overwrites
  // an override field when Claude reports explicit new evidence ('derived') for it. This
  // test fails against the removed guard (zero requests) and passes once Change B lands.
  test('editing the description while all three fields are override still re-derives, honoring explicit new evidence', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      shot_size: 'medium',
      shot_size_origin: 'override',
      camera_angle: 'eye_level',
      camera_angle_origin: 'override',
      camera_movement: 'static',
      camera_movement_origin: 'override',
    })

    let requestBody: unknown = null
    let cameraRequests = 0
    await page.route('**/api/projects/*/shots/*/camera', async (route) => {
      cameraRequests++
      requestBody = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          updated: {
            shot_size: { value: 'extreme_close_up', origin: 'derived' },
          },
        }),
      })
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const descriptionField = page.getByLabel('Visual description')
    await descriptionField.fill('An extreme close up of the lead actor.')
    await descriptionField.blur()

    await expect.poll(() => cameraRequests).toBe(1)
    expect(requestBody).toEqual({ fields: ['shot_size', 'camera_angle', 'camera_movement'] })
    await expect(page.getByRole('combobox', { name: 'Shot size' })).toHaveAttribute('data-value', 'extreme_close_up')
    // Untouched: the fulfilled response said nothing about these two, so the
    // per-field write-back rule leaves them exactly as they were.
    await expect(page.getByRole('combobox', { name: 'Camera angle' })).toHaveAttribute('data-value', 'eye_level')
    await expect(page.getByRole('combobox', { name: 'Camera movement' })).toHaveAttribute('data-value', 'static')
    expect((await readShot(shotId))?.camera_angle_origin).toBe('override')
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

  test('"Reset to auto" sends only the reverted field and applies the result in place', async ({ page }) => {
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

    await page.getByRole('button', { name: 'Reset to auto' }).click()

    await expect.poll(() => requestBody).toEqual({ fields: ['camera_angle'], revertField: 'camera_angle' })
    await expect(page.getByRole('combobox', { name: 'Camera angle' })).toHaveAttribute('data-value', 'low')
    await expect(page.getByText('Derived from your description')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reset to auto' })).toHaveCount(0)
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
    await page.getByRole('button', { name: 'Reset to auto' }).first().click()
    await page.getByRole('button', { name: 'Reset to auto' }).click()

    await expect.poll(() => seenBodies.length).toBe(2)
    await expect(page.getByRole('button', { name: 'Reset to auto' })).toHaveCount(0)
    expect(seenBodies).toContainEqual({ fields: ['camera_angle'], revertField: 'camera_angle' })
    expect(seenBodies).toContainEqual({ fields: ['camera_movement'], revertField: 'camera_movement' })
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

    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: user.id,
      fields: [...CAMERA_FIELD_NAMES],
    })
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

    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: user.id,
      fields: [...CAMERA_FIELD_NAMES],
    })
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
    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: user.id,
      fields: [...CAMERA_FIELD_NAMES],
    })
    expect(result.ok).toBe(false)

    const after = await readShot(shotId)
    expect(after?.shot_size).toBe(before?.shot_size)
    expect(after?.shot_size_origin).toBe(before?.shot_size_origin)
    expect(after?.camera_angle).toBe(before?.camera_angle)
    expect(after?.camera_angle_origin).toBe(before?.camera_angle_origin)
    expect(after?.camera_movement).toBe(before?.camera_movement)
    expect(after?.camera_movement_origin).toBe(before?.camera_movement_origin)
  })

  test('regression: reverting one overridden field never touches a different overridden field', async () => {
    const user = primary.user
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      visual_description: 'A low angle shot of the throne room.',
      shot_size: 'medium',
      shot_size_origin: 'override',
      camera_angle: 'top_down',
      camera_angle_origin: 'override',
      camera_movement: 'handheld',
      camera_movement_origin: 'override',
    })
    const before = await readShot(shotId)

    // The tool schema is built from `fields`, so a real call could never be asked about
    // camera_angle/camera_movement here - the fake gateway mirrors that by only ever
    // being able to answer for the single requested field.
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage({ shot_size: 'close_up', shot_size_origin: 'auto' }, 'derive_camera')
      },
    }

    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: user.id,
      fields: ['shot_size'],
      revertField: 'shot_size',
    })
    expect(result.ok).toBe(true)

    const after = await readShot(shotId)
    expect(after?.shot_size).toBe('close_up')
    expect(after?.shot_size_origin).toBe('auto')
    // The exact reported failure: these two must be byte-identical to before, both
    // value and origin - never inferred, defaulted, or widened into scope.
    expect(after?.camera_angle).toBe(before?.camera_angle)
    expect(after?.camera_angle_origin).toBe(before?.camera_angle_origin)
    expect(after?.camera_movement).toBe(before?.camera_movement)
    expect(after?.camera_movement_origin).toBe(before?.camera_movement_origin)
  })

  test('a judgement for a field outside the requested scope is discarded, not written', async () => {
    const user = primary.user
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      visual_description: 'A wide shot at dawn.',
      shot_size: 'medium',
      shot_size_origin: 'auto',
      camera_angle: 'top_down',
      camera_angle_origin: 'override',
      camera_movement: 'handheld',
      camera_movement_origin: 'override',
    })
    const before = await readShot(shotId)

    // A fake gateway isn't schema-constrained the way a real call is - it can return
    // fields the caller never asked about. The route must ignore them.
    const gateway: ClaudeGateway = {
      async createMessage() {
        return successMessage(
          {
            shot_size: 'wide',
            shot_size_origin: 'derived',
            camera_angle: 'eye_level',
            camera_angle_origin: 'derived',
            camera_movement: 'pan',
            camera_movement_origin: 'derived',
          },
          'derive_camera'
        )
      },
    }

    const result = await runCameraDerivation({
      gateway,
      supabase: admin,
      projectId,
      shotId,
      userId: user.id,
      fields: ['shot_size'],
    })
    expect(result.ok).toBe(true)

    const after = await readShot(shotId)
    expect(after?.shot_size).toBe('wide')
    expect(after?.shot_size_origin).toBe('derived')
    expect(after?.camera_angle).toBe(before?.camera_angle)
    expect(after?.camera_angle_origin).toBe(before?.camera_angle_origin)
    expect(after?.camera_movement).toBe(before?.camera_movement)
    expect(after?.camera_movement_origin).toBe(before?.camera_movement_origin)
  })

  test.describe('fields scope contract (400s)', () => {
    async function assertRejected(page: Page, projectId: string, shotId: string, body: unknown, before: unknown) {
      const response = await page.request.post(`/api/projects/${projectId}/shots/${shotId}/camera`, { data: body })
      expect(response.status()).toBe(400)
      expect(await countCameraUsageRows(projectId, shotId)).toBe(0)
      expect(await readShot(shotId)).toEqual(before)
    }

    test('fields omitted -> 400, no AI call, no row mutation', async ({ page }) => {
      const projectId = await seedProject()
      const shotId = await seedShot(projectId)
      const before = await readShot(shotId)
      await page.goto(`/projects/${projectId}/workbench`)
      await assertRejected(page, projectId, shotId, {}, before)
    })

    test('fields: [] -> 400, no AI call, no row mutation', async ({ page }) => {
      const projectId = await seedProject()
      const shotId = await seedShot(projectId)
      const before = await readShot(shotId)
      await page.goto(`/projects/${projectId}/workbench`)
      await assertRejected(page, projectId, shotId, { fields: [] }, before)
    })

    test('fields with an unknown member -> 400, no AI call, no row mutation', async ({ page }) => {
      const projectId = await seedProject()
      const shotId = await seedShot(projectId)
      const before = await readShot(shotId)
      await page.goto(`/projects/${projectId}/workbench`)
      await assertRejected(page, projectId, shotId, { fields: ['shot_size', 'lens_type'] }, before)
    })
  })

  test.describe('"Reset all to auto"', () => {
    test('is hidden when every camera field is already auto, but the helper text still renders', async ({ page }) => {
      const projectId = await seedProject()
      await seedShot(projectId, {
        shot_size_origin: 'auto',
        camera_angle_origin: 'auto',
        camera_movement_origin: 'auto',
      })

      await page.goto(`/projects/${projectId}/workbench`)
      await expandFirstCard(page)

      await expect(page.getByRole('button', { name: 'Reset all to auto' })).toHaveCount(0)
      await expect(
        page.getByText('AI picks a camera, unless your description names one or you pick one yourself.')
      ).toBeVisible()
    })

    test('is visible once exactly one field is non-auto', async ({ page }) => {
      const projectId = await seedProject()
      await seedShot(projectId, {
        shot_size_origin: 'override',
        camera_angle_origin: 'auto',
        camera_movement_origin: 'auto',
      })

      await page.goto(`/projects/${projectId}/workbench`)
      await expandFirstCard(page)

      await expect(page.getByRole('button', { name: 'Reset all to auto' })).toBeVisible()
    })

    test('clicking it issues exactly one call scoped to all three fields, and lands each on auto or derived', async ({
      page,
    }) => {
      const projectId = await seedProject()
      await seedShot(projectId, {
        visual_description: 'A description mentioning nothing in particular.',
        shot_size: 'medium',
        shot_size_origin: 'override',
        camera_angle: 'top_down',
        camera_angle_origin: 'override',
        camera_movement: 'handheld',
        camera_movement_origin: 'override',
      })

      let cameraRequests = 0
      let requestBody: unknown = null
      await page.route('**/api/projects/*/shots/*/camera', async (route) => {
        cameraRequests++
        requestBody = route.request().postDataJSON()
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            updated: {
              shot_size: { value: 'wide', origin: 'auto' },
              camera_angle: { value: 'eye_level', origin: 'derived' },
              camera_movement: { value: 'static', origin: 'auto' },
            },
          }),
        })
      })

      await page.goto(`/projects/${projectId}/workbench`)
      await expandFirstCard(page)

      await page.getByRole('button', { name: 'Reset all to auto' }).click()

      await expect.poll(() => cameraRequests).toBe(1)
      expect(requestBody).toEqual({ fields: ['shot_size', 'camera_angle', 'camera_movement'], resetAll: true })
      await expect(page.getByRole('combobox', { name: 'Shot size' })).toHaveAttribute('data-value', 'wide')
      await expect(page.getByRole('combobox', { name: 'Camera angle' })).toHaveAttribute('data-value', 'eye_level')
      await expect(page.getByRole('combobox', { name: 'Camera movement' })).toHaveAttribute('data-value', 'static')
      // camera_angle landed 'derived', not 'auto' - a legitimate outcome of a reset, so
      // "Reset all to auto" correctly stays visible (it hides only when every field is
      // 'auto'); the per-field "Reset to auto" button is gone since none is 'override'.
      await expect(page.getByRole('button', { name: 'Reset to auto' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Reset all to auto' })).toBeVisible()
    })

    test('per-field control reads "Reset to auto" and renders once per non-auto field; "Reset all to auto" renders exactly once', async ({
      page,
    }) => {
      const projectId = await seedProject()
      await seedShot(projectId, {
        shot_size_origin: 'override',
        camera_angle_origin: 'override',
        camera_movement_origin: 'auto',
      })

      await page.goto(`/projects/${projectId}/workbench`)
      await expandFirstCard(page)

      await expect(page.getByRole('button', { name: 'Reset to auto' })).toHaveCount(2)
      await expect(page.getByRole('button', { name: 'Reset all to auto' })).toHaveCount(1)
    })
  })

  test.describe('camera origin badge tooltips', () => {
    test('each badge exposes a tooltip matching its field’s current origin', async ({ page }) => {
      const projectId = await seedProject()
      await seedShot(projectId, {
        shot_size: 'wide',
        shot_size_origin: 'auto',
        camera_angle: 'low',
        camera_angle_origin: 'derived',
        camera_movement: 'handheld',
        camera_movement_origin: 'override',
      })

      await page.goto(`/projects/${projectId}/workbench`)
      await expandFirstCard(page)

      await expect(
        page.getByRole('combobox', { name: 'Shot size' }).getByText('auto', { exact: true })
      ).toHaveAttribute('title', 'AI chose this.')
      await expect(
        page.getByRole('combobox', { name: 'Camera angle' }).getByText('described', { exact: true })
      ).toHaveAttribute('title', 'Taken from your visual description.')
      await expect(
        page.getByRole('combobox', { name: 'Camera movement' }).getByText('set by you', { exact: true })
      ).toHaveAttribute('title', 'You picked this. It stays until you reset it.')

      // Scoped: only the three badges get a tooltip - the Reset controls stay untouched.
      expect(await page.getByRole('button', { name: 'Reset to auto' }).getAttribute('title')).toBeNull()
      expect(await page.getByRole('button', { name: 'Reset all to auto' }).getAttribute('title')).toBeNull()
    })
  })
})
