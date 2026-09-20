import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'

// The panel is one component for every step; what differs per step is the data it is
// handed. Its empty-state example prompts must suggest things THAT step's agent can do -
// Step 3's agent regenerates image prompts and must decline "add a shot" - and every turn
// must tell the server which step's tools to run.

const WORKBENCH_EXAMPLES = ['Make shot 3 shorter', 'Add a shot about the artisans', 'Rewrite everything, colder tone']
const STEP3_EXAMPLES = ['Make shot 2 feel colder', 'Rewrite every prompt, more cinematic']

async function seedProject(step: 'workbench' | 'image_prompts') {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Panel examples',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: step,
      furthest_step: step === 'workbench' ? 2 : 3,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = data!.id as string

  await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    state: 'succeeded',
  })
  if (step === 'image_prompts') {
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: 'succeeded',
    })
  }
  const { error: shotError } = await admin.from('shots').insert({
    project_id: projectId,
    order_index: 0,
    shot_key: `ex${Math.random().toString(36).slice(2, 5)}`,
    voice_over: 'Original voiceover text.',
    visual_description: 'Original visual description.',
    image_prompt: 'A finished prompt that is long enough to count as written for the page.',
    image_prompt_stale: false,
  })
  expect(shotError).toBeNull()
  return projectId
}

async function captureAgentRequests(page: Page) {
  const bodies: { step?: string; content: string }[] = []
  await page.route('**/api/projects/*/agent', async (route) => {
    bodies.push(route.request().postDataJSON())
    // An empty stream closes with no `settled` - the panel's dropped-stream path; all this
    // test needs is the request that went out.
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
  })
  return bodies
}

test.describe('agent panel - per-step example prompts', () => {
  test('Step 3 offers one or two prompts tailored to image prompts, and none of the Workbench ones', async ({ page }) => {
    const projectId = await seedProject('image_prompts')
    await page.goto(`/projects/${projectId}/image_prompts`)

    const panel = page.locator('aside').filter({ hasText: 'Ask for a change in plain words' })
    await expect(panel).toBeVisible()
    for (const example of STEP3_EXAMPLES) {
      await expect(panel.getByRole('button', { name: example, exact: true })).toBeVisible()
    }
    for (const example of WORKBENCH_EXAMPLES) {
      await expect(panel.getByRole('button', { name: example, exact: true })).toHaveCount(0)
    }
  })

  test('the Workbench keeps its own examples, and none of the Step 3 ones', async ({ page }) => {
    const projectId = await seedProject('workbench')
    await page.goto(`/projects/${projectId}/workbench`)

    const panel = page.locator('aside').filter({ hasText: 'Ask for a change in plain words' })
    await expect(panel).toBeVisible()
    for (const example of WORKBENCH_EXAMPLES) {
      await expect(panel.getByRole('button', { name: example, exact: true })).toBeVisible()
    }
    for (const example of STEP3_EXAMPLES) {
      await expect(panel.getByRole('button', { name: example, exact: true })).toHaveCount(0)
    }
  })

  test('a turn sent from Step 3 tells the server it is a Step 3 turn', async ({ page }) => {
    const projectId = await seedProject('image_prompts')
    const bodies = await captureAgentRequests(page)
    await page.goto(`/projects/${projectId}/image_prompts`)

    await page.getByRole('button', { name: STEP3_EXAMPLES[0], exact: true }).click()
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0].step).toBe('image_prompts')
    expect(bodies[0].content).toBe(STEP3_EXAMPLES[0])
  })

  test('a turn sent from the Workbench tells the server it is a Workbench turn', async ({ page }) => {
    const projectId = await seedProject('workbench')
    const bodies = await captureAgentRequests(page)
    await page.goto(`/projects/${projectId}/workbench`)

    await page.getByRole('button', { name: WORKBENCH_EXAMPLES[0], exact: true }).click()
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0].step).toBe('workbench')
  })
})
