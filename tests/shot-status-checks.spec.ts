import { test, expect, type Page, type Request, type Route } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { SHOT_STATUS_POLL_MS } from '../src/lib/config/shots'
import type { ShotRunView } from '../src/app/(app)/projects/[id]/workbench/_components/shot-run-view'

// Layer: ui. The Workbench's status checks while shots are written, with the start and the
// status route stubbed so each answer is chosen: a check that reads the previous run's end
// never stops checking; a tab return before a run never makes its first check skip the wait;
// and a check during a run - "Generate remaining shots" at 150 shots, or "Try again" over a
// partial list, with the rows in view - re-renders only the progress line: never a shot row,
// the header or the footer, and with no page reload or prefetch; a run's end reads only the
// shot list.

test.setTimeout(120_000)

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')

async function workbenchProject(title: string, generationState: 'failed' | 'generating', shotCount: number) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title,
      source_text: 'A short film.',
      aspect_ratio: '9:16',
      video_model: 'wan-3.0',
      duration_target: '8-10min',
      current_step: 'workbench',
      furthest_step: stepIndex('workbench'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = data!.id
  await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    element_id: null,
    state: generationState,
    started_at: new Date().toISOString(),
  })
  if (shotCount > 0) {
    const { error: shotsError } = await admin.from('shots').insert(
      Array.from({ length: shotCount }, (_, i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: shotKey(),
        voice_over: `Line ${i + 1}.`,
        visual_description: `Shot ${i + 1}`,
        duration_sec: 3,
      }))
    )
    expect(shotsError).toBeNull()
  }
  return projectId
}

const view = (id: string, status: ShotRunView['status'], writtenScenes: number): ShotRunView => ({
  id,
  status,
  stopReason: status === 'failed' ? 'error' : null,
  totalScenes: 5,
  writtenScenes,
  unwrittenScenes: 5 - writtenScenes,
  held: null,
  charged: null,
})

/** Serves the status route from a script of answers; the last one repeats. */
function scriptStatus(page: Page, projectId: string, answers: { generationState: string; run: ShotRunView }[]) {
  let served = 0
  return page
    .route(`**/api/projects/${projectId}/shots/status`, (route: Route) => {
      const answer = answers[Math.min(served, answers.length - 1)]
      served += 1
      return route.fulfill({ json: { ...answer, shotCount: 0 } })
    })
    .then(() => () => served)
}

/** A router.refresh() (or navigation) of the page: an RSC fetch that is not a prefetch. */
const isPageRsc = (pathname: string) => (req: Request) => {
  const h = req.headers()
  // A GET: a server action (the footer's furthest-step check) is a POST to the same path.
  return req.method() === 'GET' && h['rsc'] === '1' && !h['next-router-prefetch'] && new URL(req.url()).pathname === pathname
}
const isPrefetch = (req: Request) => req.headers()['next-router-prefetch'] === '1'

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

test('a check that reads the previous run’s failed end keeps checking until the new run ends; a tab return before the run never skips the first wait', async ({ page }) => {
  const projectId = await workbenchProject('Status checks - previous run', 'failed', 0)
  const pathname = `/projects/${projectId}/workbench`
  const served = await scriptStatus(page, projectId, [
    // The claim has not been reclaimed yet: the previous run's failed end.
    { generationState: 'failed', run: view('previous-run', 'failed', 1) },
    { generationState: 'generating', run: view('new-run', 'running', 1) },
    { generationState: 'generating', run: view('new-run', 'running', 3) },
    { generationState: 'succeeded', run: view('new-run', 'completed', 5) },
  ])
  await page.route(`**/api/projects/${projectId}/shots`, (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 202, json: { ok: true, runId: 'new-run' } }) : route.continue()
  )
  const refreshes: string[] = []
  let listReads = 0
  page.on('request', (req) => {
    if (isPageRsc(pathname)(req)) refreshes.push(req.url())
    if (new URL(req.url()).pathname === `/api/projects/${projectId}/shots/list`) listReads += 1
  })

  await page.clock.install()
  await page.goto(pathname)
  await expect(page.getByText('Couldn’t build the shot list')).toBeVisible()
  // Freeze the page's clock: from here only runFor moves it, so "no check yet" is exact.
  await page.clock.pauseAt(new Date(Date.now() + 60_000))

  // Away and back before any run: the stale "came back" flag must not survive into the run.
  await setHidden(page, true)
  await setHidden(page, false)

  await page.getByRole('button', { name: 'Try again' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click()
  await expect(page.getByText(/Planning the scenes|Writing scene/)).toBeVisible()

  // No check before one full interval has passed.
  await page.clock.runFor(SHOT_STATUS_POLL_MS - 500)
  await page.waitForTimeout(500)
  expect(served()).toBe(0)

  // The previous run's failed end is read first; checking goes on, with no reload.
  for (let i = 1; i <= 3; i++) {
    await page.clock.runFor(SHOT_STATUS_POLL_MS)
    await expect.poll(served).toBeGreaterThanOrEqual(i)
  }
  expect(refreshes).toHaveLength(0)
  await expect(page.getByText('Writing scene 4 of 5')).toBeVisible()

  // The new run's end: exactly one shot-list read, and no page reload.
  await page.clock.runFor(SHOT_STATUS_POLL_MS)
  await expect.poll(() => listReads).toBe(1)
  await page.clock.runFor(SHOT_STATUS_POLL_MS * 3)
  await page.waitForTimeout(500)
  expect(served()).toBe(4)
  expect(listReads).toBe(1)
  expect(refreshes).toHaveLength(0)
})

/**
 * A render probe through React's DevTools hook: after each commit, the components that
 * rendered in it (a fiber not carried over from the previous commit, with work performed).
 * Recording starts when startProbe() is called.
 */
async function installRenderProbe(page: Page) {
  await page.addInitScript(() => {
    type Fiber = { child: Fiber | null; sibling: Fiber | null; flags: number; type: unknown; elementType: unknown }
    const w = window as unknown as { __renders: string[]; __probing: boolean; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }
    w.__renders = []
    w.__probing = false
    let previous = new WeakSet<Fiber>()
    const nameOf = (f: Fiber) => {
      const t = (f.elementType ?? f.type) as { displayName?: string; name?: string; type?: { displayName?: string; name?: string } } | null
      if (!t || typeof t === 'string') return null
      return t.displayName ?? t.type?.displayName ?? t.name ?? t.type?.name ?? null
    }
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        const seen = new WeakSet<Fiber>()
        const stack: Fiber[] = [root.current]
        while (stack.length > 0) {
          const f = stack.pop()!
          seen.add(f)
          if (w.__probing && !previous.has(f) && (f.flags & 1) === 1) {
            const name = nameOf(f)
            if (name) w.__renders.push(name)
          }
          if (f.sibling) stack.push(f.sibling)
          if (f.child) stack.push(f.child)
        }
        if (w.__probing) w.__renders.push('|commit')
        previous = seen
      },
    }
  })
  return {
    start: () => page.evaluate(() => ((window as unknown as { __probing: boolean }).__probing = true)),
    renders: () => page.evaluate(() => (window as unknown as { __renders: string[] }).__renders),
  }
}

/**
 * Runs `checks` scripted status checks of a run already showing, then asserts each one
 * re-rendered only the progress line: never a shot row, the header or the footer, and with
 * no page reload or prefetch.
 */
async function assertChecksRenderOnlyProgress(page: Page, probe: Awaited<ReturnType<typeof installRenderProbe>>, served: () => number, pathname: string, checks: number) {
  let rsc = 0
  let prefetches = 0
  page.on('request', (req) => {
    if (isPageRsc(pathname)(req)) rsc += 1
    if (isPrefetch(req)) prefetches += 1
  })
  // Hydrated and checking (the first check also settles the start's own renders); the first
  // paint's prefetches are settled before counting.
  await expect
    .poll(
      async () => {
        await page.clock.runFor(SHOT_STATUS_POLL_MS)
        return served()
      },
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0)
  // Two more checks before counting: the page's own one-off timers (fired by the first clock
  // jumps after hydration) have run by then.
  for (let i = 0; i < 2; i++) {
    const at = served()
    await page.clock.runFor(SHOT_STATUS_POLL_MS)
    await expect.poll(served).toBeGreaterThan(at)
  }
  await page.waitForTimeout(1_500)
  prefetches = 0
  const before = served()
  await probe.start()
  for (let i = 1; i <= checks; i++) {
    await page.clock.runFor(SHOT_STATUS_POLL_MS)
    await expect.poll(served).toBeGreaterThanOrEqual(before + i)
  }
  await expect(page.getByText(/Writing scene \d of 5/)).toBeVisible()
  // One entry per commit: the components that rendered in it.
  const commits = (await probe.renders())
    .join(' ')
    .split('|commit')
    .map((c) => new Set(c.trim().split(' ').filter(Boolean)))
    .filter((c) => c.size > 0)
  // The progress line updated on the checks, and those commits rendered nothing else that
  // reads the shot list.
  const progressOnly = commits.filter((c) => c.has('RunProgress') && !['ShotCard', 'WorkbenchHeader', 'WorkbenchFooter'].some((n) => c.has(n)))
  expect(progressOnly.length).toBeGreaterThanOrEqual(checks - 1)
  // A shot row, the header or the footer may render only in a commit that also re-rendered
  // the layout's user menu - an update from above the page (Next's router settling after the
  // first paint), never from a status check, whose state lives below the layout.
  for (const c of commits) {
    if (['ShotCard', 'WorkbenchHeader', 'WorkbenchFooter'].some((n) => c.has(n))) expect(c.has('UserMenu')).toBe(true)
  }
  expect(rsc).toBe(0)
  expect(prefetches).toBe(0)
}

test('"Generate remaining shots" at 150 shots: the rows stay in view, and a status check re-renders only the progress line - no shot row, header or footer, no reload, no prefetch', async ({ page }) => {
  // A remaining run is generating over an existing 150-shot list (a tab following it).
  const projectId = await workbenchProject('Status checks - remaining, 150 shots', 'generating', 150)
  const pathname = `/projects/${projectId}/workbench`
  const served = await scriptStatus(page, projectId, [
    { generationState: 'generating', run: view('the-run', 'running', 0) },
    { generationState: 'generating', run: view('the-run', 'running', 1) },
    { generationState: 'generating', run: view('the-run', 'running', 2) },
    { generationState: 'generating', run: view('the-run', 'running', 3) },
    { generationState: 'generating', run: view('the-run', 'running', 4) },
    { generationState: 'generating', run: view('the-run', 'running', 3) },
    { generationState: 'generating', run: view('the-run', 'running', 4) },
  ])
  const probe = await installRenderProbe(page)
  await page.clock.install()
  await page.goto(pathname)
  await expect(page.getByText('Planning the scenes from your brief.')).toBeVisible()
  await expect(page.getByText('Line 150.')).toBeAttached()
  await assertChecksRenderOnlyProgress(page, probe, served, pathname, 4)
  await expect(page.getByText('Line 150.')).toBeAttached()
})

test('"Try again" over a partial list: the rows stay in view, and a status check re-renders only the progress line', async ({ page }) => {
  // A cut-short run left 40 shots; the person tries again.
  const projectId = await workbenchProject('Status checks - try again', 'failed', 40)
  const pathname = `/projects/${projectId}/workbench`
  const served = await scriptStatus(page, projectId, [
    { generationState: 'generating', run: view('retry-run', 'running', 0) },
    { generationState: 'generating', run: view('retry-run', 'running', 1) },
    { generationState: 'generating', run: view('retry-run', 'running', 2) },
    { generationState: 'generating', run: view('retry-run', 'running', 3) },
    { generationState: 'generating', run: view('retry-run', 'running', 4) },
    { generationState: 'generating', run: view('retry-run', 'running', 3) },
    { generationState: 'generating', run: view('retry-run', 'running', 4) },
  ])
  await page.route(`**/api/projects/${projectId}/shots`, (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 202, json: { ok: true, runId: 'retry-run' } }) : route.continue()
  )
  const probe = await installRenderProbe(page)
  await page.clock.install()
  await page.goto(pathname)
  await page.getByRole('button', { name: 'Try again' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click()
  await expect(page.getByText('Planning the scenes from your brief.')).toBeVisible()
  await expect(page.getByText('Line 40.')).toBeAttached()
  await assertChecksRenderOnlyProgress(page, probe, served, pathname, 4)
})

test('the Assets tab follows the page data: an element written meanwhile shows on a soft navigation, with no browser reload', async ({ page }) => {
  const projectId = await workbenchProject('Status checks - assets', 'failed', 2)
  let loads = 0
  page.on('load', () => (loads += 1))
  await page.goto(`/projects/${projectId}/workbench`)
  await expect(page.getByRole('link', { name: /Assets/ })).toBeVisible()
  const firstLoads = loads

  // A run (or the agent) writes an element after the page was rendered.
  const name = `Lighthouse keeper ${crypto.randomUUID().slice(0, 6)}`
  const { error } = await admin.from('elements').insert({ project_id: projectId, name, type: 'character' })
  expect(error).toBeNull()

  await page.getByRole('link', { name: /Assets/ }).click()
  await expect(page.getByText(name)).toBeVisible()
  expect(loads).toBe(firstLoads)
})

test('a shot list past the tier maximum is kept, and the header says it is over range', async ({ page }) => {
  // 30-60s holds at most 60s: 25 shots of 3s are 75s.
  const projectId = await workbenchProject('Status checks - over range', 'failed', 0)
  await admin.from('projects').update({ duration_target: '30-60s' }).eq('id', projectId)
  await admin.from('generations').update({ state: 'succeeded' }).eq('project_id', projectId)
  const { error } = await admin.from('shots').insert(
    Array.from({ length: 25 }, (_, i) => ({ project_id: projectId, order_index: i, shot_key: shotKey(), voice_over: `Line ${i}.`, duration_sec: 3 }))
  )
  expect(error).toBeNull()
  await page.goto(`/projects/${projectId}/workbench`)
  await expect(page.getByTestId('header-current-duration')).toContainText('over range')
})
