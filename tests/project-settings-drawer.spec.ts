import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'

// The header settings chip and drawer, driven on Step 5 (any step's header carries it).

const KEY_ALPHABET = '23456789bcdfghjkmnpqrstvwxz'

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Settings drawer test',
      source_text: 'A short film for drawer tests.',
      duration_target: '30-60s',
      aspect_ratio: '9:16',
      current_step: 'video_prompts',
      furthest_step: 5,
      quality_preset: 'low',
      video_model: 'wan-3.0',
      video_resolution: '480p',
      image_quality: 'low',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShots(projectId: string, seconds: number[]) {
  const rows = seconds.map((s, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: `cccc${KEY_ALPHABET[i]}`,
    voice_over: `Line ${i + 1}.`,
    duration_sec: s,
  }))
  const { data, error } = await admin.from('shots').insert(rows).select('id, order_index').order('order_index')
  expect(error).toBeNull()
  return data!.map((row) => row.id as string)
}

async function openDrawer(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/video_prompts`)
  // Retried: a click that lands before hydration is lost.
  await expect(async () => {
    await page.getByTestId('project-settings-chip').click()
    await expect(page.getByTestId('project-settings-drawer')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
}

test.describe('Project settings drawer', () => {
  test('opens preselected from the project; Apply waits for a change and Cancel discards it', async ({ page }) => {
    const projectId = await seedProject({ quality_preset: 'medium', video_model: 'seedance-2.0-mini', video_resolution: '720p', image_quality: 'medium' })
    await openDrawer(page, projectId)

    await expect(page.getByTestId('quality-preset-medium')).toHaveAttribute('aria-checked', 'true')
    const apply = page.getByTestId('project-settings-apply')
    await expect(apply).toBeDisabled()

    await page.getByTestId('quality-preset-high').click()
    await expect(apply).toBeEnabled()
    // Back to the saved value: nothing differs, so Apply disables again.
    await page.getByTestId('quality-preset-medium').click()
    await expect(apply).toBeDisabled()

    await page.getByTestId('quality-preset-high').click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('project-settings-drawer')).toBeHidden()

    await page.getByTestId('project-settings-chip').click()
    await expect(page.getByTestId('quality-preset-medium')).toHaveAttribute('aria-checked', 'true')
    const { data: project } = await admin.from('projects').select('quality_preset').eq('id', projectId).single()
    expect(project!.quality_preset).toBe('medium')
  })

  test("a model that can't make some shots' lengths lists them with their new length, flags dialogue, and applies on confirm", async ({ page }) => {
    const projectId = await seedProject()
    const ids = await seedShots(projectId, [8, 22, 18])
    const { data: character } = await admin
      .from('elements')
      .insert({ project_id: projectId, name: 'Mara', type: 'character' })
      .select('id')
      .single()
    await admin
      .from('shot_dialogue')
      .insert({ project_id: projectId, shot_id: ids[1], element_id: character!.id, line: 'Hello.', order_index: 0 })

    await openDrawer(page, projectId)
    await page.getByRole('button', { name: 'Advanced' }).click()
    await page.getByTestId('quality-model-kling-v3-standard').click()
    await page.getByTestId('project-settings-apply').click()

    const confirm = page.getByTestId('project-settings-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm.getByText('2 shots need a length this model can make')).toBeVisible()
    const rows = confirm.getByTestId('project-settings-trim')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Shot 2 · 22s → 15s')
    await expect(rows.nth(0)).toContainText('Has dialogue — speech may be cut.')
    await expect(rows.nth(1)).toContainText('Shot 3 · 18s → 15s')
    await expect(rows.nth(1)).not.toContainText('Has dialogue')
    await expect(confirm.getByText('Video prompts will be marked stale.', { exact: false })).toBeVisible()

    await page.getByTestId('project-settings-confirm-apply').click()
    await expect(page.getByTestId('project-settings-drawer')).toBeHidden()

    const { data: shots } = await admin
      .from('shots')
      .select('duration_sec, film_duration_sec, video_prompt_stale')
      .eq('project_id', projectId)
      .order('order_index')
    // Only the length Kling can't make changes (no film length was set).
    expect(shots).toEqual([
      { duration_sec: 8, film_duration_sec: null, video_prompt_stale: true },
      { duration_sec: 15, film_duration_sec: null, video_prompt_stale: true },
      { duration_sec: 15, film_duration_sec: null, video_prompt_stale: true },
    ])
    const { data: project } = await admin
      .from('projects')
      .select('video_model, quality_preset, current_step, furthest_step')
      .eq('id', projectId)
      .single()
    expect(project).toEqual({ video_model: 'kling-v3-standard', quality_preset: 'custom', current_step: 'video_prompts', furthest_step: 5 })
  })

  test('after generation starts, video settings are locked and the image model and quality stay editable', async ({ page }) => {
    const projectId = await seedProject({ furthest_step: 6 })
    await openDrawer(page, projectId)

    await expect(page.getByTestId('project-settings-locked')).toBeVisible()
    await expect(page.getByTestId('quality-preset-high')).toBeDisabled()
    await page.getByRole('button', { name: 'Advanced' }).click()
    await expect(page.getByTestId('quality-model-kling-v3-standard')).toBeDisabled()
    await expect(page.getByTestId('quality-resolution-720p')).toBeDisabled()
    await expect(page.getByTestId('project-settings-apply')).toBeDisabled()

    await page.getByTestId('quality-image-high').click()
    await page.getByTestId('quality-image-model-gpt-image-2').click()
    await page.getByTestId('project-settings-apply').click()
    await expect(page.getByTestId('project-settings-drawer')).toBeHidden()

    const { data: project } = await admin
      .from('projects')
      .select('video_model, video_resolution, image_quality, image_model, quality_preset')
      .eq('id', projectId)
      .single()
    expect(project).toEqual({
      video_model: 'wan-3.0',
      video_resolution: '480p',
      image_quality: 'high',
      image_model: 'gpt-image-2',
      quality_preset: 'custom',
    })
  })
})
