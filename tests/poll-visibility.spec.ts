import { test, expect, type Page, type Request } from '@playwright/test'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

// Every client poll loop pauses while the tab is hidden and polls once, immediately, on
// return - then resumes its normal interval. The page's clock is faked so intervals pass
// instantly; requests are real and counted. Hidden is simulated by overriding
// document.visibilityState and dispatching visibilitychange, which is all a browser does.
// A setTimeout chain fires at most one poll per runFor (it only re-arms once the response
// lands), so the chain loops advance in one long step.

test.setTimeout(120000)

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')
const HIDDEN_FOR_MS = 5 * 60_000
const CHAIN_STEP_MS = 60_000

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

type Counter = { (): number; inFlight: () => number }

function countRequests(page: Page, matches: (req: Request) => boolean): Counter {
  let started = 0
  let done = 0
  page.on('request', (req) => {
    if (matches(req)) started += 1
  })
  const finish = (req: Request) => {
    if (matches(req)) done += 1
  }
  page.on('requestfinished', finish)
  page.on('requestfailed', finish)
  return Object.assign(() => started, { inFlight: () => started - done })
}

/** A router.refresh() of `pathname`: an RSC fetch of the page itself, never a prefetch. */
function isRefreshOf(pathname: string) {
  return (req: Request) => {
    const h = req.headers()
    return h['rsc'] === '1' && !h['next-router-prefetch'] && new URL(req.url()).pathname === pathname
  }
}

/** Waits until the loop has polled at least once while visible (which also covers hydration). */
async function expectPolling(page: Page, count: Counter, stepMs: number) {
  await expect
    .poll(
      async () => {
        await page.clock.runFor(stepMs)
        return count()
      },
      { timeout: 45000 }
    )
    .toBeGreaterThan(0)
}

/**
 * Waits for every counted request to finish and the loop to re-arm, in real time, then
 * reads the count. A poll still in flight when the tab hides would otherwise re-arm after
 * the clock advance and leave nothing to pause.
 */
async function settled(page: Page, count: Counter) {
  await expect.poll(count.inFlight, { timeout: 30000 }).toBe(0)
  await page.waitForTimeout(1000)
  return count()
}

async function assertPausesAndResumes(page: Page, count: Counter, stepMs: number) {
  await expectPolling(page, count, stepMs)

  await setHidden(page, true)
  const beforeHidden = await settled(page, count)
  await page.clock.runFor(HIDDEN_FOR_MS)
  expect(await settled(page, count)).toBe(beforeHidden)

  // On return: exactly one poll, at once - no clock advance.
  await setHidden(page, false)
  await expect.poll(count).toBe(beforeHidden + 1)
  expect(await settled(page, count)).toBe(beforeHidden + 1)

  // Then the normal interval again.
  await page.clock.runFor(stepMs)
  await expect.poll(count).toBe(beforeHidden + 2)
}

async function project(step: 'workbench' | 'image_prompts' | 'storyboard', title: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title,
      source_text: 'A short film.',
      aspect_ratio: '9:16',
      video_model: 'Kling 2.1',
      current_step: step,
      furthest_step: stepIndex(step),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id
}

async function shots(projectId: string, n: number) {
  const { data, error } = await admin
    .from('shots')
    .insert(
      Array.from({ length: n }, (_, i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: shotKey(),
        voice_over: `Line ${i + 1}.`,
        visual_description: `Shot ${i + 1}`,
        duration_sec: 3,
        image_prompt: `Prompt ${i + 1}`,
      }))
    )
    .select('id')
  expect(error).toBeNull()
  return data!.map((s) => s.id)
}

/** A storyboard whose frames all have images; `generatingShot` leaves the first one mid-generation. */
async function storyboard(title: string, { generatingShot }: { generatingShot: boolean }) {
  const projectId = await project('storyboard', title)
  const shotIds = await shots(projectId, 2)
  const bytes = await sharp({ create: { width: 18, height: 32, channels: 3, background: { r: 90, g: 120, b: 160 } } })
    .webp()
    .toBuffer()
  for (const [i, shotId] of shotIds.entries()) {
    const imagePath = `${primary.user.id}/${projectId}/images/${shotId}/${crypto.randomUUID()}.webp`
    await admin.storage.from('artifacts').upload(imagePath, bytes, { contentType: 'image/webp' })
    await admin.from('shots').update({ image_path: imagePath }).eq('id', shotId)
    const generating = generatingShot && i === 0
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'storyboard',
      operation: 'generate_image',
      shot_id: shotId,
      element_id: null,
      state: generating ? 'generating' : 'succeeded',
      started_at: generating ? new Date().toISOString() : null,
    })
  }
  return projectId
}

test('storyboard image status poll pauses while hidden and polls once on return', async ({ page }) => {
  const projectId = await storyboard('Poll visibility - images', { generatingShot: true })
  const count = countRequests(
    page,
    (req) => req.method() === 'GET' && new URL(req.url()).pathname === `/api/projects/${projectId}/images/status`
  )
  await page.clock.install()
  await page.goto(`/projects/${projectId}/storyboard`)
  await assertPausesAndResumes(page, count, CHAIN_STEP_MS)
})

test('export status poll pauses while hidden and polls once on return', async ({ page }) => {
  const projectId = await storyboard('Poll visibility - exports', { generatingShot: false })
  const { error } = await admin.from('exports').insert({
    user_id: primary.user.id,
    project_id: projectId,
    status: 'queued',
    settings: {
      motion: 'alternate',
      transition: 'dissolve',
      captions: 'off',
      captionStyle: 'reelcraft_default',
      captionPosition: 'bottom',
      loudness: 'streaming',
      aspectRatio: '9:16',
    },
    film_hash: 'poll-visibility',
    progress: 0,
  })
  expect(error).toBeNull()
  const count = countRequests(
    page,
    (req) => req.method() === 'GET' && new URL(req.url()).pathname === `/api/projects/${projectId}/exports`
  )
  await page.clock.install()
  await page.goto(`/projects/${projectId}/storyboard`)
  await assertPausesAndResumes(page, count, CHAIN_STEP_MS)
})

test('workbench generating refresh pauses while hidden and refreshes once on return', async ({ page }) => {
  const projectId = await project('workbench', 'Poll visibility - workbench')
  const { error } = await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    element_id: null,
    state: 'generating',
    started_at: new Date().toISOString(),
  })
  expect(error).toBeNull()
  const pathname = `/projects/${projectId}/workbench`
  const count = countRequests(page, isRefreshOf(pathname))
  await page.clock.install()
  await page.goto(pathname)
  await assertPausesAndResumes(page, count, 3000)
})

test('image prompts external-generation refresh pauses while hidden and refreshes once on return', async ({ page }) => {
  const projectId = await project('image_prompts', 'Poll visibility - image prompts')
  await shots(projectId, 1)
  const { error } = await admin.from('generations').insert({
    project_id: projectId,
    step: 'image_prompts',
    operation: 'write_image_prompts',
    shot_id: null,
    element_id: null,
    state: 'generating',
    started_at: new Date().toISOString(),
  })
  expect(error).toBeNull()
  const pathname = `/projects/${projectId}/image_prompts`
  const count = countRequests(page, isRefreshOf(pathname))
  await page.clock.install()
  await page.goto(pathname)
  await assertPausesAndResumes(page, count, 4000)
})
