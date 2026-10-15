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
      admin.from('messages').insert({ project_id: projectId, role: 'assistant', content: 'Two scenes: the climb, then the storm.' }),
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
