import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'

test.describe('Inline scene editing', () => {
  test('editing a scene persists the text and clears its prompts', async ({ page, context }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])

      const { data: project, error: projectError } = await admin
        .from('projects')
        .insert({ user_id: user.id, title: 'Test project', current_step: 'script' })
        .select('id')
        .single()
      expect(projectError).toBeNull()

      const originalVoiceOver = 'Welcome to the show.'
      const { data: scene, error: sceneError } = await admin
        .from('scenes')
        .insert({
          project_id: project!.id,
          position: 1,
          scene_key: 'scene-1',
          voice_over: originalVoiceOver,
          image_prompt: 'A wide shot of a stage with warm lighting and an empty seat.',
          video_prompt: 'Slow dolly-in on an empty stage under warm spotlight.',
        })
        .select('id')
        .single()
      expect(sceneError).toBeNull()

      await page.goto(`/projects/${project!.id}/script`)

      const newVoiceOver = 'Welcome to the updated show.'
      await page.getByRole('button', { name: originalVoiceOver }).click()
      await page.locator('textarea').fill(newVoiceOver)
      await page.keyboard.press('Enter')

      await expect(page.getByText('Saved')).toBeVisible()

      const { data: updatedScene, error: fetchError } = await admin
        .from('scenes')
        .select('voice_over, image_prompt, video_prompt')
        .eq('id', scene!.id)
        .single()

      expect(fetchError).toBeNull()
      expect(updatedScene!.voice_over).toBe(newVoiceOver)
      expect(updatedScene!.image_prompt).toBeNull()
      expect(updatedScene!.video_prompt).toBeNull()
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
