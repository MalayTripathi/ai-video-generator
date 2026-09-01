import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'

const PENDING_PAYLOAD = {
  title: 'A short film',
  message: 'Here is your shot list.',
  video_type: 'narrated_story',
  shots: [
    {
      voice_over: 'Once upon a time, in a quiet valley.',
      visual_description: 'Wide shot of a castle at dawn.',
      shot_size: 'wide',
      camera_angle: 'eye_level',
      camera_movement: 'static',
      duration_sec: 5,
      section_label: 'Intro',
      dialogue: [],
      element_names: [],
    },
  ],
}

async function seedPartialProject(userId: string) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Untitled project',
      source_text: 'A short film about a quiet valley.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string

  const { error: generationError } = await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    state: 'failed',
    payload: PENDING_PAYLOAD as never,
  })
  expect(generationError).toBeNull()

  // The 2 shots a prior truncated attempt would have left behind.
  const { error: shotsError } = await admin.from('shots').insert([
    { project_id: projectId, order_index: 0, shot_key: 'bbbbb', voice_over: 'stale first attempt' },
    { project_id: projectId, order_index: 1, shot_key: 'ccccc', voice_over: 'stale second attempt' },
  ])
  expect(shotsError).toBeNull()

  return projectId
}

async function readGeneration(projectId: string) {
  const { data } = await admin
    .from('generations')
    .select('state, payload')
    .eq('project_id', projectId)
    .eq('step', 'workbench')
    .eq('operation', 'generate_shots')
    .is('shot_id', null)
    .single()
  return data
}

test.describe('retry from the partial phase', () => {
  test('resumes the pending payload without billing, and cancelling sends nothing', async ({ page }) => {
    // The default browser identity (primary, via playwright.config.ts's storageState)
    // is already authenticated - no per-test createTestSession()/addCookies needed.
    const user = primary.user
    {
      const shotsRequests: { method: string; postData: string | null }[] = []
      await page.route('**/api/projects/*/shots', async (route) => {
        const request = route.request()
        shotsRequests.push({ method: request.method(), postData: request.postData() })
        await route.continue()
      })

      const projectId = await seedPartialProject(user.id)
      await page.goto(`/projects/${projectId}/workbench`)

      // The regression this guards against: shots visible with no banner is
      // indistinguishable from a clean success.
      await expect(page.getByText('Generation was cut short')).toBeVisible()
      await expect(page.getByTestId('shot-card').first()).toBeVisible()
      await expect(page.getByTestId('shot-card')).toHaveCount(2)

      await page.getByRole('button', { name: 'Try again' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText(/no additional credits/)).toBeVisible()

      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).not.toBeVisible()
      expect(shotsRequests.length).toBe(0)

      await page.getByRole('button', { name: 'Try again' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('dialog').getByRole('button', { name: 'Resume' }).click()

      await expect.poll(() => shotsRequests.length).toBeGreaterThan(0)
      expect(shotsRequests[0].method).toBe('POST')
      expect(JSON.parse(shotsRequests[0].postData ?? '{}')).toEqual({ retry: true })

      // The recovery path never calls the gateway, so this is safe under the
      // ALLOW_REAL_CLAUDE guard regardless - it's worth confirming end to end.
      await expect
        .poll(async () => (await readGeneration(projectId))?.state, { timeout: 15_000 })
        .toBe('succeeded')

      const finalGeneration = await readGeneration(projectId)
      expect(finalGeneration?.payload).toBeNull()

      const { data: finalShots } = await admin.from('shots').select('*').eq('project_id', projectId)
      // Exactly the replayed batch's count, not the sum of the 2 stale rows plus the replay.
      expect(finalShots?.length).toBe(PENDING_PAYLOAD.shots.length)
    }
  })
})
