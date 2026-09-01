import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { DEFAULT_DURATION_TARGET } from '../src/lib/config/duration'

test.describe('New Project intake', () => {
  test('filling the brief and submitting creates a project and lands on workbench', async ({ page }) => {
    // The default browser identity (primary, via playwright.config.ts's storageState)
    // is already authenticated - no per-test createTestSession()/addCookies needed.
    const user = primary.user
    {
      // The workbench mounts a client effect that immediately POSTs to trigger shot
      // generation. Block it so this test's read of shots_generation is deterministic
      // and this intake test never itself reaches a state that triggers generation.
      await page.route('**/api/projects/*/shots', (route) => route.abort())
      await page.goto('/projects/new')

      const brief = 'A short video about the history of the Great Wall of China'
      await page.getByPlaceholder(/describe your idea/i).fill(brief)

      await page.getByRole('button', { name: 'Build workbench' }).click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/workbench$/, { waitUntil: 'commit' })

      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/workbench$/)?.[1]
      expect(projectId).toBeTruthy()

      const { data: project, error } = await admin
        .from('projects')
        .select('*')
        .eq('id', projectId!)
        .single()

      expect(error).toBeNull()
      expect(project.user_id).toBe(user.id)
      expect(project.title).toBeNull()
      expect(project.source_text).toBe(brief)
      expect(project.status).toBe('draft')
      expect(project.current_step).toBe('workbench')
      expect(project.furthest_step).toBe(2)
      expect(project.aspect_ratio).toBe('9:16')
      expect(project.duration_target).toBe(DEFAULT_DURATION_TARGET)
      expect(project.video_type).toBe('auto')
      expect(project.template_source_id).toBeNull()

      // The auto-trigger POST is blocked above, so no claim was ever attempted - a
      // brand-new project has no generations row until its first claim.
      const { data: generation, error: generationError } = await admin
        .from('generations')
        .select('id')
        .eq('project_id', projectId!)
        .eq('step', 'workbench')
        .eq('operation', 'generate_shots')
        .is('shot_id', null)
        .maybeSingle()
      expect(generationError).toBeNull()
      expect(generation).toBeNull()
    }
  })

  test('the build button stays disabled until the brief has text', async ({ page }) => {
    await page.goto('/projects/new')

    const button = page.getByRole('button', { name: 'Build workbench' })
    await expect(button).toBeDisabled()

    await page.getByPlaceholder(/describe your idea/i).fill('A quick idea')
    await expect(button).toBeEnabled()
  })

  test('warns, but does not block, when the brief requests more shots than the selected duration caps', async ({
    page,
  }) => {
    const user = primary.user
    {
      // DEFAULT_DURATION_TARGET ('30-60s') is pre-selected, targetShots = 8.
      await page.route('**/api/projects/*/shots', (route) => route.abort())
      await page.goto('/projects/new')

      const warning = page.getByTestId('shot-count-warning')
      await expect(warning).toBeHidden()

      const brief = 'Create a 12 shot video about the history of the Great Wall of China'
      await page.getByPlaceholder(/describe your idea/i).fill(brief)
      await expect(warning).toBeVisible()

      const button = page.getByRole('button', { name: 'Build workbench' })
      await expect(button).toBeEnabled()

      // The warning never blocks the real submission path, not just the button state.
      await button.click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/workbench$/, { waitUntil: 'commit' })

      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/workbench$/)?.[1]
      expect(projectId).toBeTruthy()

      const { data: project, error } = await admin
        .from('projects')
        .select('user_id, source_text')
        .eq('id', projectId!)
        .single()
      expect(error).toBeNull()
      expect(project!.user_id).toBe(user.id)
      expect(project!.source_text).toBe(brief)
    }
  })

  test('does not warn when the requested shot count is at or below the selected duration cap', async ({ page }) => {
    await page.route('**/api/projects/*/shots', (route) => route.abort())
    await page.goto('/projects/new')

    const warning = page.getByTestId('shot-count-warning')

    // Below target (30-60s tier, targetShots = 8) - mirrors the already-correct
    // production behavior where fewer shots than target is honored, not padded.
    await page.getByPlaceholder(/describe your idea/i).fill('Create a 4 shot video about a lighthouse')
    await expect(warning).toBeHidden()

    // Exactly at target - explicit boundary, must stay silent.
    await page.getByPlaceholder(/describe your idea/i).fill('Create an 8 shot video about a lighthouse')
    await expect(warning).toBeHidden()
  })

  test('rail and empty-state "New Project" links navigate to the intake screen', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/dashboard')

      await page.getByTestId('new-project-empty').click()
      await page.waitForURL('/projects/new', { waitUntil: 'commit' })
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
