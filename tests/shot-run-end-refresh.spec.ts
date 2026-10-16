import { test, expect, type Request } from '@playwright/test'
import { admin, createTestSession, releaseTestUser } from './supabase-test-session'
import { stepIndex } from '../src/lib/config/pipeline'
import { formatCost } from '../src/lib/format-cost'
import { formatCredits } from '../src/lib/format-credits'
import type { ShotRunView } from '../src/app/(app)/projects/[id]/workbench/_components/shot-run-view'

// Layer: ui. Everything a shot run changes on the Workbench and in the rail updates without a
// page render: the rail moves when the hold is placed (the start's reply), and when the run
// ends its one end-of-run read brings the Assets count, the rail's month figures, the title
// the outline set and the outline's chat message. Task 4f once narrowed the end-of-run
// refresh to the shot list and nothing caught it; this is that guard. The start and the
// status checks are stubbed; the end-of-run read is the real route over seeded rows. A pool
// user, so the rail's month figures are exactly this test's.

test.setTimeout(120_000)

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')

const view = (status: ShotRunView['status']): ShotRunView => ({
  id: 'end-run',
  status,
  stopReason: null,
  totalScenes: 1,
  writtenScenes: status === 'running' ? 0 : 1,
  unwrittenScenes: status === 'running' ? 1 : 0,
  held: null,
  charged: null,
})

/** A router.refresh() (or navigation) of the page: an RSC fetch that is not a prefetch. */
const isPageRsc = (pathname: string) => (req: Request) => {
  const h = req.headers()
  return req.method() === 'GET' && h['rsc'] === '1' && !h['next-router-prefetch'] && new URL(req.url()).pathname === pathname
}

test('after a shot run, the Assets count, the rail’s month figures, the title and the outline’s message show without a reload', { tag: '@smoke' }, async ({ page, context }) => {
  const { user, cookie } = await createTestSession()
  try {
    await context.addCookies([cookie])
    const { data, error } = await admin
      .from('projects')
      .insert({
        user_id: user.id,
        title: null,
        source_text: 'Keepers of a lighthouse on a stormy coast.',
        aspect_ratio: '9:16',
        video_model: 'wan-3.0',
        duration_target: '30-60s',
        current_step: 'workbench',
        furthest_step: stepIndex('workbench'),
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    const projectId = data!.id
    const pathname = `/projects/${projectId}/workbench`

    // The start answers with the rail's figures, the hold in them.
    const startRail = { spendThisMonth: 0.0042, creditsSpentThisMonth: 16 }
    await page.route(`**/api/projects/${projectId}/shots`, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 202, json: { ok: true, runId: 'end-run', rail: startRail } })
        : route.continue()
    )
    // Checks report the run running until the test has written its end, then completed.
    let ended = false
    await page.route(`**/api/projects/${projectId}/shots/status`, (route) =>
      route.fulfill({
        json: ended
          ? { generationState: 'succeeded', run: view('completed'), shotCount: 2 }
          : { generationState: 'generating', run: view('running'), shotCount: 0 },
      })
    )
    const reloads: string[] = []
    let listReads = 0
    page.on('request', (req) => {
      if (isPageRsc(pathname)(req)) reloads.push(req.url())
      if (new URL(req.url()).pathname === `/api/projects/${projectId}/shots/list`) listReads += 1
    })
    let loads = 0
    page.on('load', () => (loads += 1))

    await page.goto(pathname)
    await expect(page.getByText('Planning the scenes from your brief.')).toBeVisible()
    // The rail moved with the start's reply.
    await expect(page.getByTestId('rail-credits-spend')).toHaveText(`${formatCredits(16)} credits`)
    await expect(page.getByTestId('rail-dollar-spend')).toHaveText(formatCost(0.0042))
    const assetsTab = page.getByRole('link', { name: /^Assets/ })
    await expect(assetsTab).toHaveText('Assets0')

    // The run's writes, as its worker would leave them.
    const attemptId = crypto.randomUUID()
    const runStart = new Date(Date.now() - 10_000).toISOString()
    const now = new Date().toISOString()
    await admin.from('projects').update({ title: 'The Lighthouse Keepers' }).eq('id', projectId)
    const writes = await Promise.all([
      admin.from('generations').insert({
        project_id: projectId,
        step: 'workbench',
        operation: 'generate_shots',
        shot_id: null,
        element_id: null,
        state: 'succeeded',
        started_at: runStart,
      }),
      admin.from('shot_runs').insert({
        project_id: projectId,
        attempt_id: attemptId,
        kind: 'generate',
        status: 'completed',
        total_scenes: 1,
        heartbeat_at: now,
        finished_at: now,
        charged_at: now,
        held_credits: 16,
        charged_credits: 4,
        absorbed_credits: 0,
        created_at: runStart,
        updated_at: now,
      }),
      admin.from('shots').insert(
        [1, 2].map((n) => ({
          project_id: projectId,
          order_index: n - 1,
          shot_key: shotKey(),
          voice_over: `The keeper climbs, line ${n}.`,
          visual_description: `Shot ${n}`,
          duration_sec: 5,
        }))
      ),
      admin.from('elements').insert([
        { project_id: projectId, name: 'The Keeper', type: 'character' },
        { project_id: projectId, name: 'The Lighthouse', type: 'location' },
      ]),
      admin.from('messages').insert({ project_id: projectId, role: 'assistant', kind: 'run_note', content: 'Two scenes: the climb, then the storm.' }),
      admin.from('usage').insert({
        user_id: user.id,
        project_id: projectId,
        step: 'workbench',
        operation: 'generate_shots',
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        status: 'succeeded',
        estimated_cost: 0.0123,
      }),
    ])
    for (const w of writes) expect(w.error).toBeNull()
    const { data: hold, error: holdError } = await admin
      .from('credit_ledger')
      .insert({
        user_id: user.id,
        kind: 'spend',
        delta: -16,
        step: 'workbench',
        operation: 'generate_shots',
        project_id: projectId,
        message_id: null,
        shot_key: null,
        attempt_id: attemptId,
        dedupe_key: `hold:${attemptId}`,
        hold_slot: 1,
        price_version: 'test',
        pricing_mode: 'fixed',
        refunds_ledger_id: null,
      })
      .select('id')
      .single()
    expect(holdError).toBeNull()
    const { error: settleError } = await admin.from('credit_ledger').insert({
      user_id: user.id,
      kind: 'refund',
      delta: 12,
      step: 'workbench',
      operation: 'generate_shots',
      project_id: projectId,
      message_id: null,
      shot_key: null,
      attempt_id: attemptId,
      dedupe_key: `settle:${hold!.id}`,
      hold_slot: null,
      price_version: 'test',
      pricing_mode: null,
      refunds_ledger_id: hold!.id,
    })
    expect(settleError).toBeNull()
    ended = true

    // The run's end: one read, and every value it changed shows.
    await expect(page.getByText('The keeper climbs, line 2.')).toBeVisible({ timeout: 30_000 })
    await expect(assetsTab).toHaveText('Assets2')
    await expect(page.getByTestId('rail-credits-spend')).toHaveText(`${formatCredits(4)} credits`)
    await expect(page.getByTestId('rail-dollar-spend')).toHaveText(formatCost(0.0123))
    await expect(page.getByRole('heading', { name: 'The Lighthouse Keepers' })).toBeVisible()
    await expect(page.getByText('Two scenes: the climb, then the storm.')).toBeVisible()

    expect(listReads).toBe(1)
    expect(reloads).toHaveLength(0)
    expect(loads).toBe(1)
  } finally {
    await releaseTestUser(user.id)
  }
})

test('an agent turn that starts a run: no page render at turn end, then the turn line shows the settled net, each activity line once and the plan note once, below the turn', async ({ page, context }) => {
  const { user, cookie } = await createTestSession()
  try {
    await context.addCookies([cookie])
    const { data, error } = await admin
      .from('projects')
      .insert({
        user_id: user.id,
        title: 'Agent regenerate',
        source_text: 'Keepers of a lighthouse on a stormy coast.',
        aspect_ratio: '9:16',
        video_model: 'wan-3.0',
        duration_target: '30-60s',
        current_step: 'workbench',
        furthest_step: stepIndex('workbench'),
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    const projectId = data!.id
    const pathname = `/projects/${projectId}/workbench`
    const oldKeys = [shotKey(), shotKey()]
    const [claim, oldShots, elements] = await Promise.all([
      admin.from('generations').insert({ project_id: projectId, step: 'workbench', operation: 'generate_shots', shot_id: null, element_id: null, state: 'succeeded' }),
      admin
        .from('shots')
        .insert(
          oldKeys.map((key, i) => ({ project_id: projectId, order_index: i, shot_key: key, voice_over: `Old line ${i + 1}.`, visual_description: `Old ${i + 1}`, duration_sec: 5 }))
        )
        .select('id'),
      admin.from('elements').insert(['The Keeper', 'Old Pier', 'Old Boat'].map((name) => ({ project_id: projectId, name, type: 'prop' }))).select('id, name'),
    ])
    for (const w of [claim, oldShots, elements]) expect(w.error).toBeNull()
    const elementId = (name: string) => elements.data!.find((e) => e.name === name)!.id
    // The old list uses all three; none has a reference image.
    expect((await admin.from('shot_elements').insert(elements.data!.map((e) => ({ shot_id: oldShots.data![0].id, element_id: e.id })))).error).toBeNull()

    // The turn's own rows, written by the stubbed route while the turn runs, as the real one
    // writes them: what a refresh that re-read every client-id-less message used to append a
    // second time.
    const clientId = crypto.randomUUID()
    const turnStart = Date.now()
    const at = (ms: number) => new Date(turnStart + ms).toISOString()
    let userMsg: { id: string } | null = null
    await page.route(`**/api/projects/${projectId}/agent`, async (route) => {
      const { data: inserted } = await admin
        .from('messages')
        .insert({ project_id: projectId, role: 'user', content: 'Regenerate all the shots.', client_id: clientId, created_at: at(0) })
        .select('id')
        .single()
      userMsg = inserted
      const turnRows = await admin.from('messages').insert(
        [
          { kind: 'tool_done', tool_name: 'regenerate_all_shots', shot_key: null, client_id: null, content: 'Started rewriting all shots', created_at: at(1_000) },
          { kind: 'tool_done', tool_name: 'get_shot', shot_key: oldKeys[0], client_id: null, content: 'Looked at Shot 1', created_at: at(1_500) },
          { kind: 'text', tool_name: null, shot_key: null, client_id: clientId, content: 'Rewriting the shot list now.', created_at: at(2_000) },
        ].map((m) => ({ project_id: projectId, role: 'assistant', ...m }))
      )
      expect(turnRows.error).toBeNull()
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          { type: 'turn_started' },
          { type: 'tool_completed', label: 'Started rewriting all shots', toolName: 'regenerate_all_shots' },
          { type: 'tool_completed', label: 'Looked at Shot 1', toolName: 'get_shot', shotKey: oldKeys[0] },
          { type: 'text_delta', text: 'Rewriting the shot list now.' },
          { type: 'settled', content: 'Rewriting the shot list now.', cost: 0.004, messageId: inserted!.id },
        ]
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(''),
      })
    })
    // At the turn's end only the hold exists.
    await page.route(`**/api/projects/${projectId}/agent/turn-credits*`, (route) => route.fulfill({ json: { credits: 72 } }))
    let ended = false
    await page.route(`**/api/projects/${projectId}/shots/status`, (route) =>
      route.fulfill({
        json: ended
          ? { generationState: 'succeeded', run: view('completed'), shotCount: 1 }
          : { generationState: 'generating', run: view('running'), shotCount: 0 },
      })
    )
    const reloads: string[] = []
    let listReads = 0
    page.on('request', (req) => {
      if (isPageRsc(pathname)(req)) reloads.push(req.url())
      if (new URL(req.url()).pathname === `/api/projects/${projectId}/shots/list`) listReads += 1
    })
    let loads = 0
    page.on('load', () => (loads += 1))

    await page.goto(pathname)
    await expect(page.getByText('Old line 1.')).toBeVisible()
    const assetsTab = page.getByRole('link', { name: /^Assets/ })
    await expect(assetsTab).toHaveText('Assets3')
    await expect(page.getByTestId('workbench-footer-warning')).toContainText('3 elements without a reference image')
    await page.getByLabel('Ask for a change').fill('Regenerate all the shots.')
    await page.getByRole('button', { name: 'Send' }).click()
    const costLine = page.locator('[data-message-kind="cost"]')
    await expect(costLine).toContainText('72 cr')
    // F4: the turn started a run - the page follows it, with no page render.
    await expect(page.getByText('Planning the scenes from your brief.')).toBeVisible()
    expect(reloads).toHaveLength(0)

    // The run's end, as its worker and settle would leave it: the new list, an agent run
    // charged 13 of its 72-credit hold, every call's usage on the turn, and the plan note -
    // written after the turn's reply.
    const attemptId = crypto.randomUUID()
    const { data: agentClaim } = await admin
      .from('generations')
      .insert({ project_id: projectId, step: 'workbench', operation: 'agent_turn', shot_id: null, element_id: null, state: 'succeeded' })
      .select('id')
      .single()
    await admin.from('shots').delete().eq('project_id', projectId)
    const now = new Date().toISOString()
    const writes = await Promise.all([
      admin.from('shot_runs').insert({
        project_id: projectId,
        attempt_id: attemptId,
        kind: 'generate',
        status: 'completed',
        total_scenes: 1,
        message_id: userMsg!.id,
        agent_generation_id: agentClaim!.id,
        heartbeat_at: now,
        finished_at: now,
        charged_at: now,
        turn_settled_at: now,
        created_at: at(500),
        updated_at: now,
      }),
      admin
        .from('shots')
        .insert({ project_id: projectId, order_index: 0, shot_key: shotKey(), voice_over: 'A new first line.', visual_description: 'New', duration_sec: 5 })
        .select('id')
        .single()
        .then(async (r) => (r.error ? r : admin.from('shot_elements').insert({ shot_id: r.data.id, element_id: elementId('The Keeper') }))),
      admin.from('messages').insert({ project_id: projectId, role: 'assistant', kind: 'run_note', content: 'One scene: the keeper and the storm.', created_at: at(5_000) }),
      admin.from('usage').insert(
        [0.004, 0.0123].map((cost) => ({
          user_id: user.id,
          project_id: projectId,
          message_id: userMsg!.id,
          step: 'workbench',
          operation: 'agent_turn',
          provider: 'anthropic',
          model: 'claude-haiku-5-5',
          status: 'succeeded',
          estimated_cost: cost,
        }))
      ),
    ])
    for (const w of writes) expect(w.error).toBeNull()
    // The end-of-run cleanup removed the two the new list no longer uses.
    expect((await admin.from('elements').update({ deleted_at: now }).eq('project_id', projectId).in('name', ['Old Pier', 'Old Boat'])).error).toBeNull()
    const ledger = (kind: 'spend' | 'refund', delta: number, dedupe: string, refunds: string | null) => ({
      user_id: user.id,
      kind,
      delta,
      step: 'workbench',
      operation: 'agent_turn',
      project_id: projectId,
      message_id: userMsg!.id,
      shot_key: null,
      attempt_id: attemptId,
      dedupe_key: dedupe,
      hold_slot: kind === 'spend' ? 1 : null,
      price_version: 'test',
      pricing_mode: kind === 'spend' ? 'dynamic' : null,
      refunds_ledger_id: refunds,
    })
    const { data: hold, error: holdError } = await admin.from('credit_ledger').insert(ledger('spend', -72, `hold:${attemptId}`, null)).select('id').single()
    expect(holdError).toBeNull()
    expect((await admin.from('credit_ledger').insert(ledger('refund', 59, `settle:${hold!.id}`, hold!.id))).error).toBeNull()
    ended = true

    await expect(page.getByText('A new first line.')).toBeVisible({ timeout: 30_000 })
    await expect(assetsTab).toHaveText('Assets1')
    await expect(page.getByTestId('workbench-footer-warning')).toContainText('1 element without a reference image')
    // F2: the settled net and every call's dollars, not the hold.
    await expect(costLine).toHaveCount(1)
    await expect(costLine).toContainText(`${formatCost(0.0163)} / ${formatCredits(13)} cr`)
    // F3: each activity line once, the note once - directly below the turn's cost line.
    await expect(page.locator('[data-message-kind="tool_done"]')).toHaveCount(2)
    await expect(page.getByText('One scene: the keeper and the storm.')).toHaveCount(1)
    await expect(page.getByText('Rewriting the shot list now.')).toHaveCount(1)
    const kinds = await page.locator('[data-message-kind]').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-message-kind')}:${el.textContent?.trim().slice(0, 20)}`))
    expect(kinds.at(-2)).toMatch(/^cost:/)
    expect(kinds.at(-1)).toMatch(/^agent:One scene/)

    expect(listReads).toBe(1)
    expect(reloads).toHaveLength(0)
    expect(loads).toBe(1)
  } finally {
    await releaseTestUser(user.id)
  }
})
