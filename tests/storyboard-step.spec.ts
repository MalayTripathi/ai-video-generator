import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary, SECONDARY_STORAGE_STATE } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { runAgentTurn } from '../src/app/api/projects/[id]/agent/logic'
import { getAgentStepConfig } from '../src/app/api/projects/[id]/agent/steps'
import { scriptedGateway, textMessage } from './helpers/claude-fakes'

// Step 4 placeholder: access rules, the shell around an empty state, and an agent panel
// that runs with no tools. Every agent call here is a hand-written fake or a mocked route.

const NAVIGATION = { timeout: 45000 }

async function seed(opts: { furthestStep: number; currentStep?: string }) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Storyboard step',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: opts.currentStep ?? 'image_prompts',
      furthest_step: opts.furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = data!.id as string

  const { error: shotError } = await admin.from('shots').insert({
    project_id: projectId,
    order_index: 0,
    shot_key: `sb${Math.random().toString(36).slice(2, 5)}`,
    voice_over: 'Placeholder voice-over.',
    image_prompt: 'A finished prompt that is long enough to count as written for the page.',
  })
  expect(shotError).toBeNull()
  return projectId
}

test.describe('storyboard placeholder page', () => {
  test.setTimeout(120000)

  test('a project that has not reached the storyboard is sent back to its current step', async ({ page }) => {
    const projectId = await seed({ furthestStep: stepIndex('image_prompts'), currentStep: 'image_prompts' })
    await admin.from('generations').insert([
      { project_id: projectId, step: 'workbench', operation: 'generate_shots', shot_id: null, state: 'succeeded' },
      { project_id: projectId, step: 'image_prompts', operation: 'write_image_prompts', shot_id: null, state: 'succeeded' },
    ])
    // Step 3 must not auto-generate on arrival.
    await page.route('**/api/projects/*/image-prompts', (route) => route.fulfill({ status: 500, body: '{}' }))

    await page.goto(`/projects/${projectId}/storyboard`)
    await expect(page).toHaveURL(`/projects/${projectId}/image_prompts`, NAVIGATION)
    await expect(page.getByTestId('storyboard-placeholder')).toHaveCount(0)
  })

  test('once reached it shows the coming-soon empty state inside the real shell', async ({ page }) => {
    const projectId = await seed({ furthestStep: stepIndex('storyboard'), currentStep: 'storyboard' })

    await page.goto(`/projects/${projectId}/storyboard`)
    await expect(page.getByRole('heading', { name: 'Storyboard is coming soon' })).toBeVisible(NAVIGATION)

    // The shell's own pieces, not copies: step indicator with Storyboard current, agent
    // panel, and an inert footer button.
    const indicator = page.getByTestId('step-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator.locator(`a[href="/projects/${projectId}/storyboard"]`)).toHaveCount(0)
    await expect(page.getByText('Agent', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Continue to Video Prompts/ })).toBeDisabled()
    // No tools means nothing to suggest.
    await expect(page.getByRole('button', { name: 'Make shot 2 feel colder' })).toHaveCount(0)
  })

  test("the panel's turn request names the storyboard step", async ({ page }) => {
    const projectId = await seed({ furthestStep: stepIndex('storyboard'), currentStep: 'storyboard' })
    const bodies: { step?: string }[] = []
    await capture(page, bodies)

    await page.goto(`/projects/${projectId}/storyboard`)
    await page.getByLabel('Ask for a change').fill('Hello')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => bodies.length, NAVIGATION).toBe(1)
    expect(bodies[0].step).toBe('storyboard')
  })

  test.describe('another signed-in user', () => {
    test.use({ storageState: SECONDARY_STORAGE_STATE })

    test("cannot open someone else's storyboard", async ({ page }) => {
      const projectId = await seed({ furthestStep: stepIndex('storyboard'), currentStep: 'storyboard' })

      await page.goto(`/projects/${projectId}/storyboard`)
      await expect(page.getByText('This page could not be found.')).toBeVisible(NAVIGATION)
      await expect(page.getByTestId('storyboard-placeholder')).toHaveCount(0)
    })
  })
})

async function capture(page: Page, bodies: { step?: string }[]) {
  await page.route('**/api/projects/*/agent', async (route) => {
    bodies.push(route.request().postDataJSON())
    // An empty stream closes with no `settled` - all this test needs is the request.
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
  })
}

test.describe('storyboard agent config', () => {
  test('has no tools, and a full turn runs against it with none sent to the model', async () => {
    const config = getAgentStepConfig('storyboard')
    expect(config.tools).toEqual([])

    const projectId = await seed({ furthestStep: stepIndex('storyboard'), currentStep: 'storyboard' })
    const gateway = scriptedGateway([textMessage('Nothing can be changed on this step yet.')])

    const result = await runAgentTurn({
      config,
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'make shot 1 shorter',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: async () => {},
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(1)
    const request = gateway.getCalls()[0]
    expect(request.tools).toEqual([])
    // Every system block is sent with cache_control; the API rejects an empty text block.
    const system = request.system as { text: string }[]
    expect(system.length).toBeGreaterThan(0)
    for (const block of system) expect(block.text.length).toBeGreaterThan(0)

    // The turn's usage row carries the storyboard step, and it is a step the vocabulary
    // says may run an agent turn.
    const { data: usage } = await admin.from('usage').select('step, operation, status').eq('project_id', projectId)
    expect(usage).toEqual([{ step: 'storyboard', operation: 'agent_turn', status: 'succeeded' }])
  })

  test('locks once video prompts have started, before any model call', async () => {
    const projectId = await seed({ furthestStep: stepIndex('video_prompts'), currentStep: 'storyboard' })
    const gateway = scriptedGateway([])

    const result = await runAgentTurn({
      config: getAgentStepConfig('storyboard'),
      gateway,
      supabase: admin,
      projectId,
      userId: primary.user.id,
      content: 'anything',
      clientId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      recordTurnSpend: async () => {},
    })

    expect(result.ok).toBe(true)
    expect(gateway.getCallCount()).toBe(0)
  })
})
