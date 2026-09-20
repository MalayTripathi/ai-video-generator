import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

// current_step is deliberately seeded to 'image_prompts' and never changes for the
// life of these tests - the whole point is proving the active highlight tracks the
// browser route, not this DB column (which no client-side navigation ever writes).
async function seedProject(furthestStep = stepIndex('image_prompts')) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Step indicator navigation test',
      source_text: 'A short film for step-indicator-navigation tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'image_prompts',
      furthest_step: furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = data!.id as string

  // A project that has genuinely reached furthest_step 3 always has shots already -
  // without this, workbench's zero-shots auto-trigger fires a real generation call
  // that races with this test's navigation.
  const { error: generationError } = await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    state: 'succeeded',
  })
  expect(generationError).toBeNull()

  const { error: shotError } = await admin.from('shots').insert({
    project_id: projectId,
    order_index: 0,
    shot_key: 'si001',
    voice_over: 'Placeholder voice-over.',
    // A prompt already present is what keeps Step 3 from auto-generating on arrival
    // (which would race with this test's navigation, same as the workbench trigger above).
    image_prompt: 'A stored image prompt so that Step 3 has nothing to generate on arrival.',
  })
  expect(shotError).toBeNull()

  return projectId
}

test.describe('step indicator', () => {
  test('active highlight follows the route, including after browser Back - not the current_step DB value', async ({
    page,
  }) => {
    const projectId = await seedProject()

    await page.goto(`/projects/${projectId}/workbench`)
    // Scoped to the indicator: once Step 3 is unlocked the Workbench footer also carries a
    // plain "Go to Image prompts" link to the same URL (it must navigate, never regenerate).
    const indicator = page.getByTestId('step-indicator')
    const workbenchLink = indicator.locator(`a[href="/projects/${projectId}/workbench"]`)
    const imagePromptsLink = indicator.locator(`a[href="/projects/${projectId}/image_prompts"]`)

    // On workbench: workbench is the active (non-link) item, image_prompts is an
    // unlocked-but-not-active Link - even though current_step in the DB still says
    // 'image_prompts'.
    await expect(workbenchLink).toHaveCount(0)
    await expect(imagePromptsLink).toHaveCount(1)

    // Real client-side navigation (not page.goto) so the browser history entry exists
    // for the Back press below.
    await imagePromptsLink.click()
    await expect(page).toHaveURL(`/projects/${projectId}/image_prompts`)
    await expect(page.getByRole('button', { name: /Regenerate All/ })).toBeVisible()
    await expect(imagePromptsLink).toHaveCount(0)
    await expect(workbenchLink).toHaveCount(1)

    // The regression this fixes: pressing Back changes the route with no DB write at
    // all, so an indicator still keyed off current_step would keep showing Image
    // prompts as active here.
    await page.goBack()
    await expect(page).toHaveURL(`/projects/${projectId}/workbench`)
    await expect(workbenchLink).toHaveCount(0)
    await expect(imagePromptsLink).toHaveCount(1)
  })

  test('hovering an unlocked, non-active step applies the active step\'s rest-state accent color', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await page.goto(`/projects/${projectId}/workbench`)

    const imagePromptsLink = page
      .getByTestId('step-indicator')
      .locator(`a[href="/projects/${projectId}/image_prompts"]`)
    const badge = imagePromptsLink.locator('span').first()

    const restColor = await badge.evaluate((el) => getComputedStyle(el).color)
    await imagePromptsLink.hover()
    await expect
      .poll(() => badge.evaluate((el) => getComputedStyle(el).color))
      .not.toBe(restColor)

    // rgb(91, 91, 214) is --accent, the same color the active step's badge carries at
    // rest - the exact color this hover state is meant to mirror.
    await expect.poll(() => badge.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(91, 91, 214)')
  })

  test('Storyboard unlocks at its own furthest_step and Steps 5-7 stay locked, with the existing dynamic tooltip', async ({
    page,
  }) => {
    const beforeId = await seedProject(stepIndex('image_prompts'))
    await page.goto(`/projects/${beforeId}/workbench`)
    const before = page.getByTestId('step-indicator')
    await expect(before.locator(`a[href="/projects/${beforeId}/storyboard"]`)).toHaveCount(0)
    await expect(before.locator('[aria-disabled="true"]')).toHaveCount(4)

    const projectId = await seedProject(stepIndex('storyboard'))
    await page.goto(`/projects/${projectId}/workbench`)
    const indicator = page.getByTestId('step-indicator')
    await expect(indicator.locator(`a[href="/projects/${projectId}/storyboard"]`)).toHaveCount(1)
    // Video prompts, Generation and Assembly.
    await expect(indicator.locator('[aria-disabled="true"]')).toHaveCount(3)

    // The tooltip names the furthest unlocked step - no string was added for Step 4.
    await indicator.getByText('Video prompts').hover()
    await expect(page.getByRole('tooltip')).toHaveText('Complete Storyboard to unlock')
  })
})
