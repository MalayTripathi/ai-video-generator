import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { creditsFor } from '../src/lib/config/credits'
import { stepIndex } from '../src/lib/config/pipeline'

// The generation route is always mocked (Step 3 may auto-generate on arrival); the advance
// route is left real so a call to it is observable, never blocked.

async function seed(
  userId: string,
  opts: { furthestStep: number; shots: { prompt: string | null }[] }
) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Footer navigation',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      // Deliberately 'workbench' whatever furthest_step is: a plain navigation must leave
      // it there, since the only writer of current_step is advanceStep().
      current_step: 'workbench',
      furthest_step: opts.furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string

  // A project that has shots always has this row; without it the Workbench's own
  // zero-generation trigger would fire a real shot generation.
  const { error: genError } = await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    state: 'succeeded',
  })
  expect(genError).toBeNull()

  const { error: shotsError } = await admin.from('shots').insert(
    opts.shots.map((s, i) => ({
      project_id: projectId,
      order_index: i,
      shot_key: `fn${i}${Math.random().toString(36).slice(2, 4)}`,
      voice_over: `Voice over ${i}`,
      image_prompt: s.prompt,
      image_prompt_stale: false,
    }))
  )
  expect(shotsError).toBeNull()
  return projectId
}

async function readProject(projectId: string) {
  const { data } = await admin.from('projects').select('current_step, furthest_step, status').eq('id', projectId).single()
  return data!
}

async function drain(userId: string, leave: number) {
  const { error } = await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'spend',
    delta: -(5000 - leave),
    dedupe_key: `test-drain-${crypto.randomUUID()}`,
    attempt_id: crypto.randomUUID(),
    pricing_mode: 'fixed',
    price_version: 'test',
    step: 'workbench',
    operation: 'generate_shots',
  })
  expect(error).toBeNull()
}

// First navigation to a route in a cold dev server waits on an on-demand compile that can
// take many seconds; the default 5s assertion timeout measures the compiler, not the app.
const NAVIGATION = { timeout: 45000 }

const PROMPT = 'A stored image prompt long enough to stand for a real one on this shot.'
const WORKBENCH = stepIndex('workbench')

test.describe('Workbench footer button', () => {
  test.setTimeout(120000)

  // A cold dev server answers a route it has not registered yet with the app's 404 page,
  // even for a POST that arrives right after the page. Wait until the advance endpoint
  // exists (a GET is a 405 once it does) so the tests measure the app, not start-up order.
  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90000)
    const api = await playwright.request.newContext({ baseURL: 'http://localhost:3000' })
    const url = '/api/projects/00000000-0000-0000-0000-000000000000/image_prompts/advance'
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if ((await api.get(url)).status() !== 404) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await api.dispose()
  })

  test('at the Workbench it is the charging path: credit figure, then a confirmation before anything happens', async ({ page }) => {
    const projectId = await seed(primary.user.id, {
      furthestStep: WORKBENCH,
      shots: [{ prompt: null }, { prompt: null }, { prompt: null }],
    })
    const credits = creditsFor({ step: 'image_prompts', operation: 'write_image_prompts', quantity: 3 })
    let advanceCalls = 0
    await page.route('**/api/projects/*/image_prompts/advance', async (route) => {
      advanceCalls++
      await route.continue()
    })

    await page.goto(`/projects/${projectId}/workbench`)
    const button = page.getByRole('button', { name: `Generate Image Prompts - ${credits} Credits` })
    await expect(button).toBeVisible()
    await expect(page.getByRole('link', { name: /Go to/ })).toHaveCount(0)

    await button.click()
    await expect(page.getByRole('dialog')).toContainText('Generate image prompts?')
    expect(advanceCalls).toBe(0)
    expect((await readProject(projectId)).furthest_step).toBe(WORKBENCH)
  })

  test('past the Workbench it is a plain link: no credit figure, no modal, no advance call, no step write', async ({ page }) => {
    const projectId = await seed(primary.user.id, {
      furthestStep: WORKBENCH + 1,
      shots: [{ prompt: PROMPT }, { prompt: PROMPT }],
    })
    let advanceCalls = 0
    await page.route('**/api/projects/*/image_prompts/advance', async (route) => {
      advanceCalls++
      await route.continue()
    })

    await page.goto(`/projects/${projectId}/workbench`)
    const link = page.getByRole('link', { name: 'Go to Image Prompts' })
    await expect(link).toHaveAttribute('href', `/projects/${projectId}/image_prompts`)
    await expect(page.getByRole('button', { name: /Generate Image Prompts/ })).toHaveCount(0)
    await expect(page.getByText(/Credits/)).toHaveCount(0)

    await link.click()
    await expect(page).toHaveURL(`/projects/${projectId}/image_prompts`, NAVIGATION)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(advanceCalls).toBe(0)
    // advanceStep() is the sole writer of current_step: navigation alone never touches it.
    expect(await readProject(projectId)).toMatchObject({ current_step: 'workbench', furthest_step: WORKBENCH + 1 })
  })

  test('an advanced project with a short balance still just navigates - the user is returning to a page they own', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await drain(user.id, 1)
      const projectId = await seed(user.id, { furthestStep: WORKBENCH + 1, shots: [{ prompt: PROMPT }, { prompt: PROMPT }] })
      let advanceCalls = 0
      await page.route('**/api/projects/*/image_prompts/advance', async (route) => {
        advanceCalls++
        await route.continue()
      })
      await context.addCookies([cookie])

      await page.goto(`/projects/${projectId}/workbench`)
      await page.getByRole('link', { name: 'Go to Image Prompts' }).click()

      await expect(page).toHaveURL(`/projects/${projectId}/image_prompts`, NAVIGATION)
      await expect(page.getByRole('button', { name: /Regenerate All/ })).toBeVisible()
      await expect(page.getByText('Not enough credits')).toHaveCount(0)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(advanceCalls).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('the state does not depend on whether prompts exist: advanced with none is still plain navigation', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await drain(user.id, 1)
      const projectId = await seed(user.id, { furthestStep: WORKBENCH + 1, shots: [{ prompt: null }, { prompt: null }] })
      let generationCalls = 0
      await page.route('**/api/projects/*/image-prompts', async (route) => {
        generationCalls++
        await route.fulfill({ status: 500, body: '{}' })
      })
      await context.addCookies([cookie])

      await page.goto(`/projects/${projectId}/workbench`)
      await expect(page.getByRole('button', { name: /Generate Image Prompts/ })).toHaveCount(0)
      await page.getByRole('link', { name: 'Go to Image Prompts' }).click()

      // Step 3 owns this case: its own empty state, with the real balance gate in the route.
      await expect(page).toHaveURL(`/projects/${projectId}/image_prompts`, NAVIGATION)
      await expect(page.getByRole('alert').filter({ hasText: 'Not enough credits' })).toBeVisible()
      await page.waitForTimeout(500)
      expect(generationCalls).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('after generating from the Workbench, coming back shows the plain link - never the charging button again', async ({ page }) => {
    const projectId = await seed(primary.user.id, { furthestStep: WORKBENCH, shots: [{ prompt: null }] })
    // Step 3 auto-generates on arrival; keep that off the provider.
    await page.route('**/api/projects/*/image-prompts', async (route) => {
      await route.fulfill({ status: 500, body: '{}' })
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await page.getByRole('button', { name: /^Generate Image Prompts/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click()
    await expect(page).toHaveURL(`/projects/${projectId}/image_prompts`, NAVIGATION)
    expect((await readProject(projectId)).furthest_step).toBe(WORKBENCH + 1)

    await page.goBack()
    await expect(page).toHaveURL(`/projects/${projectId}/workbench`, NAVIGATION)
    await expect(page.getByRole('link', { name: 'Go to Image Prompts' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Generate Image Prompts/ })).toHaveCount(0)
  })
})
