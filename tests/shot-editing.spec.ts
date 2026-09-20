import { test, expect, type Page, type Locator, type Request } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

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

  // canvas: "08 Workbench" / "09A Card at rest" - the expanded card's container is
  // border:1px solid var(--accent), distinct from the resting border-subtle and the
  // failed border-status-failed-line.
  test('the expanded card carries the accent border; a collapsed card does not', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench`)

    const card = page.getByTestId('shot-card').first()
    await expect(card).not.toHaveClass(/\bborder-accent\b/)

    await card.click()
    await expect(card).toHaveClass(/\bborder-accent\b/)
  })

  test('expanding a card collapses whichever other card was open (accordion)', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench`)
    const cards = page.getByTestId('shot-card')

    await cards.nth(0).click()
    await expect(cards.nth(0).getByLabel('Voiceover')).toBeVisible()

    await cards.nth(1).click()
    await expect(cards.nth(1).getByLabel('Voiceover')).toBeVisible()
    await expect(cards.nth(0).getByLabel('Voiceover')).not.toBeVisible()
  })

  test('typing into voiceover, then expanding a different card, still saves the value', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    await seedShot(projectId)

    await page.goto(`/projects/${projectId}/workbench`)
    const cards = page.getByTestId('shot-card')

    await cards.nth(0).click()
    const voiceoverField = cards.nth(0).getByLabel('Voiceover')
    await voiceoverField.fill('Edited but never blurred by hand.')
    // No explicit .blur() - this exercises the real interaction: clicking straight into
    // a different card's collapsed header, which must blur the focused field (native
    // focus-management ordering) before the accordion's own click handler collapses it.
    await cards.nth(1).click()

    await expect
      .poll(async () => (await readShot(shotId))?.voice_over)
      .toBe('Edited but never blurred by hand.')
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

  test('blurring an empty voiceover with no dialogue shows the error below the field only, and writes nothing', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { voice_over: 'Original voiceover text.' })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const voiceoverField = page.getByLabel('Voiceover')
    await voiceoverField.fill('')
    await voiceoverField.blur()

    const message = 'A shot needs narration or a dialogue line — otherwise it plays silent. Add one, or ask the agent to write it.'
    // Exactly once - validation never touches the save-status channel, so the header
    // slot (which used to duplicate this as "Voiceover can't be empty") must stay silent.
    await expect(page.getByText(message)).toHaveCount(1)
    await expect(page.getByText("Voiceover can't be empty")).toHaveCount(0)
    // A validation rejection has no Retry - there is nothing to retry until the value
    // itself changes.
    await expect(page.getByRole('button', { name: 'Retry' })).not.toBeVisible()
    // Never wrote the empty value - this never even reached the network.
    await expect.poll(async () => (await readShot(shotId))?.voice_over).toBe('Original voiceover text.')
  })

  test('the voiceover error clears when the original text is pasted back, with no extra keystroke needed', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await seedShot(projectId, { voice_over: 'Original voiceover text.' })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const voiceoverField = page.getByLabel('Voiceover')
    await voiceoverField.fill('')
    await voiceoverField.blur()
    await expect(page.getByText(/A shot needs narration or a dialogue line/)).toBeVisible()

    // Simulates "cut, then paste the identical text back" - the value returns to exactly
    // what was persisted, which must not stop the error from being re-evaluated and cleared.
    await voiceoverField.fill('Original voiceover text.')
    await voiceoverField.blur()
    await expect(page.getByText(/A shot needs narration or a dialogue line/)).not.toBeVisible()
  })

  test('adding a dialogue line clears a showing voiceover error, even though voiceover itself is never touched again', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { voice_over: 'Original voiceover text.' })
    await seedCharacter(projectId, shotId, 'Shah Jahan')

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const voiceoverField = page.getByLabel('Voiceover')
    await voiceoverField.fill('')
    await voiceoverField.blur()
    await expect(page.getByText(/A shot needs narration or a dialogue line/)).toBeVisible()

    await page.getByRole('button', { name: '+ Add line' }).click()
    const row = page.getByTestId('dialogue-row')
    await row.getByLabel('Line').fill('Let it be built of light.')
    await chooseOption(row, 'Speaker', 'Shah Jahan')

    await expect
      .poll(async () => {
        const { data } = await admin.from('shot_dialogue').select('id').eq('shot_id', shotId)
        return data?.length ?? 0
      })
      .toBe(1)

    await expect(page.getByText(/A shot needs narration or a dialogue line/)).not.toBeVisible()
  })

  test('an empty voiceover saves normally when the shot already has a dialogue line', async ({ page }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { voice_over: 'Original voiceover text.' })
    const elementId = await seedCharacter(projectId, shotId, 'Narrator')
    const { error: dialogueError } = await admin
      .from('shot_dialogue')
      .insert({ project_id: projectId, shot_id: shotId, element_id: elementId, line: 'A spoken line.', order_index: 0 })
    expect(dialogueError).toBeNull()

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const voiceoverField = page.getByLabel('Voiceover')
    await voiceoverField.fill('')
    await voiceoverField.blur()

    await expect(page.getByText('Saved').first()).toBeVisible()
    await expect.poll(async () => (await readShot(shotId))?.voice_over).toBe('')
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

  test('blurring an empty visual description shows a validation error below the field and writes nothing', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, { visual_description: 'Original visual description.' })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    const descriptionField = page.getByLabel('Visual description')
    await descriptionField.fill('')
    await descriptionField.blur()

    await expect(page.getByText(/A shot needs a visual description/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry' })).not.toBeVisible()
    await expect.poll(async () => (await readShot(shotId))?.visual_description).toBe('Original visual description.')
  })

  test('a shot loaded with an empty visual description shows its error on mount, with no interaction', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await seedShot(projectId, { visual_description: '' })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByText(/A shot needs a visual description/)).toBeVisible()
  })

  test('a shot loaded with a valid visual description shows no error on mount', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId, { visual_description: 'Original visual description.' })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByText(/A shot needs a visual description/)).not.toBeVisible()
  })

  test('a shot loaded with an empty voiceover and no dialogue shows its error on mount, with no interaction', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await seedShot(projectId, { voice_over: '' })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByText(/A shot needs narration or a dialogue line/)).toBeVisible()
  })

  test('a shot loaded with a valid voiceover shows no error on mount', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId, { voice_over: 'Original voiceover text.' })

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    await expect(page.getByText(/A shot needs narration or a dialogue line/)).not.toBeVisible()
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

  // Cards are an accordion (only one expanded at a time - see the accordion test above),
  // so "independently" is checked one at a time rather than all expanded at once: each
  // shot's amber-invalid-duration render must not depend on any sibling's state.
  test('out-of-range shots on a discrete model each render amber independently', async ({ page }) => {
    const projectId = await seedProject({ video_model: 'Kling 2.1' })
    for (let i = 0; i < 8; i++) {
      await seedShot(projectId, { duration_sec: 7.3, duration_locked: true })
    }

    await page.goto(`/projects/${projectId}/workbench`)

    const cards = page.getByTestId('shot-card')
    await expect(cards).toHaveCount(8)
    for (let i = 0; i < 8; i++) {
      await cards.nth(i).click()
      await expect(cards.nth(i).getByTestId('duration-value')).toHaveText('7.3s')
      await expect(cards.nth(i).getByText(/5s or 10s/)).toBeVisible()
    }

    // ProjectHeader's aggregate total still renders without throwing - it only reads
    // duration_sec/duration_locked, unaffected by per-model validity.
    await expect(page.getByText(/shots$/)).toBeVisible()
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

    // The action inserts the row and THEN marks the video prompt stale, as a separate write -
    // so the flag is set a moment after the row is visible. Wait for it; reading it the
    // instant the row appears races that second write.
    await expect.poll(async () => (await readShot(shotId))?.video_prompt_stale).toBe(true)
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

  // A new line is a local draft until its first save returns the row's id. Removing it in
  // that window used to delete only the draft: the save still landed, and the line came back
  // (in the database, and in the list once the response arrived). The window is a few
  // hundred ms in real life, so these tests HOLD the save request to make it deterministic.
  //
  // `failFollowUps` makes every server action other than the held save fail, which is what
  // the follow-up delete is. `deleteAttempts` counts them, so a test can assert the app
  // actually tried to delete rather than inferring it from the end state.
  async function holdDialogueSave(page: Page, lineText: string, opts: { failFollowUps?: boolean } = {}) {
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    let heldRequest: Request | null = null
    let deleteAttempts = 0
    await page.route('**/projects/*/workbench', async (route) => {
      const request = route.request()
      const isAction = request.method() === 'POST' && !!request.headers()['next-action']
      if (isAction && (request.postData() ?? '').includes(lineText)) {
        heldRequest = request
        await released
      } else if (isAction && heldRequest && opts.failFollowUps) {
        deleteAttempts++
        await route.abort()
        return
      } else if (isAction && heldRequest) {
        deleteAttempts++
      }
      await route.continue()
    })
    return {
      /** Lets the held save through and resolves once the server has answered it. */
      async releaseAndAwaitSave() {
        const answered = page.waitForResponse((response) => response.request() === heldRequest)
        release()
        await answered
      },
      wasHeld: () => heldRequest !== null,
      deleteAttempts: () => deleteAttempts,
    }
  }

  async function addLineAndHoldItsSave(page: Page, projectId: string, lineText: string) {
    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)
    await page.getByRole('button', { name: '+ Add line' }).click()
    const row = page.getByTestId('dialogue-row')
    await row.getByLabel('Line').fill(lineText)
    await row.getByLabel('Line').blur()
    await chooseOption(row, 'Speaker', 'Shah Jahan')
    return row
  }

  test('removing a new line while its first save is still in flight removes it for good - it does not come back', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    await seedCharacter(projectId, shotId, 'Shah Jahan')
    const LINE = 'Held in flight, then removed.'
    const hold = await holdDialogueSave(page, LINE)
    const row = await addLineAndHoldItsSave(page, projectId, LINE)
    await expect.poll(() => hold.wasHeld()).toBe(true)

    // The save is in flight and has not reached the server. Remove the still-draft row.
    await row.getByRole('button', { name: 'Remove dialogue row' }).click()
    await expect(page.getByTestId('dialogue-row')).toHaveCount(0)

    // The save lands. The person already removed the line, so it must be deleted - and once
    // the server has answered, the database is the judge: a stored row means it came back.
    await hold.releaseAndAwaitSave()
    await expect
      .poll(async () => (await admin.from('shot_dialogue').select('id').eq('shot_id', shotId)).data?.length ?? 0, {
        timeout: 15000,
      })
      .toBe(0)
    await expect(page.getByTestId('dialogue-row')).toHaveCount(0)
    await expect(page.getByTestId('card-save-rollup')).toHaveAttribute('data-rollup-kind', 'quiet')
    expect(hold.deleteAttempts()).toBe(1)
  })

  test('if that delete cannot be completed, the line reappears so the list still matches what is stored', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId)
    await seedCharacter(projectId, shotId, 'Shah Jahan')
    const LINE = 'Held in flight, delete fails.'
    const hold = await holdDialogueSave(page, LINE, { failFollowUps: true })
    const row = await addLineAndHoldItsSave(page, projectId, LINE)
    await expect.poll(() => hold.wasHeld()).toBe(true)
    await row.getByRole('button', { name: 'Remove dialogue row' }).click()
    await expect(page.getByTestId('dialogue-row')).toHaveCount(0)

    await hold.releaseAndAwaitSave()
    // The app tried to delete the stored row, could not, and shows it again rather than
    // hiding a line that is still there.
    await expect.poll(() => hold.deleteAttempts()).toBe(1)
    await expect(page.getByTestId('dialogue-row')).toHaveCount(1, { timeout: 15000 })
    expect(((await admin.from('shot_dialogue').select('id').eq('shot_id', shotId)).data ?? []).length).toBe(1)
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

// C5 Task 8: updateShotVoiceOver/updateShotVisualDescription/updateShotDuration/
// updateCameraField/saveDialogueLine/deleteDialogueLine had no server-side lock check at
// all before this task - only the UI hid their controls (server-side coverage now lives
// in actions.ts's isWorkbenchLockedForProject helper, added alongside the UI change
// below). This asserts through the real browser rather than a direct import of
// workbench/actions.ts (the way shot-deletion.spec.ts calls deleteShotForUser): once
// locked, every one of these fields/controls renders inert and no write is reachable
// from the UI at all - the same "view only" wiring exercised at a coarser grain by
// shots-tab.tsx's ReadOnlyBanner (already covered in agent-chat-panel.spec.ts).
test.describe('shot fields are inert once the workbench is locked', () => {
  test('voiceover, visual description, duration, camera and dialogue all render read-only, and no field writes', async ({
    page,
  }) => {
    const projectId = await seedProject({ furthest_step: stepIndex('storyboard') })
    const shotId = await seedShot(projectId, {
      voice_over: 'Locked voiceover text.',
      visual_description: 'Locked visual description.',
      duration_sec: 3.0,
      shot_size: 'wide',
      shot_size_origin: 'auto',
    })
    const elementId = await seedCharacter(projectId, shotId, 'Locked Speaker')
    const { error: dialogueError } = await admin
      .from('shot_dialogue')
      .insert({ project_id: projectId, shot_id: shotId, element_id: elementId, line: 'Locked line.', order_index: 0 })
    expect(dialogueError).toBeNull()

    await page.goto(`/projects/${projectId}/workbench`)
    await expandFirstCard(page)

    // No editable control reaches the DOM at all - not merely disabled.
    await expect(page.getByLabel('Voiceover')).toHaveCount(0)
    await expect(page.getByLabel('Visual description')).toHaveCount(0)
    await expect(page.getByText('Locked voiceover text.')).toBeVisible()
    await expect(page.getByText('Locked visual description.')).toBeVisible()

    await expect(page.getByRole('button', { name: 'Increase duration' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Decrease duration' })).toHaveCount(0)

    await expect(page.getByRole('combobox', { name: 'Shot size' })).toHaveCount(0)

    await expect(page.getByRole('button', { name: '+ Add line' })).toHaveCount(0)

    const after = await readShot(shotId)
    expect(after?.voice_over).toBe('Locked voiceover text.')
    expect(after?.visual_description).toBe('Locked visual description.')
    expect(after?.duration_sec).toBe(3.0)
    expect(after?.shot_size).toBe('wide')
    const { data: dialogueRows } = await admin.from('shot_dialogue').select('id').eq('shot_id', shotId)
    expect(dialogueRows ?? []).toHaveLength(1)
  })
})
