import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { videoTypeLabel } from '../src/lib/video-type-labels'

// Uses the fixed primary user; every assertion is scoped to the card of a project this
// spec just created (located by its link's href), never to the user's whole dashboard.

async function seedProject(opts: { status: string; furthestStep: number; shots: number; currentStep?: string }) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: `Dashboard card ${crypto.randomUUID().slice(0, 8)}`,
      source_text: 'A short film.',
      video_type: 'narrated_story',
      aspect_ratio: '9:16',
      duration_target: '30-60s',
      status: opts.status,
      current_step: opts.currentStep ?? 'workbench',
      furthest_step: opts.furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string

  if (opts.shots > 0) {
    const { error: shotsError } = await admin.from('shots').insert(
      Array.from({ length: opts.shots }, (_, i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: `dc${i}${Math.random().toString(36).slice(2, 4)}`,
        voice_over: `Voice over ${i}`,
      }))
    )
    expect(shotsError).toBeNull()
  }
  return projectId
}

function card(page: Page, projectId: string) {
  return page.locator(`a[href^="/projects/${projectId}/"]`)
}

async function filledColours(page: Page, projectId: string) {
  const filled = card(page, projectId).locator('[data-testid="progress-segment"][data-filled="true"]')
  return filled.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor))
}

test.describe('dashboard project card', () => {
  test('a project at Step 5 opens on its video prompts page', async ({ page }) => {
    const projectId = await seedProject({ status: 'in_progress', furthestStep: 5, shots: 2, currentStep: 'video_prompts' })
    await page.goto('/dashboard')

    await expect(card(page, projectId)).toHaveAttribute('href', `/projects/${projectId}/video_prompts`)
  })

  test('a draft with no shots omits the shot segment', async ({ page }) => {
    const projectId = await seedProject({ status: 'draft', furthestStep: 2, shots: 0 })
    await page.goto('/dashboard')

    const detail = card(page, projectId).getByTestId('project-card-detail')
    await expect(detail).toHaveText(`${videoTypeLabel('narrated_story')} · 9:16`)
    await expect(detail).not.toContainText('shot')
  })

  test('a project past the workbench shows its shot count and fills more than one segment', async ({ page }) => {
    const projectId = await seedProject({ status: 'in_progress', furthestStep: 4, shots: 3 })
    await page.goto('/dashboard')

    const c = card(page, projectId)
    await expect(c.getByTestId('project-card-detail')).toHaveText(`${videoTypeLabel('narrated_story')} · 3 shots · 9:16`)
    await expect(c.getByTestId('progress-segment')).toHaveCount(7)
    await expect(c.locator('[data-testid="progress-segment"][data-filled="true"]')).toHaveCount(4)
  })

  test('an in_progress card shows its furthest step in the badge, the relative time, and no Resume', async ({ page }) => {
    const projectId = await seedProject({ status: 'in_progress', furthestStep: 3, shots: 2 })
    await page.goto('/dashboard')

    const c = card(page, projectId)
    await expect(c.getByText('Step 3 of 7 · Image Prompts', { exact: true })).toBeVisible()
    await expect(c.getByText('today', { exact: true })).toBeVisible()
    await expect(c.getByText('Resume')).toHaveCount(0)
    await expect(c.getByText('In progress', { exact: true })).toHaveCount(0)
  })

  test('an in_progress card at furthest_step 1 or 2 still renders a step label', async ({ page }) => {
    const atIntake = await seedProject({ status: 'in_progress', furthestStep: 1, shots: 0 })
    const atWorkbench = await seedProject({ status: 'in_progress', furthestStep: 2, shots: 0 })
    await page.goto('/dashboard')

    await expect(card(page, atIntake).getByText('Step 1 of 7 · Intake', { exact: true })).toBeVisible()
    await expect(card(page, atWorkbench).getByText('Step 2 of 7 · Workbench', { exact: true })).toBeVisible()
  })

  test('draft and completed badges keep their text', async ({ page }) => {
    const draft = await seedProject({ status: 'draft', furthestStep: 2, shots: 0 })
    const done = await seedProject({ status: 'completed', furthestStep: 7, shots: 1 })
    await page.goto('/dashboard')

    await expect(card(page, draft).getByText('Draft', { exact: true })).toBeVisible()
    await expect(card(page, done).getByText('Complete', { exact: true })).toBeVisible()
  })

  test('fill colour follows status, not furthest_step', async ({ page }) => {
    const draftA = await seedProject({ status: 'draft', furthestStep: 3, shots: 0 })
    const activeA = await seedProject({ status: 'in_progress', furthestStep: 3, shots: 0 })
    const activeB = await seedProject({ status: 'in_progress', furthestStep: 5, shots: 0 })
    await page.goto('/dashboard')
    await expect(card(page, activeB)).toBeVisible()

    const draftColours = await filledColours(page, draftA)
    const activeColoursA = await filledColours(page, activeA)
    const activeColoursB = await filledColours(page, activeB)

    expect(draftColours).toHaveLength(3)
    expect(activeColoursA).toHaveLength(3)
    expect(activeColoursB).toHaveLength(5)
    // Same furthest_step, different status: different colour.
    expect(activeColoursA[0]).not.toBe(draftColours[0])
    // Same status, different furthest_step: same colour.
    expect(new Set([...activeColoursA, ...activeColoursB]).size).toBe(1)
  })
})
