import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'

const SHOT_KEY_RE = /^[23456789bcdfghjkmnpqrstvwxz]{5}$/

test.describe('Step 2 workbench - shot generation', () => {
  test('generates unique-keyed shots, deduped elements, an applied title, and a message', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000) // real Claude call + multiple DB round trips

    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/projects/new')
      await page
        .getByPlaceholder(/describe your idea/i)
        .fill('A short video about a lighthouse keeper and her dog finding a shipwrecked sailor.')
      await page.getByRole('button', { name: 'Build workbench' }).click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/workbench$/, { waitUntil: 'commit' })

      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/workbench$/)?.[1]
      expect(projectId).toBeTruthy()

      await expect(page.getByTestId('shot-card').first()).toBeVisible({ timeout: 90_000 })
      await expect(page.getByText(/Couldn't build the shot list/)).not.toBeVisible()

      const { data: shots, error: shotsError } = await admin
        .from('shots')
        .select('shot_key')
        .eq('project_id', projectId!)
      expect(shotsError).toBeNull()
      expect(shots!.length).toBeGreaterThan(0)

      const keys = shots!.map((s) => s.shot_key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const key of keys) expect(key).toMatch(SHOT_KEY_RE)

      const { data: elements, error: elementsError } = await admin
        .from('elements')
        .select('name')
        .eq('project_id', projectId!)
      expect(elementsError).toBeNull()
      const lowerNames = elements!.map((e) => e.name.toLowerCase())
      expect(new Set(lowerNames).size).toBe(lowerNames.length)

      const { data: project, error: projectError } = await admin
        .from('projects')
        .select('title, video_type')
        .eq('id', projectId!)
        .single()
      expect(projectError).toBeNull()
      expect(project!.title).not.toBeNull()
      expect(project!.video_type).not.toBe('auto')

      const { data: messages, error: messagesError } = await admin
        .from('messages')
        .select('role, content')
        .eq('project_id', projectId!)
        .eq('role', 'assistant')
      expect(messagesError).toBeNull()
      expect(messages!.length).toBeGreaterThan(0)
      expect(messages![0].content.trim().length).toBeGreaterThan(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
