import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { creditsFor } from '../src/lib/config/credits'
import { stepIndex } from '../src/lib/config/pipeline'

// Step 3's footer button, mirroring workbench-footer-navigation.spec.ts. The prompt
// generation route is always mocked (Step 3 may auto-generate on arrival); the storyboard
// advance route is left real so a call to it is observable, never blocked.

const PROMPT = 'A stored image prompt long enough to stand for a real one on this shot.'
const IMAGE_PROMPTS = stepIndex('image_prompts')
const STORYBOARD = stepIndex('storyboard')

async function seed(userId: string, opts: { furthestStep: number; shots: number }) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Step 3 footer navigation',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      // Deliberately 'image_prompts' whatever furthest_step is: a plain navigation must
      // leave it there, since the only writer of current_step is advanceStep().
      current_step: 'image_prompts',
      furthest_step: opts.furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string

  // A project that has reached Step 3 always has both rows; without them the Workbench's
  // and Step 3's own zero-generation triggers would fire real generations.
  const { error: genError } = await admin.from('generations').insert([
    { project_id: projectId, step: 'workbench', operation: 'generate_shots', shot_id: null, state: 'succeeded' },
    { project_id: projectId, step: 'image_prompts', operation: 'write_image_prompts', shot_id: null, state: 'succeeded' },
  ])
  expect(genError).toBeNull()

  const { error: shotsError } = await admin.from('shots').insert(
    Array.from({ length: opts.shots }, (_, i) => ({
      project_id: projectId,
      order_index: i,
      shot_key: `sf${i}${Math.random().toString(36).slice(2, 4)}`,
      voice_over: `Voice over ${i}`,
      image_prompt: PROMPT,
      image_prompt_stale: false,
    }))
  )
  expect(shotsError).toBeNull()
  return projectId
}

async function readProject(projectId: string) {
  const { data } = await admin.from('projects').select('current_step, furthest_step').eq('id', projectId).single()
  return data!
}

async function ledgerRowsFor(projectId: string) {
  const { count } = await admin
    .from('credit_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
  return count
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

test.describe('Step 3 footer button', () => {
  test.setTimeout(120000)

  // A cold dev server answers a route it has not registered yet with the app's 404 page,
  // even for a POST that arrives right after the page. Wait until the advance endpoint
  // exists (a GET is a 405 once it does) so the tests measure the app, not start-up order.
  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90000)
    const api = await playwright.request.newContext({ baseURL: 'http://localhost:3000' })
    const url = '/api/projects/00000000-0000-0000-0000-000000000000/storyboard/advance'
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if ((await api.get(url)).status() !== 404) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await api.dispose()
  })

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/projects/*/image-prompts', async (route) => {
      await route.fulfill({ status: 500, body: '{}' })
    })
  })

  test('at Image Prompts it is the charging path: credit figure, then a confirmation before anything happens', async ({
    page,
  }) => {
    const projectId = await seed(primary.user.id, { furthestStep: IMAGE_PROMPTS, shots: 3 })
    const credits = creditsFor({ step: 'storyboard', operation: 'generate_image', quantity: 3 })
    let advanceCalls = 0
    await page.route('**/api/projects/*/storyboard/advance', async (route) => {
      advanceCalls++
      await route.continue()
    })

    await page.goto(`/projects/${projectId}/image_prompts`)
    const button = page.getByRole('button', { name: `Create Storyboard — ${credits} Credits` })
    await expect(button).toBeVisible(NAVIGATION)
    await expect(page.getByRole('link', { name: /Go to/ })).toHaveCount(0)

    await button.click()
    await expect(page.getByRole('dialog')).toContainText('Continue to storyboard?')
    expect(advanceCalls).toBe(0)
    expect((await readProject(projectId)).furthest_step).toBe(IMAGE_PROMPTS)

    // Cancel leaves everything as it was.
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(advanceCalls).toBe(0)
    expect((await readProject(projectId)).furthest_step).toBe(IMAGE_PROMPTS)
  })

  test('confirming with a sufficient balance advances the project and opens the storyboard, writing nothing to the ledger', async ({
    page,
  }) => {
    const projectId = await seed(primary.user.id, { furthestStep: IMAGE_PROMPTS, shots: 2 })

    await page.goto(`/projects/${projectId}/image_prompts`)
    await page.getByRole('button', { name: /^Create Storyboard/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click()

    await expect(page).toHaveURL(`/projects/${projectId}/storyboard`, NAVIGATION)
    await expect(page.getByTestId('storyboard-placeholder')).toBeVisible(NAVIGATION)
    expect(await readProject(projectId)).toMatchObject({ current_step: 'storyboard', furthest_step: STORYBOARD })
    expect(await ledgerRowsFor(projectId)).toBe(0)
  })

  test('an insufficient balance keeps Confirm disabled and Cancel enabled, and does not advance', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await drain(user.id, 1)
      const projectId = await seed(user.id, { furthestStep: IMAGE_PROMPTS, shots: 2 })
      await context.addCookies([cookie])

      await page.goto(`/projects/${projectId}/image_prompts`)
      await page.getByRole('button', { name: /^Create Storyboard/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Continue' }).click()

      await expect(dialog.getByRole('alert')).toContainText('Not enough credits for the storyboard')
      await expect(dialog.getByRole('button', { name: 'Continue' })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled()
      expect(await readProject(projectId)).toMatchObject({ current_step: 'image_prompts', furthest_step: IMAGE_PROMPTS })
      expect(await ledgerRowsFor(projectId)).toBe(0)

      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('past Image Prompts it is a plain link: no credit figure, no modal, no advance call, no step write', async ({
    page,
  }) => {
    const projectId = await seed(primary.user.id, { furthestStep: STORYBOARD, shots: 2 })
    let advanceCalls = 0
    await page.route('**/api/projects/*/storyboard/advance', async (route) => {
      advanceCalls++
      await route.continue()
    })

    await page.goto(`/projects/${projectId}/image_prompts`)
    const link = page.getByRole('link', { name: 'Go to Storyboard' })
    await expect(link).toHaveAttribute('href', `/projects/${projectId}/storyboard`, NAVIGATION)
    await expect(link).toHaveText('Go to Storyboard')
    await expect(page.getByRole('button', { name: /Create Storyboard/ })).toHaveCount(0)

    await link.click()
    await expect(page).toHaveURL(`/projects/${projectId}/storyboard`, NAVIGATION)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(advanceCalls).toBe(0)
    // advanceStep() is the sole writer of current_step: navigation alone never touches it.
    expect(await readProject(projectId)).toMatchObject({ current_step: 'image_prompts', furthest_step: STORYBOARD })
    expect(await ledgerRowsFor(projectId)).toBe(0)
  })

  test('an advanced project with a short balance still just navigates - the user is returning to a page they own', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await drain(user.id, 1)
      const projectId = await seed(user.id, { furthestStep: STORYBOARD, shots: 2 })
      let advanceCalls = 0
      await page.route('**/api/projects/*/storyboard/advance', async (route) => {
        advanceCalls++
        await route.continue()
      })
      await context.addCookies([cookie])

      await page.goto(`/projects/${projectId}/image_prompts`)
      await page.getByRole('link', { name: 'Go to Storyboard' }).click()

      await expect(page).toHaveURL(`/projects/${projectId}/storyboard`, NAVIGATION)
      await expect(page.getByTestId('storyboard-placeholder')).toBeVisible(NAVIGATION)
      await expect(page.getByText('Not enough credits')).toHaveCount(0)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(advanceCalls).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
