import { test, expect, type Page, type Route } from '@playwright/test'
import { holdAgentTurnOpen, agentRequestSent, pushAgentEvent, settleAgentTurn } from './helpers/agent-stream'
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

// Mocks Credits Task 8's turn-credits lookup route, returning a fixed credits figure
// (or null, for "no matching ledger row") regardless of which messageId is requested -
// these tests only ever have one turn in flight at a time.
async function mockTurnCreditsRoute(page: Page, credits: number | null) {
  await page.route('**/api/projects/*/agent/turn-credits*', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ credits }) })
  })
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

  test('renders the cost line below the settled turn, sourced from the settled event - never parsed from a tool label', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    await mockAgentRoute(page, [
      { type: 'turn_started' },
      { type: 'tool_completed', label: 'Regenerated all shots', toolName: 'regenerate_all_shots' },
      { type: 'settled', content: 'Rebuilt the shot list from your brief.', cost: 0.42 },
    ])

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'start over')

    const toolLine = page.locator('[data-message-kind="tool_done"]', { hasText: 'Regenerated all shots' })
    await expect(toolLine).toBeVisible()
    const settledBubble = page.getByText('Rebuilt the shot list from your brief.')
    await expect(settledBubble).toBeVisible()
    const cost = page.locator('[data-message-kind="cost"]')
    await expect(cost).toBeVisible()
    await expect(cost.getByText('$0.420')).toBeVisible()
    await expect(cost.getByText('Cost of this turn')).toBeVisible()
  })

  test('the cost line appends the credit figure looked up from the turn\'s credit_ledger row, matched on message_id', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    await mockTurnCreditsRoute(page, 17)
    await mockAgentRoute(page, [
      { type: 'turn_started' },
      { type: 'settled', content: 'Done.', cost: 0.42, messageId: 'msg-1' },
    ])

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'tighten shot 1')

    const cost = page.locator('[data-message-kind="cost"]')
    await expect(cost).toBeVisible()
    await expect(cost.getByText('$0.420 / 17 cr')).toBeVisible()
  })

  test('a turn with no matching credit_ledger row renders the dollar figure alone, never "0 cr"', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    await mockTurnCreditsRoute(page, null)
    await mockAgentRoute(page, [
      { type: 'turn_started' },
      { type: 'settled', content: 'Done.', cost: 0.42, messageId: 'msg-1' },
    ])

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'tighten shot 1')

    const cost = page.locator('[data-message-kind="cost"]')
    await expect(cost).toBeVisible()
    await expect(cost.getByText('$0.420', { exact: true })).toBeVisible()
    await expect(cost.getByText('cr')).toHaveCount(0)
  })

  test('a zero-cost settle renders no cost line at all', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    await mockAgentRoute(page, [
      { type: 'turn_started' },
      { type: 'text_delta', text: 'Nothing needed changing.' },
      { type: 'settled', content: 'Nothing needed changing.', cost: 0 },
    ])

    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'is shot 1 okay as-is?')

    await expect(page.getByText('Nothing needed changing.')).toBeVisible()
    await expect(page.locator('[data-message-kind="cost"]')).toHaveCount(0)
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

    // The turn is held open by the test, so "while the turn runs" is a state the assertions
    // can rely on, not a ~300ms window between the panel's per-event yields.
    await holdAgentTurnOpen(page)
    await page.goto(`/projects/${projectId}/workbench`)
    await sendMessage(page, 'tighten shot 1')
    await agentRequestSent(page)
    await pushAgentEvent(page, { type: 'turn_started' })
    await pushAgentEvent(page, { type: 'tool_completed', label: 'Updated Shot 1', shotKey: shotA.shotKey })

    const cardA = page.locator(`[data-shot-key="${shotA.shotKey}"]`)
    const cardB = page.getByTestId('shot-card').filter({ hasText: 'Shot B voiceover.' })
    await expect(cardA).toHaveAttribute('data-locked', 'true')
    await expect(page.getByText('Agent is rewriting this shot')).toBeVisible()
    await expect(cardB).toHaveAttribute('data-locked', 'false')

    // The other card stays fully editable while shotA is locked.
    await cardB.click()
    await expect(page.getByLabel('Voiceover')).toBeEditable()

    await settleAgentTurn(page, 'Updated shot 1.')
    await expect(cardA).toHaveAttribute('data-locked', 'false')
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
    const untouchedCard = page.locator(`[data-shot-key="${untouched.shotKey}"]`)

    // Focus the untouched shot's visual description field and start typing, without
    // blurring - this draft must survive regardless of what the agent does elsewhere.
    // Only this card is expanded: cards are an accordion (one at a time), so the touched
    // card's own resync is verified from its collapsed plain-text render below instead
    // of expanding both at once.
    await untouchedCard.click()
    const untouchedField = untouchedCard.getByLabel('Visual description')
    await untouchedField.click()
    await untouchedField.fill('A draft the user is still typing')

    await sendMessage(page, 'rewrite shot 1')
    await expect(page.getByText('Updated the description.')).toBeVisible()

    // shots-context's local state resyncs regardless of expand/collapse - the collapsed
    // card's plain-text render already reflects the agent's write.
    await expect(touchedCard.getByText('Agent-rewritten description.')).toBeVisible({ timeout: 10000 })

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

  test('reload reconstructs tool_done/refusal from persisted rows, with a shot number resolved fresh - surviving a later renumbering', async ({
    page,
  }) => {
    const projectId = await seedProject()
    const shotA = await seedShot(projectId, { voice_over: 'Shot A voiceover.' })
    const shotB = await seedShot(projectId, { voice_over: 'Shot B voiceover.' })
    // shotB is Shot 2 right now. Seed a persisted turn as if it happened while shotB was
    // still Shot 2: a user message, a tool_done row naming shotB by shot_key (not "Shot
    // 2"), a refusal row with no shot_key, and the turn's own closing reply.
    const { data: userRow } = await admin
      .from('messages')
      .insert({ project_id: projectId, role: 'user', content: 'tighten shot 2 and delete shot 1' })
      .select('id')
      .single()
    await admin.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      kind: 'tool_done',
      tool_name: 'update_shot',
      shot_key: shotB.shotKey,
      content: 'Updated Shot 2',
    })
    await admin.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      kind: 'refusal',
      tool_name: null,
      shot_key: null,
      content: "I can't delete shots - use the bin on the shot itself.",
    })
    await admin.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      kind: 'text',
      content: 'Tightened shot 2. I left shot 1 alone - use its own delete control.',
    })

    // Now renumber: insert a brand-new shot before shotA, pushing shotA to Shot 2 and
    // shotB to Shot 3 - after the tool_done row above was written.
    await admin.from('shots').update({ order_index: 1 }).eq('id', shotA.shotId)
    await admin.from('shots').update({ order_index: 2 }).eq('id', shotB.shotId)
    await admin.from('shots').insert({
      project_id: projectId,
      order_index: 0,
      shot_key: 'acren',
      voice_over: 'A shot inserted after the fact.',
      visual_description: 'Inserted later.',
    })

    await page.goto(`/projects/${projectId}/workbench`)

    // The tool_done row shows shotB's CURRENT number (3), not the 2 baked into its own
    // stored `content` at write time - describeToolActivity re-derives it live from
    // tool_name/shot_key, never trusting the stored label text for a shot-scoped row.
    await expect(page.locator('[data-message-kind="tool_done"]', { hasText: 'Updated Shot 3' })).toBeVisible()
    await expect(page.locator('[data-message-kind="tool_done"]', { hasText: 'Updated Shot 2' })).toHaveCount(0)
    await expect(page.locator('[data-message-kind="refusal"]', { hasText: "I can't delete shots" })).toBeVisible()
    await expect(page.getByText('Tightened shot 2.')).toBeVisible()
    expect(userRow).toBeTruthy()
  })

  test('an abandoned turn (no closing reply ever persisted) renders as an error with no cost line, and Retry resends the original content', async ({
    page,
  }) => {
    const projectId = await seedProject()
    await seedShot(projectId)
    const clientId = crypto.randomUUID()
    const { data: userRow } = await admin
      .from('messages')
      .insert({ project_id: projectId, role: 'user', content: 'rewrite everything', client_id: clientId })
      .select('id')
      .single()
    // Stuck 'pending' forever - the process died before the finally block's force-settle
    // ever ran. Its figure must never be shown, even though it's a real number.
    await admin.from('usage').insert({
      user_id: primary.user.id,
      project_id: projectId,
      message_id: userRow!.id,
      step: 'workbench',
      operation: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      status: 'pending',
      estimated_cost: 0.5,
    })

    const secondRequestBodies: { content: string; clientId: string }[] = []
    await page.route('**/api/projects/*/agent', async (route) => {
      secondRequestBodies.push(route.request().postDataJSON())
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody([{ type: 'settled', content: 'Retried.', cost: 0 }]),
      })
    })

    await page.goto(`/projects/${projectId}/workbench`)

    const errorLine = page.locator('[data-message-kind="error"]', { hasText: 'never finished' })
    await expect(errorLine).toBeVisible()
    await expect(page.locator('[data-message-kind="cost"]')).toHaveCount(0)

    await errorLine.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => secondRequestBodies.length).toBe(1)
    expect(secondRequestBodies[0].clientId).toBe(clientId)
    expect(secondRequestBodies[0].content).toBe('rewrite everything')
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

  test('opens scrolled to the most recent message, not the top of a long conversation', async ({ page }) => {
    const projectId = await seedProject()
    await seedShot(projectId)

    // Enough turns to overflow the panel's height so there's somewhere to scroll from.
    for (let i = 0; i < 20; i++) {
      await admin.from('messages').insert({ project_id: projectId, role: 'user', content: `Turn ${i}: change something.` })
      await admin.from('messages').insert({ project_id: projectId, role: 'assistant', kind: 'text', content: `Turn ${i}: done.` })
    }
    // The LAST turn's own content, to assert it's the one actually in view.
    await admin.from('messages').insert({ project_id: projectId, role: 'user', content: 'The very last message.' })
    await admin.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      kind: 'text',
      content: 'The very last reply.',
    })

    await page.goto(`/projects/${projectId}/workbench`)

    // The last message is already present in the server-rendered HTML (SSR), so it can
    // become visible before client-side hydration - and with it, the scroll-to-bottom
    // effect - has actually run. Poll the scroll position rather than reading it once
    // immediately, so the assertion is on the effect actually having run, not on timing.
    await expect(page.getByText('The very last reply.')).toBeVisible()
    const list = page.locator('[data-message-kind="user"]').first().locator('..')

    const metrics = () =>
      list.evaluate((el) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
    const initial = await metrics()
    expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight) // sanity: seeded messages actually overflow

    await expect
      .poll(async () => {
        const { scrollTop, scrollHeight, clientHeight } = await metrics()
        return scrollTop + clientHeight >= scrollHeight - 5
      })
      .toBe(true)
  })
})
