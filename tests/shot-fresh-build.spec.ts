import { test, expect, type Request } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import type { ShotRunView } from '../src/app/(app)/projects/[id]/workbench/_components/shot-run-view'
import type { DisplayShot } from '../src/app/(app)/projects/[id]/workbench/_components/types'

// Layer: ui. A brand-new project's first Workbench load builds its shot list on its own: the
// start, the status checks and the end-of-run shot-list read are stubbed (no provider runs).
// The progress line moves past "Planning" and the shots appear with no page reload - the
// first-load server sync never takes back the "generating" the trigger set.

test.setTimeout(120_000)

const view = (status: ShotRunView['status'], totalScenes: number | null, writtenScenes: number): ShotRunView => ({
  id: 'fresh-run',
  status,
  stopReason: null,
  totalScenes,
  writtenScenes,
  unwrittenScenes: (totalScenes ?? 0) - writtenScenes,
  held: status === 'completed' ? 16 : null,
  charged: status === 'completed' ? 6 : null,
})

const shot = (i: number): DisplayShot => ({
  id: crypto.randomUUID(),
  order_index: i,
  shot_key: `fb${i}zz`.slice(0, 5),
  scene_title: 'Opening',
  voice_over: `Fresh line ${i + 1}.`,
  visual_description: `Fresh shot ${i + 1}`,
  duration_sec: 5,
  duration_locked: false,
  shot_size: null,
  shot_size_origin: 'auto',
  camera_angle: null,
  camera_angle_origin: 'auto',
  camera_movement: null,
  camera_movement_origin: 'auto',
  elements: [],
  dialogue: [],
})

const isPageRsc = (pathname: string) => (req: Request) => {
  const h = req.headers()
  return req.method() === 'GET' && h['rsc'] === '1' && !h['next-router-prefetch'] && new URL(req.url()).pathname === pathname
}

test('Build on a fresh project: progress moves past "Planning" and the shots render, with no reload', { tag: '@smoke' }, async ({ page }) => {
  // No generations row and no shots: the first load triggers the build.
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Fresh build',
      source_text: 'A short film about a lighthouse.',
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

  let starts = 0
  await page.route(`**/api/projects/${projectId}/shots`, (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    starts += 1
    return route.fulfill({ status: 202, json: { ok: true, runId: 'fresh-run' } })
  })
  const answers = [
    { generationState: 'generating', run: view('running', null, 0) },
    { generationState: 'generating', run: view('running', 3, 1) },
    { generationState: 'succeeded', run: view('completed', 3, 3) },
  ]
  let checks = 0
  await page.route(`**/api/projects/${projectId}/shots/status`, (route) => {
    const answer = answers[Math.min(checks, answers.length - 1)]
    checks += 1
    return route.fulfill({ json: { ...answer, shotCount: 0 } })
  })
  let listReads = 0
  await page.route(`**/api/projects/${projectId}/shots/list`, (route) => {
    listReads += 1
    return route.fulfill({
      json: {
        ok: true,
        shots: [0, 1, 2].map(shot),
        videoType: 'explainer',
        generationState: 'succeeded',
        hasPendingPayload: false,
        run: view('completed', 3, 3),
        remainingCredits: 0,
      },
    })
  })
  const reloads: string[] = []
  page.on('request', (req) => {
    if (isPageRsc(pathname)(req)) reloads.push(req.url())
  })
  let loads = 0
  page.on('load', () => (loads += 1))

  await page.goto(pathname)
  await expect(page.getByText('Planning the scenes from your brief.')).toBeVisible()
  await expect(page.getByText('Writing scene 2 of 3')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Fresh line 3.')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Shot list: 16 held · 6 charged')).toBeVisible()

  expect(starts).toBe(1)
  expect(listReads).toBe(1)
  expect(reloads).toHaveLength(0)
  expect(loads).toBe(1)
})
