import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'

// A scene plan a failed attempt already paid for - resuming replays it, never re-asks.
const PENDING_PAYLOAD = {
  title: 'A short film',
  message: 'Here is your scene plan.',
  video_type: 'narrated_story',
  style: [],
  scenes: [
    { title: 'The Valley', summary: 'A quiet valley at dawn.', location: 'Valley', time_of_day: 'dawn', element_names: [], seconds: 45 },
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
      video_model: 'wan-3.0',
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
  test('resumes the stored scene plan without paying for it again, and cancelling sends nothing', async ({ page }) => {
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
      await expect(dialog.getByText(/reused at no cost/)).toBeVisible()

      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).not.toBeVisible()
      expect(shotsRequests.length).toBe(0)

      await page.getByRole('button', { name: 'Try again' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('dialog').getByRole('button', { name: 'Resume' }).click()

      await expect.poll(() => shotsRequests.length).toBeGreaterThan(0)
      expect(shotsRequests[0].method).toBe('POST')
      expect(JSON.parse(shotsRequests[0].postData ?? '{}')).toEqual({ retry: true })

      // The run replays the stored plan - no outline call is made - then asks for the
      // scene's shots. Live provider calls are blocked under test, so that one call settles
      // blocked at zero cost and the run ends failed: the plan was never paid for twice.
      // The seeded claim is already 'failed', so wait on the run record instead.
      await expect
        .poll(
          async () => {
            const { data } = await admin.from('shot_runs').select('status').eq('project_id', projectId).maybeSingle()
            return data?.status ?? null
          },
          { timeout: 60_000 }
        )
        .toBe('failed')
      expect((await readGeneration(projectId))?.state).toBe('failed')
      const { data: scenes } = await admin.from('scenes').select('title').eq('project_id', projectId)
      expect(scenes).toEqual([{ title: 'The Valley' }])
      const { data: usage } = await admin.from('usage').select('estimated_cost, raw_usage').eq('project_id', projectId)
      expect(usage).toHaveLength(1)
      expect(usage![0].estimated_cost).toBe(0)
      // The stale rows of the earlier attempt were replaced when the plan was applied.
      const { data: finalShots } = await admin.from('shots').select('id').eq('project_id', projectId)
      expect(finalShots).toHaveLength(0)
    }
  })
})
