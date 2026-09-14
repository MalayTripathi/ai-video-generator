import { test, expect, type Page } from '@playwright/test'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { creditsFor } from '../src/lib/config/credits'

// C5 Task 7 - Assets tab UI. Business-logic coverage (create/rename/delete/bind-block,
// upload/generate/remove, signed-URL batch+single re-sign) already lives in
// elements-read.spec.ts / elements-write.spec.ts / elements-reference.spec.ts /
// elements-reference-generation.spec.ts, all injecting fakes at the logic layer. This
// file drives the real UI instead, so it never clicks Generate (the real route calls a
// real, un-fakeable OpenAI gateway through the browser and would spend real money) -
// upload is safe to exercise for real since it is free and local (sharp-only, no
// provider call).

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Assets tab test',
      source_text: 'A short film for Assets-tab UI tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
      video_model: 'mochi-1',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = data!.id as string

  // Prevents ShotsProvider's fire-once shot-generation trigger from firing - these
  // tests only care about the Assets tab, same reasoning as shot-editing.spec.ts's
  // seedProject.
  const { error: generationError } = await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    state: 'succeeded',
  })
  expect(generationError).toBeNull()

  return projectId
}

async function seedElement(projectId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('elements')
    .insert({ project_id: projectId, name: `Element ${crypto.randomUUID().slice(0, 8)}`, type: 'character', ...overrides })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: 0,
      shot_key: `t${Math.random().toString(36).slice(2, 6)}`,
      voice_over: 'Placeholder voice-over.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function readElement(elementId: string) {
  const { data } = await admin.from('elements').select('*').eq('id', elementId).single()
  return data
}

// The card's persisted-name attribute (not text content) - stays stable even mid-edit,
// when the name moves from a text button into an <input>'s value and a text-based
// filter locator would stop matching anything.
function elementCard(page: Page, name: string) {
  return page.locator(`[data-testid="element-card"][data-element-name="${name}"]`)
}

async function pngBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .png()
    .toBuffer()
}

test.describe('Assets tab', () => {
  test('renders characters, locations, and props with correct counts', async ({ page }) => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'Shah Jahan', type: 'character', description: 'The emperor.' })
    await seedElement(projectId, { name: 'Taj Mahal', type: 'location', description: 'The mausoleum.' })

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)

    await expect(elementCard(page, 'Shah Jahan')).toBeVisible()
    await expect(elementCard(page, 'Taj Mahal')).toBeVisible()
    await expect(page.locator('[data-testid="element-group"][data-element-type="character"]')).toContainText('1')
    await expect(page.locator('[data-testid="element-group"][data-element-type="location"]')).toContainText('1')
  })

  test('inline create adds a new element to the right group without a modal', async ({ page }) => {
    const projectId = await seedProject()
    await page.goto(`/projects/${projectId}/workbench?tab=assets`)

    const propGroup = page.locator('[data-testid="element-group"][data-element-type="prop"]')
    await propGroup.getByTestId('add-element-card').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await propGroup.getByPlaceholder('Prop name').fill('Scaffolding')
    await propGroup.getByPlaceholder('Description — what should it look like?').fill('Bamboo scaffolding.')
    await propGroup.getByRole('button', { name: 'Add' }).click()

    await expect(elementCard(page, 'Scaffolding')).toBeVisible()
    const { data } = await admin.from('elements').select('id, name, type').eq('project_id', projectId).eq('name', 'Scaffolding').single()
    expect(data?.type).toBe('prop')
  })

  test('inline edit saves a renamed name and description in place', async ({ page }) => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Original Name', description: 'Original description.' })

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    const card = elementCard(page, 'Original Name')
    await card.getByText('Original Name', { exact: true }).click()

    await card.getByPlaceholder('Name').fill('Renamed')
    await card.getByPlaceholder('Description — what should it look like?').fill('New description.')
    await card.getByRole('button', { name: 'Save' }).click()

    await expect(elementCard(page, 'Renamed')).toBeVisible()
    await expect.poll(async () => (await readElement(elementId))?.name).toBe('Renamed')
    await expect.poll(async () => (await readElement(elementId))?.description).toBe('New description.')
  })

  test('cancel discards an in-progress edit', async ({ page }) => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Keep Me' })

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    const card = elementCard(page, 'Keep Me')
    await card.getByText('Keep Me', { exact: true }).click()
    await card.getByPlaceholder('Name').fill('Should Not Save')
    await card.getByRole('button', { name: 'Cancel' }).click()

    await expect(elementCard(page, 'Keep Me')).toBeVisible()
    await expect(page.getByText('Should Not Save')).toHaveCount(0)
    expect((await readElement(elementId))?.name).toBe('Keep Me')
  })

  test('deleting an unbound element shows the ordinary confirm and removes it', async ({ page }) => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Unbound Prop', type: 'prop' })

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    const card = elementCard(page, 'Unbound Prop')
    await card.getByTestId('delete-element-trigger').click()

    const confirmDialog = page.getByRole('dialog')
    await expect(confirmDialog).toContainText('Delete Unbound Prop?')
    await confirmDialog.getByRole('button', { name: 'Delete element' }).click()

    await expect(elementCard(page, 'Unbound Prop')).toHaveCount(0)
    await expect.poll(async () => (await readElement(elementId))?.deleted_at).not.toBeNull()
  })

  test('deleting a bound element shows the blocked modal listing the real shots, with no force option', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Bound Character', type: 'character' })
    const shot1 = await seedShot(projectId, { order_index: 0, visual_description: 'Wide shot of the hero.' })
    const shot2 = await seedShot(projectId, { order_index: 1, visual_description: 'Close up of the hero.' })
    await admin.from('shot_elements').insert([
      { shot_id: shot1, element_id: elementId },
      { shot_id: shot2, element_id: elementId },
    ])

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    const card = elementCard(page, 'Bound Character')
    await card.getByTestId('delete-element-trigger').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Delete Bound Character?')
    await dialog.getByRole('button', { name: 'Delete element' }).click()

    await expect(dialog).toContainText('Bound Character')
    await expect(dialog).toContainText('Shot 1')
    await expect(dialog).toContainText('Shot 2')
    await expect(dialog.getByRole('button', { name: 'Delete element' })).toHaveCount(0)

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(elementCard(page, 'Bound Character')).toBeVisible()
    expect((await readElement(elementId))?.deleted_at).toBeNull()
  })

  test('the style card has no add card and no delete control', async ({ page }) => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'House Style', type: 'style', description: 'Warm, painterly.' })

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    const styleGroup = page.locator('[data-testid="element-group"][data-element-type="style"]')

    await expect(styleGroup.getByTestId('element-card')).toHaveCount(1)
    await expect(styleGroup.getByTestId('add-element-card')).toHaveCount(0)
    await expect(styleGroup.getByTestId('delete-element-trigger')).toHaveCount(0)
  })

  test('uploading a reference image flips a no-reference card to reference-set', async ({ page }) => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'Fresh Element', type: 'prop' })

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    const card = elementCard(page, 'Fresh Element')
    await expect(card.getByText('Upload')).toBeVisible()

    await card
      .getByTestId('element-reference-file-input')
      .setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: await pngBuffer() })

    await expect(card.getByText('Reference set')).toBeVisible({ timeout: 10000 })
    await expect(card.getByText('Edit')).toBeVisible()
  })

  test('the usage tag reads "Not used" for an unbound element and "In use" once a shot binds it', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Loose Prop', type: 'prop' })
    const shot = await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    const card = elementCard(page, 'Loose Prop')
    await expect(card.getByText('Not used')).toBeVisible()
    await expect(card.getByText('In use')).toHaveCount(0)

    await admin.from('shot_elements').insert({ shot_id: shot, element_id: elementId })
    await page.reload()

    const reloadedCard = elementCard(page, 'Loose Prop')
    await expect(reloadedCard.getByText('In use')).toBeVisible()
    await expect(reloadedCard.getByText('Not used')).toHaveCount(0)
  })

  test('a dialogue-only binding (no shot_elements row) still reads "In use"', async ({ page }) => {
    const projectId = await seedProject()
    const elementId = await seedElement(projectId, { name: 'Speaking Only', type: 'character' })
    const shot = await seedShot(projectId)
    const { error } = await admin
      .from('shot_dialogue')
      .insert({ shot_id: shot, project_id: projectId, element_id: elementId, line: 'Hello.', order_index: 0 })
    expect(error).toBeNull()

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    await expect(elementCard(page, 'Speaking Only').getByText('In use')).toBeVisible()
  })

  test('the Edit menu on a reference-set card offers Regenerate, not Generate, priced from config', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await seedElement(projectId, { name: 'Fresh Element', type: 'prop' })

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)
    const card = elementCard(page, 'Fresh Element')
    await card
      .getByTestId('element-reference-file-input')
      .setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: await pngBuffer() })
    await expect(card.getByText('Edit')).toBeVisible({ timeout: 10000 })

    await card.getByText('Edit').click()
    const menu = page.getByRole('menu')
    await expect(menu.getByText('Regenerate')).toBeVisible()
    await expect(menu.getByText('Generate', { exact: true })).toHaveCount(0)
    const expectedCredits = creditsFor({ step: 'workbench', operation: 'generate_element_reference', quantity: 1 })
    await expect(menu).toContainText(`${expectedCredits} cr`)
  })

  test('the footer names shot-bound elements without a reference image, excluding unbound ones', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shot = await seedShot(projectId)
    const boundOne = await seedElement(projectId, { name: 'No Ref One', type: 'prop' })
    const boundTwo = await seedElement(projectId, { name: 'No Ref Two', type: 'prop' })
    await seedElement(projectId, { name: 'Unbound No Ref', type: 'prop' })
    await admin.from('shot_elements').insert([
      { shot_id: shot, element_id: boundOne },
      { shot_id: shot, element_id: boundTwo },
    ])

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)

    const footerWarning = page.getByTestId('workbench-footer-warning')
    await expect(footerWarning).toContainText('2 elements without a reference image')
    await expect(footerWarning).toContainText('No Ref One')
    await expect(footerWarning).toContainText('No Ref Two')
    await expect(footerWarning).not.toContainText('Unbound No Ref')
  })

  // C5 Task 8: once furthest_step reaches the storyboard boundary, Shots goes read-only
  // but Assets stays fully live - reached from Step 3's element picker. Canvas: "12G
  // Assets live, shots locked".
  test('past the storyboard lock, Shots reads locked in the tab bar while Assets stays fully editable', async ({
    page,
  }) => {
    const projectId = await seedProject({ furthest_step: stepIndex('storyboard') })
    const elementId = await seedElement(projectId, { name: 'Pre-existing Prop', type: 'prop' })

    await page.goto(`/projects/${projectId}/workbench?tab=assets`)

    // The Shots tab item is still a real, clickable link (reading is never locked) but
    // carries the locked treatment - tertiary ink, same class the canvas specifies.
    const shotsTabLink = page.getByRole('link', { name: /Shots/ })
    await expect(shotsTabLink).toHaveClass(/text-text-tertiary/)
    await expect(shotsTabLink).toBeEnabled()

    // The new banner explains the split, only on the Assets side.
    await expect(page.getByText('Shots view only')).toBeVisible()
    await expect(page.getByText(/Assets stay editable/)).toBeVisible()

    // Real writes still succeed, server-side, in this state: create, rename, delete.
    const propGroup = page.locator('[data-testid="element-group"][data-element-type="prop"]')
    await propGroup.getByTestId('add-element-card').click()
    await propGroup.getByPlaceholder('Prop name').fill('Added While Locked')
    await propGroup.getByPlaceholder('Description — what should it look like?').fill('Created past the lock.')
    await propGroup.getByRole('button', { name: 'Add' }).click()
    await expect(elementCard(page, 'Added While Locked')).toBeVisible()
    const { data: created } = await admin
      .from('elements')
      .select('id')
      .eq('project_id', projectId)
      .eq('name', 'Added While Locked')
      .single()
    expect(created).not.toBeNull()

    const card = elementCard(page, 'Pre-existing Prop')
    await card.getByText('Pre-existing Prop', { exact: true }).click()
    await card.getByPlaceholder('Name').fill('Renamed While Locked')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(elementCard(page, 'Renamed While Locked')).toBeVisible()
    await expect.poll(async () => (await readElement(elementId))?.name).toBe('Renamed While Locked')

    await elementCard(page, 'Renamed While Locked').getByTestId('delete-element-trigger').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete element' }).click()
    await expect(elementCard(page, 'Renamed While Locked')).toHaveCount(0)
    await expect.poll(async () => (await readElement(elementId))?.deleted_at).not.toBeNull()
  })
})
