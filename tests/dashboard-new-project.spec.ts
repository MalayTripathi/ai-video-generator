import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'

test.describe('New project button', () => {
  test('rail button creates a project and redirects to the script step', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/dashboard')

      await page.getByTestId('new-project-rail').click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/script$/, { waitUntil: 'commit' })

      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/script$/)?.[1]
      expect(projectId).toBeTruthy()

      const { data: project, error } = await admin
        .from('projects')
        .select('*')
        .eq('id', projectId!)
        .single()

      expect(error).toBeNull()
      expect(project.user_id).toBe(user.id)
      expect(project.title).toBe('Untitled project')
      expect(project.status).toBe('draft')
      expect(project.current_step).toBe('script')
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('empty-state button creates a project and redirects to the script step', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/dashboard')

      // A fresh test user has no projects, so the empty-state card is showing.
      await expect(page.getByText('No projects yet')).toBeVisible()

      await page.getByTestId('new-project-empty').click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/script$/, { waitUntil: 'commit' })

      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/script$/)?.[1]
      expect(projectId).toBeTruthy()

      const { data: project, error } = await admin
        .from('projects')
        .select('*')
        .eq('id', projectId!)
        .single()

      expect(error).toBeNull()
      expect(project.user_id).toBe(user.id)
      expect(project.title).toBe('Untitled project')
      expect(project.status).toBe('draft')
      expect(project.current_step).toBe('script')
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('double-clicking the rail button only creates one project', async ({ page, context }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/dashboard')

      const button = page.getByTestId('new-project-rail')
      await Promise.all([button.click(), button.click({ force: true })])
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/script$/, { waitUntil: 'commit' })

      const { data: projects, error } = await admin
        .from('projects')
        .select('id')
        .eq('user_id', user.id)

      expect(error).toBeNull()
      expect(projects).toHaveLength(1)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
