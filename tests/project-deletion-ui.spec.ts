import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'

// Project deletion's UI (canvas §19): the dashboard card's "⋯" menu (a sibling of the card
// link, never inside it), the settings drawer's Delete project section (outside Apply, and
// available when locked), and the one confirm modal in all five states. Uses the fixed
// primary user; every assertion is scoped to a project this spec just created.

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: `Deletion UI ${crypto.randomUUID().slice(0, 8)}`,
      source_text: 'A short film.',
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
    .select('id, title')
    .single()
  expect(error).toBeNull()
  return { projectId: data!.id as string, title: data!.title as string }
}

const cardLink = (page: Page, projectId: string) => page.locator(`a[href^="/projects/${projectId}/"]`)
// The card's cell: the link and, beside it, the menu.
const cardCell = (page: Page, projectId: string) => cardLink(page, projectId).locator('xpath=..')

async function openCardMenuModal(page: Page, projectId: string) {
  await page.goto('/dashboard')
  await expect(async () => {
    await cardCell(page, projectId).getByTestId('project-card-menu-button').click()
    await expect(page.getByRole('menu', { name: 'Project actions' })).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await page.getByRole('menuitem', { name: 'Delete project' }).click()
  return page.getByRole('alertdialog')
}

test.describe('project deletion UI', () => {
  test('the card menu sits beside the link; Delete enables only on an exact "Delete"; deleting removes the card with a toast', async ({ page }) => {
    const { projectId, title } = await seedProject()
    await page.goto('/dashboard')
    // The card itself is unchanged: still one link, and the menu button is not inside it.
    await expect(cardLink(page, projectId)).toHaveCount(1)
    await expect(cardLink(page, projectId).getByTestId('project-card-menu-button')).toHaveCount(0)

    const dialog = await openCardMenuModal(page, projectId)
    await expect(dialog).toContainText(`Delete “${title}”?`)
    await expect(dialog.locator('em', { hasText: 'Delete' })).toBeVisible()
    const input = dialog.getByRole('textbox')
    const submit = dialog.getByRole('button', { name: 'Delete project' })
    await expect(submit).toBeDisabled() // C1 empty
    for (const wrong of ['delete', 'DELETE', 'Delete ', 'Delet']) {
      await input.fill(wrong)
      await expect(submit).toBeDisabled()
    }
    await input.fill('Delete') // C2 typed
    await expect(submit).toBeEnabled()

    // C3 deleting: held open long enough to see it.
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      await new Promise((r) => setTimeout(r, 800))
      await route.continue()
    })
    await submit.click()
    await expect(dialog.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    await expect(input).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await expect(page.getByRole('status').filter({ hasText: 'Project deleted' })).toBeVisible()
    await expect(cardLink(page, projectId)).toHaveCount(0)
    expect((await admin.from('projects').select('id').eq('id', projectId).maybeSingle()).data).toBeNull()
  })

  test('a running generation shows the refused state; a failed request shows the error state with the input kept', async ({ page }) => {
    const { projectId } = await seedProject()
    const { error } = await admin.from('generations').insert({
      project_id: projectId, step: 'video_prompts', operation: 'write_video_prompts', shot_id: null, element_id: null, state: 'generating', started_at: new Date().toISOString(),
    })
    expect(error).toBeNull()

    let dialog = await openCardMenuModal(page, projectId)
    await dialog.getByRole('textbox').fill('Delete')
    await dialog.getByRole('button', { name: 'Delete project' }).click()
    await expect(dialog).toContainText('A generation is running in this project. Wait for it to finish, then delete.') // C4
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)

    await page.route(`**/api/projects/${projectId}`, (route) => route.fulfill({ status: 500, body: '{"ok":false}' }))
    await cardCell(page, projectId).getByTestId('project-card-menu-button').click()
    await page.getByRole('menuitem', { name: 'Delete project' }).click()
    dialog = page.getByRole('alertdialog')
    await dialog.getByRole('textbox').fill('Delete')
    await dialog.getByRole('button', { name: 'Delete project' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Couldn’t delete the project. Try again.') // C5
    await expect(dialog.getByRole('textbox')).toHaveValue('Delete')
    await expect(dialog.getByRole('button', { name: 'Delete project' })).toBeEnabled()
    expect((await admin.from('projects').select('id').eq('id', projectId).maybeSingle()).data).not.toBeNull()
  })

  test('the drawer section sits outside Apply, stays available when locked, and deleting lands on the dashboard with the toast', async ({ page }) => {
    const { projectId } = await seedProject({ furthest_step: 6, current_step: 'video_prompts' })
    await page.goto(`/projects/${projectId}/video_prompts`)
    await expect(async () => {
      await page.getByTestId('project-settings-chip').click()
      await expect(page.getByTestId('project-settings-drawer')).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })

    const section = page.getByTestId('project-settings-delete')
    await expect(page.getByTestId('project-settings-locked')).toBeVisible()
    await expect(section.getByRole('button', { name: 'Delete project' })).toBeEnabled()
    await expect(page.getByTestId('project-settings-apply')).toBeDisabled()
    await section.getByRole('button', { name: 'Delete project' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('project-settings-apply')).toBeDisabled()

    await dialog.getByRole('textbox').fill('Delete')
    await dialog.getByRole('button', { name: 'Delete project' }).click()
    await page.waitForURL('**/dashboard')
    await expect(page.getByRole('status').filter({ hasText: 'Project deleted' })).toBeVisible()

    // Any project URL for the deleted id now redirects to the dashboard.
    await page.goto(`/projects/${projectId}/storyboard`)
    await expect(page).toHaveURL(/\/dashboard$/)
  })
})
