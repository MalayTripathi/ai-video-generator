import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { creditsFor } from '../src/lib/config/credits'

// The generation route is always mocked here: this suite drives the client's request
// scoping, modals, and outcome handling - never a model call. Saves (blur) go through the
// real server action.

const PROMPT = (n: number) =>
  `Prompt ${n}: a wide establishing shot of the Taj Mahal at sunrise, soft light on white marble, reflections in the river, documentary framing.`

type Seeded = { projectId: string; shotIds: string[] }

async function seed(
  shots: { prompt: string | null; stale: boolean; edited?: boolean }[],
  generation: 'succeeded' | 'failed' | null = 'succeeded'
): Promise<Seeded> {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Image prompts page test',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'image_prompts',
      furthest_step: 3,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string

  if (generation) {
    const { error: genError } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: generation,
    })
    expect(genError).toBeNull()
  }

  const { data, error: shotsError } = await admin
    .from('shots')
    .insert(
      shots.map((s, i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: `pg${i}${Math.random().toString(36).slice(2, 4)}`,
        voice_over: `Voice over ${i}`,
        image_prompt: s.prompt,
        image_prompt_stale: s.stale,
        image_prompt_edited: s.edited ?? false,
      }))
    )
    .select('id, order_index')
  expect(shotsError).toBeNull()
  const shotIds = data!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id)
  return { projectId, shotIds }
}

// React marks a hydrated DOM node with a __reactProps$ key; clicking before that does
// nothing, so gate on it rather than on visibility alone.
async function waitForHydration(page: Page) {
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((b) => /Regenerate All/.test(b.textContent ?? ''))
    return !!button && Object.keys(button).some((k) => k.startsWith('__reactProps'))
  })
}

async function mockGeneration(
  page: Page,
  projectId: string,
  respond: (route: import('@playwright/test').Route) => Promise<void>
) {
  const bodies: { shotIds: string[]; retry: boolean }[] = []
  await page.route('**/api/projects/*/image-prompts', async (route) => {
    bodies.push(JSON.parse(route.request().postData()!))
    await respond(route)
  })
  return bodies
}

async function currentRows(projectId: string) {
  const { data } = await admin.from('shots').select('*').eq('project_id', projectId).order('order_index')
  return data!
}

test.describe('Step 3 image prompts', () => {
  test('per-card Regenerate, Regenerate Stale and Regenerate All send exactly the right shots; only an edited prompt asks first', async ({
    page,
  }) => {
    // 0 fresh, 1 stale, 2 stale+edited, 3 fresh, 4 ungenerated (its stale flag is noise).
    const { projectId, shotIds } = await seed([
      { prompt: PROMPT(1), stale: false },
      { prompt: PROMPT(2), stale: true },
      { prompt: PROMPT(3), stale: true, edited: true },
      { prompt: PROMPT(4), stale: false },
      { prompt: null, stale: true },
    ])
    const bodies = await mockGeneration(page, projectId, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ shots: await currentRows(projectId) }),
      })
    })

    await page.goto(`/projects/${projectId}/image_prompts`)
    await waitForHydration(page)

    // The bar counts only stale shots that have a prompt: 2, not 3.
    await expect(page.getByText('5 shots · 2 stale')).toBeVisible()
    const perShot = creditsFor({ step: 'image_prompts', operation: 'write_image_prompts', quantity: 1 })
    await expect(page.getByRole('button', { name: /Regenerate Stale/ })).toContainText(`${perShot * 2} cr`)
    await expect(page.getByRole('button', { name: /Regenerate All/ })).toContainText(`${perShot * 5} cr`)

    // Unedited, non-stale row: no dialog, one shot, retry:true.
    await page.getByRole('button', { name: /^Regenerate · \d+ credits$/ }).first().click()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ shotIds: [shotIds[0]], retry: true })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Regenerate Stale: no dialog; the two stale shots with prompts, never the ungenerated one.
    await page.getByRole('button', { name: /Regenerate Stale/ }).click()
    await expect.poll(() => bodies.length).toBe(2)
    expect(bodies[1].shotIds.sort()).toEqual([shotIds[1], shotIds[2]].sort())
    expect(bodies[1].retry).toBe(true)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The edited (and stale) row asks first, quotes the edit, and Cancel sends nothing.
    await page.locator('div', { hasText: /^Shot 3/ }).getByRole('button', { name: /Regenerate ·/ }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Regenerate Shot 3?')
    await expect(dialog).toContainText('Your version')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(bodies.length).toBe(2)

    // Regenerate All is always behind its dialog and includes the ungenerated shot.
    await page.getByRole('button', { name: /Regenerate All/ }).click()
    await expect(dialog).toContainText('Regenerate all prompts?')
    await dialog.getByRole('button', { name: 'Regenerate all' }).click()
    await expect.poll(() => bodies.length).toBe(3)
    expect(bodies[2].shotIds.sort()).toEqual([...shotIds].sort())
  })

  test('a 422 partial marks each card by what actually happened and offers one retry for just the failed shot', async ({
    page,
  }) => {
    const { projectId, shotIds } = await seed([
      { prompt: PROMPT(1), stale: true },
      { prompt: PROMPT(2), stale: true },
    ])
    const { data: keys } = await admin.from('shots').select('id, shot_key').eq('project_id', projectId)
    const keyOf = (id: string) => keys!.find((k) => k.id === id)!.shot_key

    const bodies = await mockGeneration(page, projectId, async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'partial',
          missingShotKeys: [keyOf(shotIds[1])],
          failedShotKeys: [],
          shots: await currentRows(projectId),
        }),
      })
    })

    await page.goto(`/projects/${projectId}/image_prompts`)
    await waitForHydration(page)
    await page.getByRole('button', { name: /Regenerate Stale/ }).click()

    await expect(page.getByText("1 of 2 prompts didn't regenerate")).toBeVisible()
    await expect(page.getByText('Shot 2 kept its previous prompt.')).toBeVisible()
    await expect(page.getByText('Updated', { exact: true })).toHaveCount(1)
    await expect(page.getByText('Kept previous', { exact: true })).toHaveCount(1)

    await page.getByRole('button', { name: /^Retry that one/ }).click()
    await expect.poll(() => bodies.length).toBe(2)
    expect(bodies[1]).toEqual({ shotIds: [shotIds[1]], retry: true })
  })

  test('a 402 shows the shared insufficient-balance banner with the route\'s own figures', async ({ page }) => {
    const { projectId } = await seed([{ prompt: PROMPT(1), stale: true }])
    await mockGeneration(page, projectId, async (route) => {
      await route.fulfill({
        status: 402,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'no', requiredCredits: 2, balanceCredits: 1 }),
      })
    })

    await page.goto(`/projects/${projectId}/image_prompts`)
    await waitForHydration(page)
    await page.getByRole('button', { name: /Regenerate Stale/ }).click()

    const banner = page.getByRole('alert').filter({ hasText: 'Not enough credits' })
    await expect(banner).toContainText('needs 2 credits')
    await expect(banner).toContainText('You have 1 credits available')
  })

  test('editing saves on blur through the real action: a change marks the prompt edited, an unchanged blur writes nothing', async ({
    page,
  }) => {
    const { projectId, shotIds } = await seed([{ prompt: PROMPT(1), stale: false }])
    await page.goto(`/projects/${projectId}/image_prompts`)
    await waitForHydration(page)

    const field = page.getByRole('textbox', { name: 'Image prompt' })
    await field.click()
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.waitForTimeout(500)
    let row = (await currentRows(projectId)).find((r) => r.id === shotIds[0])!
    expect(row.image_prompt_edited).toBe(false)
    expect(row.image_prompt).toBe(PROMPT(1))

    await field.fill('My own wording for this frame.')
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await expect(page.getByText('Edited by you')).toBeVisible()
    row = (await currentRows(projectId)).find((r) => r.id === shotIds[0])!
    expect(row.image_prompt).toBe('My own wording for this frame.')
    expect(row.image_prompt_edited).toBe(true)
    expect(row.image_prompt_stale).toBe(false)
  })

  test('arriving with no prompts and no earlier attempt generates once for every shot; a failed earlier attempt is never re-fired', async ({
    page,
  }) => {
    const first = await seed([{ prompt: null, stale: false }, { prompt: null, stale: false }], null)
    const bodies = await mockGeneration(page, first.projectId, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ shots: await currentRows(first.projectId) }),
      })
    })
    await page.goto(`/projects/${first.projectId}/image_prompts`)
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ shotIds: first.shotIds, retry: false })
    await page.waitForTimeout(1000)
    expect(bodies.length).toBe(1)

    const failed = await seed([{ prompt: null, stale: false }], 'failed')
    const failedBodies = await mockGeneration(page, failed.projectId, async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    })
    await page.goto(`/projects/${failed.projectId}/image_prompts`)
    await expect(page.getByText('No prompt yet', { exact: true })).toBeVisible()
    await page.waitForTimeout(1000)
    expect(failedBodies.length).toBe(0)
  })
})
