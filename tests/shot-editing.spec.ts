import { test, expect, type Page, type Locator } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'

let seq = 0
function nextShotIdentity() {
  seq++
  return { orderIndex: seq, shotKey: `ek${String(seq).padStart(3, '0')}` }
}

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Shot editing test',
      source_text: 'A short film for shot-editing tests.',
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

async function seedShot(projectId: string, overrides: Record<string, unknown> = {}) {
  const { orderIndex, shotKey } = nextShotIdentity()
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: orderIndex,
      shot_key: shotKey,
      voice_over: 'Original voiceover text.',
      visual_description: 'Original visual description.',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedCharacter(projectId: string, shotId: string, name: string) {
  const { data, error } = await admin
    .from('elements')
    .insert({ project_id: projectId, name, type: 'character' })
    .select('id')
    .single()
  expect(error).toBeNull()
  const elementId = data!.id as string

  const { error: bindError } = await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })
  expect(bindError).toBeNull()

  return elementId
}

async function readShot(shotId: string) {
  const { data } = await admin.from('shots').select('*').eq('id', shotId).single()
  return data
}

async function readProject(projectId: string) {
  const { data } = await admin.from('projects').select('*').eq('id', projectId).single()
  return data
}

// Clicking the collapsed card itself is the expand affordance (canvas: no dedicated
// "Expand" button - the whole card is role="button" with cursor:pointer). See the
// dedicated "clicking a collapsed card expands it" test below for the assertion this
// helper's behavior rests on.
async function expandFirstCard(page: Page) {
  await page.getByTestId('shot-card').first().click()
}

// The camera/dialogue-speaker selects are a from-scratch ARIA combobox+listbox (canvas
// section 10 - a native <select>'s open menu can't be restyled by CSS at all, so it had
// to be custom-built), not a native <select> - Playwright's .selectOption() only works
// on real form elements, so tests interact via role queries instead.
async function chooseOption(scope: Page | Locator, comboboxName: string, optionName: string) {
  await scope.getByRole('combobox', { name: comboboxName }).click()
  await scope.getByRole('option', { name: optionName, exact: true }).click()
}

test.describe('shot card editing', () => {
  test('clicking a collapsed card expands it', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench`)

    const card = page.getByTestId('shot-card').first()
    await expect(page.getByLabel('Voiceover')).not.toBeVisible()
    await card.click()
    await expect(page.getByLabel('Voiceover')).toBeVisible()
  })

  test('voiceover saves on blur, shows Saved, sets voiceover_stale and both prompt-stale flags, and preserves existing prompts', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, {
      image_prompt: 'an existing image prompt',
      video_prompt: 'an existing video prompt',
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const voiceoverField = page.getByLabel('Voiceover')
    await voiceoverField.fill('A brand new voiceover line.')
    await voiceoverField.blur()

    await expect(page.getByText('Saved').first()).toBeVisible()

    await expect
      .poll(async () => (await readShot(shotId))?.voice_over)
      .toBe('A brand new voiceover line.')

    const shotRow = await readShot(shotId)
    expect(shotRow?.image_prompt_stale).toBe(true)
    expect(shotRow?.video_prompt_stale).toBe(true)
    // Regression test for the old nulling behavior - the flag is set, the text survives.
    expect(shotRow?.image_prompt).toBe('an existing image prompt')
    expect(shotRow?.video_prompt).toBe('an existing video prompt')

    const projectRow = await readProject(projectId)
    expect(projectRow?.voiceover_stale).toBe(true)
  })

  test('visual description saves on blur and sets its two shot flags, but not voiceover_stale', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const descriptionField = page.getByLabel('Visual description')
    await descriptionField.fill('A brand new visual description.')
    await descriptionField.blur()

    await expect
      .poll(async () => (await readShot(shotId))?.visual_description)
      .toBe('A brand new visual description.')

    const shotRow = await readShot(shotId)
    expect(shotRow?.image_prompt_stale).toBe(true)
    expect(shotRow?.video_prompt_stale).toBe(true)

    const projectRow = await readProject(projectId)
    expect(projectRow?.voiceover_stale).toBe(false)
  })

  test('a blur with no change performs no write and marks nothing stale', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { voice_over: 'Unchanged voiceover text.' })
    const before = await readShot(shotId)

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const voiceoverField = page.getByLabel('Voiceover')
    await voiceoverField.click()
    await page.getByLabel('Visual description').click() // moves focus away without editing

    // Give any (incorrect) write a moment to land before asserting it didn't.
    await page.waitForTimeout(500)

    // No dedicated "write happened" signal to poll for (that's the point), so this
    // relies on the value and the flags a real write would always set together staying
    // exactly as seeded - every code path that writes voice_over also sets both prompt
    // stale flags in the same call, so unchanged flags are strong evidence no write fired.
    const after = await readShot(shotId)
    expect(after?.voice_over).toBe(before?.voice_over)
    expect(after?.image_prompt_stale).toBe(false)
    expect(after?.video_prompt_stale).toBe(false)
  })

  test('duration edit sets duration_locked but marks nothing stale', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { duration_sec: 2.0 })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await page.getByRole('button', { name: 'Increase duration' }).click()

    await expect.poll(async () => (await readShot(shotId))?.duration_sec).toBe(2.1)

    const shotRow = await readShot(shotId)
    expect(shotRow?.duration_locked).toBe(true)
    expect(shotRow?.image_prompt_stale).toBe(false)
    expect(shotRow?.video_prompt_stale).toBe(false)

    const projectRow = await readProject(projectId)
    expect(projectRow?.voiceover_stale).toBe(false)
  })

  test('duration stepper clamps to the active model bounds and steps by 0.1', async ({ page }) => {
    const projectId = await seedProject({ video_model: 'mochi-1' })
    await seedShot(projectId, { duration_sec: 5.3 })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByTestId('duration-value')).toHaveText('5.3s')
    await page.getByRole('button', { name: 'Increase duration' }).click()
    await expect(page.getByTestId('duration-value')).toHaveText('5.4s')
    // At the ceiling - plus is spent.
    await expect(page.getByRole('button', { name: 'Increase duration' })).toBeDisabled()
  })

  test('a saved duration outside the current model range renders amber and is not rewritten', async ({ page }) => {
    const projectId = await seedProject({ video_model: 'mochi-1' })
    const shotId = await seedShot(projectId, { duration_sec: 7.0, duration_locked: true })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByTestId('duration-value')).toHaveText('7.0s')
    await expect(page.getByText(/is longer than Mochi 1 allows/)).toBeVisible()
    // Plus is spent (no room above); nothing was auto-corrected on load.
    await expect(page.getByRole('button', { name: 'Increase duration' })).toBeDisabled()

    const shotRow = await readShot(shotId)
    expect(shotRow?.duration_sec).toBe(7)
  })

  test('duration stepper on a discrete model steps between exact allowed values only', async ({ page }) => {
    const projectId = await seedProject({ video_model: 'Kling 2.1' })
    await seedShot(projectId, { duration_sec: 5 })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByTestId('duration-value')).toHaveText('5.0s')
    await expect(page.getByRole('button', { name: 'Decrease duration' })).toBeDisabled()

    await page.getByRole('button', { name: 'Increase duration' }).click()
    // Kling 2.1 only renders 5s or 10s - the step must land exactly on 10.0s, never an
    // intermediate value like 5.1s.
    await expect(page.getByTestId('duration-value')).toHaveText('10.0s')
    await expect(page.getByRole('button', { name: 'Increase duration' })).toBeDisabled()

    await page.getByRole('button', { name: 'Decrease duration' }).click()
    await expect(page.getByTestId('duration-value')).toHaveText('5.0s')
  })

  test('a saved duration invalid for a discrete model renders amber and moves straight to the nearest allowed value', async ({
    page,
  }) => {
    const projectId = await seedProject({ video_model: 'Kling 2.1' })
    const shotId = await seedShot(projectId, { duration_sec: 7.3, duration_locked: true })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByTestId('duration-value')).toHaveText('7.3s')
    // Discrete-model copy states the allowed values, never a "between X and Y" range,
    // since that would be false for a model that only renders exact values.
    await expect(page.getByText(/5s or 10s/)).toBeVisible()

    // Nothing was auto-corrected on load.
    const beforeClick = await readShot(shotId)
    expect(beforeClick?.duration_sec).toBe(7.3)

    await page.getByRole('button', { name: 'Increase duration' }).click()
    await expect(page.getByTestId('duration-value')).toHaveText('10.0s')
    await expect.poll(async () => (await readShot(shotId))?.duration_sec).toBe(10)
  })

  test('many simultaneously out-of-range shots on a discrete model each render amber independently', async ({ page }) => {
    const projectId = await seedProject({ video_model: 'Kling 2.1' })
    for (let i = 0; i < 8; i++) {
      await seedShot(projectId, { duration_sec: 7.3, duration_locked: true })
    }

    await page.goto(`/projects/${projectId}/workbench`)

    const cards = page.getByTestId('shot-card')
    await expect(cards).toHaveCount(8)
    for (let i = 0; i < 8; i++) {
      await cards.nth(i).click()
    }

    await expect(page.getByTestId('duration-value')).toHaveCount(8)
    const values = await page.getByTestId('duration-value').allTextContents()
    expect(values.every((v) => v === '7.3s')).toBe(true)
    await expect(page.getByText(/5s or 10s/)).toHaveCount(8)

    // ProjectHeader's aggregate total still renders without throwing - it only reads
    // duration_sec/duration_locked, unaffected by per-model validity.
    await expect(page.getByText(/shots ·/)).toBeVisible()
  })

  test('a dialogue line persists only once both speaker and line are filled', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    await seedCharacter(projectId, shotId, 'Shah Jahan')

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await page.getByRole('button', { name: '+ Add line' }).click()

    const row = page.getByTestId('dialogue-row')
    await row.getByLabel('Line').fill('Let it be built of light.')
    await row.getByLabel('Line').blur()

    // Speaker not chosen yet - nothing should be stored.
    await page.waitForTimeout(500)
    let { data: rows } = await admin.from('shot_dialogue').select('*').eq('shot_id', shotId)
    expect(rows?.length ?? 0).toBe(0)

    await chooseOption(row, 'Speaker', 'Shah Jahan')

    await expect.poll(async () => {
      const result = await admin.from('shot_dialogue').select('*').eq('shot_id', shotId)
      rows = result.data
      return rows?.length ?? 0
    }).toBe(1)
    expect(rows?.[0].line).toBe('Let it be built of light.')

    const shotRow = await readShot(shotId)
    expect(shotRow?.video_prompt_stale).toBe(true)
  })

  // Regression coverage for a real bug: shot-card.tsx's per-field status map was
  // append-only, and nothing pruned a dialogue row's entry when the row was removed -
  // so a row removed while its last-reported status was still 'saving' left the header
  // rollup stuck showing "Saving…" forever, surviving even the row's own removal. The
  // fix (clearFieldStatus in shot-card.tsx, called from dialogue-section.tsx's two
  // removal handlers) prunes that entry at the moment of removal instead.
  test('adding a dialogue line leaves the header rollup resolved once the save settles', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    await seedCharacter(projectId, shotId, 'Shah Jahan')

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await page.getByRole('button', { name: '+ Add line' }).click()
    const row = page.getByTestId('dialogue-row')
    await row.getByLabel('Line').fill('Let it be built of light.')
    await row.getByLabel('Line').blur()
    await chooseOption(row, 'Speaker', 'Shah Jahan')

    await expect
      .poll(async () => {
        const result = await admin.from('shot_dialogue').select('id').eq('shot_id', shotId)
        return result.data?.length ?? 0
      })
      .toBe(1)

    // The rollup passes through 'saving' and briefly 'saved' before decaying - poll
    // past the 2s decay window to confirm it actually reaches 'quiet' rather than
    // getting stuck.
    await expect
      .poll(async () => page.getByTestId('card-save-rollup').getAttribute('data-rollup-kind'), { timeout: 5000 })
      .toBe('quiet')
  })

  test('removing a dialogue row shortly after its save completes leaves no residual status in the header rollup', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    await seedCharacter(projectId, shotId, 'Shah Jahan')

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await page.getByRole('button', { name: '+ Add line' }).click()
    const row = page.getByTestId('dialogue-row')
    await row.getByLabel('Line').fill('Let it be built of light.')
    await row.getByLabel('Line').blur()
    await chooseOption(row, 'Speaker', 'Shah Jahan')

    // Wait only for the save to actually land (the row is now a real saved row, not a
    // draft) - not for its 2s "Saved" indicator to decay. Removing here, inside that
    // decay window, is what the bug depended on: the row's own decay-to-idle timeout
    // never gets to fire and report back once the row is unmounted, so the header's
    // per-field entry was left stuck on 'saved' forever under the old, unpruned map.
    await expect
      .poll(async () => (await admin.from('shot_dialogue').select('id').eq('shot_id', shotId)).data?.length ?? 0)
      .toBe(1)

    await row.getByRole('button', { name: 'Remove dialogue row' }).click()

    await expect(page.getByTestId('dialogue-row')).toHaveCount(0)
    await expect(page.getByTestId('card-save-rollup')).toHaveAttribute('data-rollup-kind', 'quiet')
    // Just confirms the delete round trip itself eventually lands - not part of the
    // regression this test targets (the rollup assertion above already covers that), so
    // give it more headroom than the default 5s against a shared, possibly busy test DB.
    await expect
      .poll(async () => (await admin.from('shot_dialogue').select('id').eq('shot_id', shotId)).data?.length ?? 0, {
        timeout: 15000,
      })
      .toBe(0)
  })

  test('a dialogue row with an unbound speaker renders read-only', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    // A character that exists in the project but is never bound to this shot.
    const { data: element, error } = await admin
      .from('elements')
      .insert({ project_id: projectId, name: 'Unbound Character', type: 'character' })
      .select('id')
      .single()
    expect(error).toBeNull()

    const { error: dialogueError } = await admin.from('shot_dialogue').insert({
      project_id: projectId,
      shot_id: shotId,
      element_id: element!.id,
      line: 'A line from someone not bound here.',
      order_index: 0,
    })
    expect(dialogueError).toBeNull()

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const row = page.getByTestId('dialogue-row')
    await expect(row.getByTestId('dialogue-speaker-readonly')).toHaveText('Unbound Character')
    await expect(row.locator('select')).toHaveCount(0)
  })

  test('+ Add line is disabled with a reason when no characters are bound', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByText('Bind a character to this shot first')).toBeVisible()
    await expect(page.getByRole('button', { name: '+ Add line' })).toBeDisabled()
  })

  test('no action in this task writes current_step or furthest_step', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    await seedCharacter(projectId, shotId, 'Narrator')
    const before = await readProject(projectId)

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await page.getByLabel('Voiceover').fill('Edited for the step-tracking check.')
    await page.getByLabel('Voiceover').blur()
    await expect(page.getByText('Saved').first()).toBeVisible()

    await page.getByRole('button', { name: 'Increase duration' }).click()
    await expect.poll(async () => (await readShot(shotId))?.duration_locked).toBe(true)

    const after = await readProject(projectId)
    expect(after?.current_step).toBe(before?.current_step)
    expect(after?.furthest_step).toBe(before?.furthest_step)
  })
})
