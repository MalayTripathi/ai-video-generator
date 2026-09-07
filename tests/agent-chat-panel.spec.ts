import { test, expect, type Page, type Route } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'

let seq = 0
function nextShotIdentity() {
  seq++
  return { orderIndex: seq, shotKey: `ac${String(seq).padStart(3, '0')}` }
}

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Agent chat panel test',
      source_text: 'A short film for agent-chat-panel tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
      video_model: 'mochi-1',
      furthest_step: 2,
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
  return { shotId: data!.id as string, shotKey }
}

function sseBody(events: Array<{ type: string; [key: string]: unknown }>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

// Mocks the agent route once, capturing every request body it receives. `events` is
// what the mocked turn emits; an empty array (the default) closes the stream immediately
// with no `settled` at all, exercising the dropped-stream path.
async function mockAgentRoute(
  page: Page,
  events: Array<{ type: string; [key: string]: unknown }>,
  options: { delayMs?: number } = {}
) {
  const requestBodies: { content: string; clientId: string }[] = []
  await page.route('**/api/projects/*/agent', async (route: Route) => {
    requestBodies.push(route.request().postDataJSON())
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(events) })
  })
  return requestBodies
}

async function sendMessage(page: Page, content: string) {
  await page.getByLabel('Ask for a change').fill(content)
  await page.getByRole('button', { name: 'Send' }).click()
}

test.describe('agent chat panel', () => {
  test('mints a client_id once and reuses it on retry', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    const requestBodies = await mockAgentRoute(page, []) // no settled -> dropped -> error + Retry

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'make it shorter')

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(requestBodies).toHaveLength(1)
    const firstClientId = requestBodies[0].clientId
    expect(typeof firstClientId).toBe('string')
    expect(firstClientId.length).toBeGreaterThan(0)

    await page.getByRole('button', { name: 'Retry' }).last().click()
    await expect(page.getByRole('button', { name: 'Retry' }).last()).toBeVisible()
    await expect.poll(() => requestBodies.length).toBe(2)
    expect(requestBodies[1].clientId).toBe(firstClientId)
    expect(requestBodies[1].content).toBe(requestBodies[0].content)
  })

  test('streamed text deltas accumulate into the agent bubble, and tool/refusal/error render distinctly', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const { shotKey } = await seedShot(projectId)
    await mockAgentRoute(page, [
      { type: 'turn_started' },
      { type: 'text_delta', text: 'Cutting the ' },
      { type: 'text_delta', text: 'voiceover down.' },
      { type: 'tool_completed', label: 'Updated Shot 1', shotKey },
      { type: 'refusal', label: "I can't delete shots - use the bin on the shot itself." },
      { type: 'error', message: 'Shot 9 not found' },
      { type: 'settled', content: 'Cutting the voiceover down.' },
    ])

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'tighten shot 1')

    await expect(page.getByText('Cutting the voiceover down.')).toBeVisible()
    const toolLine = page.locator('[data-message-kind="tool_done"]', { hasText: 'Updated Shot 1' })
    await expect(toolLine).toBeVisible()

    const refusal = page.locator('[data-message-kind="refusal"]')
    const error = page.locator('[data-message-kind="error"]')
    await expect(refusal).toBeVisible()
    await expect(error).toBeVisible()
    // Refusal and error must never share a treatment - see docs/decisions.md.
    await expect(refusal.getByRole('button', { name: 'Retry' })).toHaveCount(0)
    await expect(error.getByText('Retry')).toBeVisible()
  })

  test('renders the cost line for a regenerate_all_shots completion, separate from its progress line', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    await mockAgentRoute(page, [
      { type: 'turn_started' },
      { type: 'tool_completed', label: 'Regenerated all shots ($0.42)' },
      { type: 'settled', content: 'Rebuilt the shot list from your brief.' },
    ])

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'start over')

    await expect(page.locator('[data-message-kind="tool_done"]', { hasText: 'Regenerated all shots' })).toBeVisible()
    const cost = page.locator('[data-message-kind="cost"]')
    await expect(cost).toBeVisible()
    await expect(cost.getByText('$0.42')).toBeVisible()
  })

  test('input disables while a turn runs and re-enables on settle', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    await mockAgentRoute(page, [{ type: 'settled', content: 'Done.' }], { delayMs: 500 })

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'do something')

    await expect(page.getByText(/you can.t send until this finishes/)).toBeVisible()
    await expect(page.getByLabel('Ask for a change')).toHaveCount(0)

    await expect(page.getByLabel('Ask for a change')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  })

  test('a card named by a tool event locks while the turn runs; other cards stay editable', async ({ page }) => {
    const projectId = await seedProject()
    const shotA = await seedShot(projectId, { voice_over: 'Shot A voiceover.' })
    await seedShot(projectId, { voice_over: 'Shot B voiceover.' })

    await mockAgentRoute(page, [
      { type: 'turn_started' },
      { type: 'tool_completed', label: 'Updated Shot 1', shotKey: shotA.shotKey },
      { type: 'settled', content: 'Updated shot 1.' },
    ])

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'tighten shot 1')

    const cardA = page.locator(`[data-shot-key="${shotA.shotKey}"]`)
    const cardB = page.getByTestId('shot-card').filter({ hasText: 'Shot B voiceover.' })
    await expect(cardA).toHaveAttribute('data-locked', 'true')
    await expect(page.getByText('Agent is rewriting this shot')).toBeVisible()
    await expect(cardB).toHaveAttribute('data-locked', 'false')

    // The other card stays fully editable while shotA is locked.
    await cardB.click()
    await expect(page.getByLabel('Voiceover')).toBeEditable()

    await expect(cardA).toHaveAttribute('data-locked', 'false', { timeout: 10000 })
  })

  test('on settle, a named shot is refetched and its saved indicator clears; a focused field is not overwritten', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const touched = await seedShot(projectId, { visual_description: 'Original visual description.' })
    const untouched = await seedShot(projectId, { visual_description: 'Untouched visual description.' })

    // The mocked route performs the same DB write the real server would have made,
    // so router.refresh() (fired on settle) picks up a genuinely new value.
    await page.route('**/api/projects/*/agent', async (route) => {
      await admin.from('shots').update({ visual_description: 'Agent-rewritten description.' }).eq('id', touched.shotId)
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody([
          { type: 'turn_started' },
          { type: 'tool_completed', label: 'Updated Shot 1', shotKey: touched.shotKey },
          { type: 'settled', content: 'Updated the description.' },
        ]),
      })
    })

    await page.goto(`/projects/${projectId}/workbench`)

    const touchedCard = page.locator(`[data-shot-key="${touched.shotKey}"]`)
    await touchedCard.click()

    // Focus the untouched shot's visual description field and start typing, without
    // blurring - this draft must survive regardless of what the agent does elsewhere.
    const untouchedCard = page.locator(`[data-shot-key="${untouched.shotKey}"]`)
    await untouchedCard.click()
    const untouchedField = untouchedCard.getByLabel('Visual description')
    await untouchedField.click()
    await untouchedField.fill('A draft the user is still typing')

    await sendMessage(page, 'rewrite shot 1')
    await expect(page.getByText('Updated the description.')).toBeVisible()

    await expect(touchedCard.getByLabel('Visual description')).toHaveValue('Agent-rewritten description.', {
      timeout: 10000,
    })

    // The focused, still-being-typed field was never overwritten by the same refresh.
    await expect(untouchedField).toHaveValue('A draft the user is still typing')
  })

  test('a field focused on the very shot the agent is editing is not overwritten either', async ({ page }) => {
    // Distinct from the test above: that one focuses a field on a shot the agent never
    // touched, so touchedShotKeys never contains its key and the resync effect's
    // isTouched guard alone already keeps it safe - the focus check is never reached.
    // This covers the harder branch: the SAME shot named by tool_completed, with a field
    // focused on it when settle's refresh lands - isTouched is true, so only the focus
    // check itself stands between the user's draft and the agent's write.
    const projectId = await seedProject()
    const touched = await seedShot(projectId, { visual_description: 'Original visual description.' })

    await page.route('**/api/projects/*/agent', async (route) => {
      await admin.from('shots').update({ visual_description: 'Agent-rewritten description.' }).eq('id', touched.shotId)
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody([
          { type: 'turn_started' },
          { type: 'tool_completed', label: 'Updated Shot 1', shotKey: touched.shotKey },
          { type: 'settled', content: 'Updated the description.' },
        ]),
      })
    })

    await page.goto(`/projects/${projectId}/workbench`)

    const touchedCard = page.locator(`[data-shot-key="${touched.shotKey}"]`)
    await touchedCard.click()
    const field = touchedCard.getByLabel('Visual description')
    await field.click()
    await field.fill('A draft on the exact shot the agent is about to rewrite')

    await sendMessage(page, 'rewrite shot 1')
    await expect(page.getByText('Updated the description.')).toBeVisible()

    // Asserting an absence of change needs to outlast when the change would have
    // happened, unlike a positive poll - the pacing yield (2 non-text events x 150ms)
    // plus the router.refresh() round trip both land well inside this window.
    await page.waitForTimeout(1500)

    await expect(field).toHaveValue('A draft on the exact shot the agent is about to rewrite')
  })

  test('insert_shot adds a new card and renumbers the shots after it, with no manual reload', async ({ page }) => {
    const projectId = await seedProject()
    const shotA = await seedShot(projectId, { voice_over: 'Shot A voiceover.' })
    const shotB = await seedShot(projectId, { voice_over: 'Shot B voiceover.' })
    const { data: shotBRow } = await admin.from('shots').select('order_index').eq('id', shotB.shotId).single()
    const shotBOrderIndexBefore = shotBRow!.order_index as number

    // Mirrors insert_shot's own server logic (tools.ts): shift every shot at/after the
    // insertion point up by one, then insert the new row at the vacated index - so
    // router.refresh() on settle picks up exactly what the real tool would have produced.
    await page.route('**/api/projects/*/agent', async (route) => {
      await admin.from('shots').update({ order_index: shotBOrderIndexBefore + 1 }).eq('id', shotB.shotId)
      await admin.from('shots').insert({
        project_id: projectId,
        order_index: shotBOrderIndexBefore,
        shot_key: 'acnew',
        voice_over: 'Inserted shot voiceover.',
        visual_description: 'Inserted shot description.',
      })
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody([
          { type: 'turn_started' },
          { type: 'tool_completed', label: 'Inserted a new shot after Shot 1', shotKey: 'acnew' },
          { type: 'settled', content: 'Added a shot after shot 1.' },
        ]),
      })
    })

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'add a shot after shot 1')
    await expect(page.getByText('Added a shot after shot 1.')).toBeVisible()

    // The new card appears with no manual reload - purely off the same router.refresh()
    // + full-array-replace mechanism every other tool completion already relies on.
    const newCard = page.locator('[data-shot-key="acnew"]')
    await expect(newCard).toBeVisible({ timeout: 10000 })
    await expect(newCard).toContainText('Inserted shot voiceover.')
    await expect(newCard).toContainText(`Shot ${shotBOrderIndexBefore + 1}`)

    // shotA (the anchor, before the insertion point) keeps its number...
    const cardA = page.locator(`[data-shot-key="${shotA.shotKey}"]`)
    await expect(cardA).toContainText(`Shot ${shotBOrderIndexBefore}`)
    // ...shotB (pushed back one position) renders one number higher than before.
    const cardB = page.locator(`[data-shot-key="${shotB.shotKey}"]`)
    await expect(cardB).toContainText(`Shot ${shotBOrderIndexBefore + 2}`)
  })

  test('a dropped stream leaves input usable again, with a visible error', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    await mockAgentRoute(page, []) // stream ends with no settled event at all

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'do something')

    await expect(page.locator('[data-message-kind="error"]')).toBeVisible()
    await expect(page.getByLabel('Ask for a change')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  })

  test('every input is disabled once furthest_step has reached storyboard', async ({ page }) => {
    const projectId = await seedProject({ furthest_step: 4 })
    await seedShot(projectId, { voice_over: 'A read-only voiceover.' })

    await page.goto(`/projects/${projectId}/workbench`)

    await expect(page.getByText('View only')).toBeVisible()
    await expect(page.getByLabel('Ask for a change')).toHaveCount(0)
    await expect(page.getByText('Editing closed at the storyboard step')).toBeVisible()

    await page.getByTestId('shot-card').first().click()
    await expect(page.getByLabel('Voiceover')).toHaveCount(0)
    await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.getByText('Delete shot')).toHaveCount(0)
  })
})
