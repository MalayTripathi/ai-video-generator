import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { DEFAULT_DURATION_TARGET } from '../src/lib/config/duration'

test.describe('New Project intake', () => {
  test('filling the brief and submitting creates a project and lands on workbench', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
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
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('the build button stays disabled until the brief has text', async ({ page, context }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/projects/new')

      const button = page.getByRole('button', { name: 'Build workbench' })
      await expect(button).toBeDisabled()

      await page.getByPlaceholder(/describe your idea/i).fill('A quick idea')
      await expect(button).toBeEnabled()
    } finally {
      await deleteTestUser(user.id)
    }
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
