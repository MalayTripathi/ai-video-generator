import { test, expect, type Page } from '@playwright/test'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex, stepLabel } from '../src/lib/config/pipeline'
import { STORYBOARD_MAX_SHOT_SEC, STORYBOARD_MIN_SHOT_SEC } from '../src/lib/config/storyboard'
import { VIDEO_MODELS, videoModelMaxSeconds } from '../src/lib/config/models'

// Storyboard B2: retime, reorder, bin, zoom and the playhead on the picture lane (canvas
// 15b/15c). Every save is a real server action against a real row; the only stubs are a
// forced save failure and a delayed save. Nothing here reaches an image or Claude provider.

const NAVIGATION = { timeout: 45000 }
const VIDEO_MODEL = 'Kling 2.1'
// Kling 2.1's longest clip (10s). Storyboard lengths deliberately ignore it.
const MODEL_MAX = videoModelMaxSeconds(VIDEO_MODELS[VIDEO_MODEL])

test.use({ viewport: { width: 1920, height: 1200 } })
test.setTimeout(120000)

type Seeded = 'ready' | 'not_generated' | 'generating'
type ShotSpec = { state: Seeded; duration?: number }

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
function shotKey() {
  return Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')
}

let tinyImage: Buffer | null = null
async function image() {
  tinyImage ??= await sharp({ create: { width: 18, height: 32, channels: 3, background: { r: 90, g: 120, b: 160 } } })
    .webp()
    .toBuffer()
  return tinyImage
}

const seededProjects: string[] = []

async function seed(specs: ShotSpec[], opts: { furthestStep?: number } = {}) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Storyboard editing',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      aspect_ratio: '9:16',
      video_model: VIDEO_MODEL,
      current_step: 'storyboard',
      furthest_step: opts.furthestStep ?? stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  seededProjects.push(projectId)

  const rows = specs.map((spec, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: shotKey(),
    voice_over: `Line ${i + 1}.`,
    visual_description: `Shot description ${i + 1}`,
    duration_sec: spec.duration ?? 5,
    section_label: null,
    image_prompt: `Prompt for shot ${i + 1}, long enough to read as written.`,
    image_prompt_edited: false,
    image_prompt_stale: false,
    image_stale: false,
    image_path: null as string | null,
    film_order: null,
    film_duration_sec: null,
    binned_at: null,
  }))
  const { data: shots, error: shotError } = await admin.from('shots').insert(rows).select('id, order_index')
  expect(shotError).toBeNull()
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string)

  for (const [i, spec] of specs.entries()) {
    if (spec.state === 'not_generated') continue
    const shotId = ids[i]
    if (spec.state === 'ready') {
      const imagePath = `${primary.user.id}/${projectId}/images/${shotId}/${crypto.randomUUID()}.webp`
      await admin.storage.from('artifacts').upload(imagePath, await image(), { contentType: 'image/webp' })
      await admin.from('shots').update({ image_path: imagePath }).eq('id', shotId)
    }
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'storyboard',
      operation: 'generate_image',
      shot_id: shotId,
      element_id: null,
      state: spec.state === 'ready' ? 'succeeded' : 'generating',
      started_at: spec.state === 'generating' ? new Date().toISOString() : null,
      queued_at: null,
    })
  }
  return { projectId, ids }
}

// Seeded live claims count against primary's balance in other specs' gates - release them.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  const ids = seededProjects.splice(0)
  if (ids.length === 0) return
  await admin.from('generations').update({ state: 'failed', queued_at: null }).in('project_id', ids).eq('state', 'generating')
})

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('storyboard-main')).toBeVisible(NAVIGATION)
  await expect(page.getByTestId('picture-lane')).toHaveAttribute('data-layout', 'measured')
}

// Server-action POSTs carry a next-action header - every timeline save is one.
function countActionPosts(page: Page) {
  const posts: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.headers()['next-action']) posts.push(req.url())
  })
  return posts
}

async function shotRows(projectId: string) {
  const { data } = await admin
    .from('shots')
    .select('id, order_index, duration_sec, film_order, film_duration_sec, binned_at, image_path, image_stale, image_prompt_stale, video_prompt_stale')
    .eq('project_id', projectId)
    .order('order_index')
  return data!
}

async function row(projectId: string, shotId: string) {
  return (await shotRows(projectId)).find((r) => r.id === shotId)!
}

function block(page: Page, shotId: string) {
  return page.locator(`[data-testid="shot-block"][data-shot-id="${shotId}"]`)
}

function grip(page: Page, shotId: string) {
  return page.locator(`[data-testid="shot-grip"][data-shot-id="${shotId}"]`)
}

async function laneOrder(page: Page) {
  return page.getByTestId('shot-slot').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.shotId))
}

async function center(page: Page, locator: ReturnType<Page['locator']>) {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.describe('storyboard editing - retime', () => {
  test('a boundary drag shows the tooltip and pending Total, snaps to 0.1s, and saves only film_duration_sec on drop', { tag: '@smoke' }, async ({
    page,
  }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)
    await expect(page.getByTestId('timeline-total')).toHaveText('Total 0:15 · provisional')

    const start = await center(page, grip(page, ids[0]))
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 60, start.y, { steps: 6 })

    const tooltip = page.getByTestId('retime-tooltip')
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toHaveText(/^5\.0s → \d+\.\ds$/)
    const pending = page.getByTestId('timeline-total-pending')
    await expect(pending).toBeVisible()
    await expect(pending).toContainText('pending')
    await expect(page.getByTestId('timeline-total')).toBeHidden()
    const label = (await tooltip.textContent())!
    const seconds = Number(label.split('→')[1].trim().replace('s', ''))
    expect(seconds).toBeGreaterThan(5)
    // Snapped: one decimal, exactly.
    expect(Math.round(seconds * 10)).toBeCloseTo(seconds * 10, 6)

    await page.mouse.up()
    await expect(tooltip).toBeHidden()
    await expect(page.getByTestId('timeline-total')).toBeVisible()
    await expect(block(page, ids[0])).toContainText(`${seconds.toFixed(1)}s`)
    await expect.poll(async () => (await row(projectId, ids[0])).film_duration_sec).toBe(seconds)
    const saved = await row(projectId, ids[0])
    // Script length untouched; retime is free and marks nothing stale.
    expect(saved.duration_sec).toBe(5)
    expect(saved.image_stale).toBe(false)
    expect(saved.image_prompt_stale).toBe(false)
    expect(saved.video_prompt_stale).toBe(false)
  })

  test('a drag clamps to the 1.0s floor and the 30s ceiling, past the video model’s clip limit', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)
    const tooltip = page.getByTestId('retime-tooltip')

    let at = await center(page, grip(page, ids[1]))
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x - 1500, at.y, { steps: 8 })
    await expect(tooltip).toHaveText(`5.0s → ${STORYBOARD_MIN_SHOT_SEC.toFixed(1)}s`)
    await page.mouse.up()
    await expect.poll(async () => (await row(projectId, ids[1])).film_duration_sec).toBe(STORYBOARD_MIN_SHOT_SEC)

    at = await center(page, grip(page, ids[1]))
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 3000, at.y, { steps: 8 })
    await expect(tooltip).toHaveText(`1.0s → ${STORYBOARD_MAX_SHOT_SEC.toFixed(1)}s`)
    await page.mouse.up()
    await expect.poll(async () => (await row(projectId, ids[1])).film_duration_sec).toBe(STORYBOARD_MAX_SHOT_SEC)
    expect(STORYBOARD_MAX_SHOT_SEC).toBeGreaterThan(MODEL_MAX)
    await expect(block(page, ids[1])).toContainText('30.0s')
  })

  test('the last shot has an end handle, and ←/→ on a focused boundary nudges ±0.1s, saving each press', async ({
    page,
  }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)

    const end = grip(page, ids[1])
    const box = (await end.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(8)

    await grip(page, ids[0]).focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(grip(page, ids[0])).toHaveAttribute('aria-valuetext', '5.3s')
    await expect.poll(async () => (await row(projectId, ids[0])).film_duration_sec).toBe(5.3)
    await page.keyboard.press('ArrowLeft')
    await expect(grip(page, ids[0])).toHaveAttribute('aria-valuetext', '5.2s')
    await expect.poll(async () => (await row(projectId, ids[0])).film_duration_sec).toBe(5.2)
    await expect(page.getByTestId('timeline-total')).toHaveText('Total 0:10 · provisional')
  })

  test('Esc cancels a drag: nothing saves and the lane returns to its committed widths', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)
    const posts = countActionPosts(page)
    const slot = page.locator(`[data-testid="shot-slot"][data-shot-id="${ids[0]}"]`)
    const before = (await slot.boundingBox())!.width

    const at = await center(page, grip(page, ids[0]))
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 80, at.y, { steps: 5 })
    await expect(page.getByTestId('retime-tooltip')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.mouse.up()

    await expect(page.getByTestId('retime-tooltip')).toBeHidden()
    expect((await slot.boundingBox())!.width).toBeCloseTo(before, 0)
    await expect(page.getByTestId('timeline-total')).toHaveText('Total 0:15 · provisional')

    // A cancelled shot drag also leaves the order alone.
    const from = await center(page, block(page, ids[2]))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x - 600, from.y, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await laneOrder(page)).toEqual(ids)

    await page.waitForTimeout(500)
    expect(posts).toEqual([])
    const rows = await shotRows(projectId)
    expect(rows.every((r) => r.film_duration_sec === null && r.film_order === null)).toBe(true)
  })
})

test.describe('storyboard editing - reorder', () => {
  test('dragging a shot persists film_order, and restoring script order resets it', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)

    const from = await center(page, block(page, ids[3]))
    const to = await center(page, block(page, ids[0]))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x - 20, to.y, { steps: 12 })
    await page.mouse.up()

    const expected = [ids[3], ids[0], ids[1], ids[2]]
    await expect.poll(() => laneOrder(page)).toEqual(expected)
    // A drag is not a click: nothing was selected.
    await expect(page.getByTestId('inspect-panel')).toHaveCount(0)
    await expect
      .poll(async () => {
        const rows = await shotRows(projectId)
        return [...rows].sort((a, b) => (a.film_order ?? a.order_index) - (b.film_order ?? b.order_index)).map((r) => r.id)
      })
      .toEqual(expected)
    const rows = await shotRows(projectId)
    // Script order is never written by the Storyboard.
    expect(rows.map((r) => r.order_index)).toEqual([0, 1, 2, 3])

    // The order-differs banner waits on a voiceover, which doesn't exist yet.
    await expect(page.getByTestId('order-differs-banner')).toHaveCount(0)

    const { restoreScriptOrderForUser } = await import('../src/app/(app)/projects/[id]/storyboard/actions')
    expect(await restoreScriptOrderForUser(admin, primary.user.id, projectId)).toEqual({ success: true })
    expect((await shotRows(projectId)).every((r) => r.film_order === null)).toBe(true)
  })

  test('Alt+←/→ on a focused shot moves it one place and saves', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)

    await block(page, ids[2]).focus()
    await page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => laneOrder(page)).toEqual([ids[0], ids[2], ids[1]])
    await expect(block(page, ids[2])).toBeFocused()
    await page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => laneOrder(page)).toEqual([ids[2], ids[0], ids[1]])
    await expect
      .poll(async () => (await shotRows(projectId)).map((r) => r.film_order))
      .toEqual([1, 2, 0])
    await page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => laneOrder(page)).toEqual([ids[0], ids[2], ids[1]])
  })

  test('a click without movement selects the shot and saves nothing', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)
    const posts = countActionPosts(page)
    const at = await center(page, block(page, ids[1]))
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 2, at.y)
    await page.mouse.up()
    await expect(page.getByTestId('inspect-panel')).toBeVisible()
    await expect(block(page, ids[1])).toHaveAttribute('data-selected', 'true')
    expect(await laneOrder(page)).toEqual(ids)
    expect(posts).toEqual([])
  })
})

test.describe('storyboard editing - bin', () => {
  test('Remove excludes a shot from the total, counter, Continue count and Preview lock; Restore returns it to its slot', async ({
    page,
  }) => {
    const { projectId, ids } = await seed([
      { state: 'ready', duration: 5 },
      { state: 'not_generated', duration: 6 },
      { state: 'ready', duration: 4 },
    ])
    await open(page, projectId)

    await expect(page.getByTestId('frames-ready')).toHaveText('2 of 3 frames ready')
    await expect(page.getByTestId('timeline-total')).toHaveText('Total 0:15 · provisional')
    await expect(page.getByTestId('continue-label')).toHaveText(`Continue to ${stepLabel('video_prompts')} (3 clips)`)
    await expect(page.getByTestId('preview-locked-reason')).toContainText("hasn't been generated")
    await expect(page.getByTestId('bin-control')).toHaveCount(0)
    const zoomX = (await page.getByTestId('zoom-controls').boundingBox())!.x
    const totalX = (await page.getByTestId('timeline-total').boundingBox())!.x

    await block(page, ids[1]).click()
    await page.getByTestId('inspect-remove').click()
    // The removed shot was selected; the inspect panel closes with it.
    await expect(page.getByTestId('inspect-panel')).toHaveCount(0)
    await expect(block(page, ids[1])).toHaveCount(0)

    await expect(page.getByTestId('frames-ready')).toHaveText('2 of 2 frames ready')
    await expect(page.getByTestId('timeline-total')).toHaveText('Total 0:09 · provisional')
    await expect(page.getByTestId('continue-label')).toHaveText(`Continue to ${stepLabel('video_prompts')} (2 clips)`)
    // Every in-film frame is ready once the ungenerated shot is binned: Preview unlocks.
    await expect(page.getByTestId('preview-locked')).toHaveCount(0)
    await expect(page.getByTestId('preview-mix')).toBeVisible()

    // Icon and count only, labelled by tooltip and aria-label; nothing else in the header moved.
    const bin = page.getByTestId('bin-control')
    await expect(bin).toHaveText('1')
    await expect(bin).toHaveAttribute('title', 'Bin · 1 removed shot')
    await expect(bin).toHaveAttribute('aria-label', 'Bin · 1 removed shot')
    expect((await page.getByTestId('zoom-controls').boundingBox())!.x).toBe(zoomX)
    expect((await page.getByTestId('timeline-total').boundingBox())!.x).toBe(totalX)

    await expect.poll(async () => (await row(projectId, ids[1])).binned_at).not.toBeNull()
    const binned = await row(projectId, ids[1])
    expect(binned.film_order).toBeNull()
    expect(binned.image_stale).toBe(false)

    // Delete on a focused shot removes too.
    await block(page, ids[2]).focus()
    await page.keyboard.press('Delete')
    await expect(bin).toHaveText('2')
    await expect(bin).toHaveAttribute('aria-label', 'Bin · 2 removed shots')

    await bin.click()
    const popover = page.getByTestId('bin-popover')
    await expect(popover).toContainText('Removed shots')
    await expect(popover).toContainText('restoring is free')
    await popover.locator(`[data-testid="bin-row"][data-shot-id="${ids[1]}"]`).getByTestId('bin-restore').click()
    await popover.locator(`[data-testid="bin-row"][data-shot-id="${ids[2]}"]`).getByTestId('bin-restore').click()

    await expect(page.getByTestId('bin-control')).toHaveCount(0)
    await expect.poll(() => laneOrder(page)).toEqual(ids)
    await expect(page.getByTestId('continue-label')).toHaveText(`Continue to ${stepLabel('video_prompts')} (3 clips)`)
    await expect.poll(async () => (await shotRows(projectId)).every((r) => r.binned_at === null)).toBe(true)
    // The image was kept throughout.
    expect((await row(projectId, ids[0])).image_path).not.toBeNull()
  })
})

test.describe('storyboard editing - saves', () => {
  test('a failed save rolls the change back and shows an inline error', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)
    await page.route(`**/projects/${projectId}/storyboard`, async (route) => {
      if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
        await route.fulfill({ status: 500, body: 'boom' })
      } else {
        await route.fallback()
      }
    })

    await grip(page, ids[0]).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('alert').filter({ hasText: "couldn't be saved" })).toBeVisible()
    await expect(grip(page, ids[0])).toHaveAttribute('aria-valuetext', '5.0s')
    await expect(block(page, ids[0])).toContainText('5.0s')

    await block(page, ids[1]).focus()
    await page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => laneOrder(page)).toEqual(ids)

    const rows = await shotRows(projectId)
    expect(rows.every((r) => r.film_duration_sec === null && r.film_order === null)).toBe(true)
  })

  test('a status poll during a pending save never overwrites the local edit', async ({ page }) => {
    // Shot 2 is in flight, so the page polls every few seconds.
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'generating' }])
    let polls = 0
    await page.route('**/api/projects/*/images/status', async (route) => {
      polls++
      await route.fallback()
    })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route(`**/projects/${projectId}/storyboard`, async (route) => {
      if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
        await held
        await route.fallback()
      } else {
        await route.fallback()
      }
    })
    await open(page, projectId)

    await grip(page, ids[0]).focus()
    await page.keyboard.press('ArrowRight')
    await expect(block(page, ids[0])).toContainText('5.1s')
    const before = polls
    await expect.poll(() => polls, { timeout: 20000 }).toBeGreaterThan(before)
    // The save is still held; a poll has landed; the edit stands.
    await expect(block(page, ids[0])).toContainText('5.1s')
    await expect(grip(page, ids[0])).toHaveAttribute('aria-valuetext', '5.1s')

    release()
    await expect.poll(async () => (await row(projectId, ids[0])).film_duration_sec).toBe(5.1)
    await expect(block(page, ids[0])).toContainText('5.1s')
  })

  test('the server actions refuse off-grid and out-of-range lengths and a locked storyboard, and never write script values', async () => {
    const { saveFilmDurationForUser, saveFilmOrderForUser, setShotBinnedForUser } = await import(
      '../src/app/(app)/projects/[id]/storyboard/actions'
    )
    const { projectId, ids } = await seed([{ state: 'not_generated' }, { state: 'not_generated' }])
    const uid = primary.user.id

    expect((await saveFilmDurationForUser(admin, uid, projectId, ids[0], STORYBOARD_MAX_SHOT_SEC + 0.1)).success).toBe(false)
    expect((await saveFilmDurationForUser(admin, uid, projectId, ids[0], 0.9)).success).toBe(false)
    expect((await saveFilmDurationForUser(admin, uid, projectId, ids[0], 5.25)).success).toBe(false)
    expect(await saveFilmDurationForUser(admin, uid, projectId, ids[0], 5)).toEqual({ success: true, unchanged: true })
    expect(await saveFilmDurationForUser(admin, uid, projectId, ids[0], 6.2)).toEqual({ success: true })
    // Past the video model's 10s clip, up to the storyboard's own 30s ceiling.
    expect(await saveFilmDurationForUser(admin, uid, projectId, ids[1], 25)).toEqual({ success: true })
    expect(await saveFilmOrderForUser(admin, uid, projectId, [{ id: ids[0], film_order: 1 }, { id: ids[1], film_order: 0 }])).toEqual({
      success: true,
    })
    expect((await setShotBinnedForUser(admin, uid, projectId, ids[1], true)).success).toBe(true)

    const rows = await shotRows(projectId)
    expect(rows.map((r) => [r.order_index, r.duration_sec])).toEqual([
      [0, 5],
      [1, 5],
    ])
    expect(rows[0].film_duration_sec).toBe(6.2)
    expect(rows.map((r) => r.film_order)).toEqual([1, 0])
    expect(rows.every((r) => !r.image_stale && !r.image_prompt_stale && !r.video_prompt_stale)).toBe(true)

    // Another user's project is not found; a locked storyboard refuses.
    expect((await saveFilmDurationForUser(admin, crypto.randomUUID(), projectId, ids[0], 5)).success).toBe(false)
    const locked = await seed([{ state: 'not_generated' }], { furthestStep: stepIndex('video_prompts') })
    const refused = await saveFilmDurationForUser(admin, uid, locked.projectId, locked.ids[0], 6)
    expect(refused).toEqual({ success: false, error: 'The storyboard is locked' })
    expect((await row(locked.projectId, locked.ids[0])).film_duration_sec).toBeNull()
  })
})

test.describe('storyboard editing - zoom and playhead', () => {
  test('+ zooms past Fit and the lane scrolls; Fit returns; the playhead moves by ruler click and by drag', async ({
    page,
  }) => {
    const { projectId } = await seed([{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }, { state: 'ready' }])
    await open(page, projectId)
    const scroller = page.getByTestId('lane-scroller')
    const widths = () => scroller.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))

    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
    expect((await widths()).scroll).toBeLessThanOrEqual((await widths()).client + 1)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect.poll(async () => (await widths()).scroll > (await widths()).client + 10).toBe(true)
    await page.getByRole('button', { name: 'Fit' }).click()
    await expect.poll(async () => (await widths()).scroll <= (await widths()).client + 1).toBe(true)

    const playhead = page.getByTestId('playhead')
    await expect(playhead).toHaveAttribute('data-seconds', '0.00')
    const ruler = (await page.getByTestId('ruler').boundingBox())!
    await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2)
    await expect.poll(async () => Number(await playhead.getAttribute('data-seconds'))).toBeCloseTo(10, 0)

    const handle = await center(page, page.getByTestId('playhead-handle'))
    await page.mouse.move(handle.x, handle.y)
    await page.mouse.down()
    await page.mouse.move(ruler.x + ruler.width / 4, handle.y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => Number(await playhead.getAttribute('data-seconds'))).toBeCloseTo(5, 0)
  })

  test('while zoomed in, holding a shot drag near the lane edge scrolls the lane', async ({ page }) => {
    const { projectId, ids } = await seed(Array.from({ length: 8 }, () => ({ state: 'ready' as const })))
    await open(page, projectId)
    for (let i = 0; i < 4; i++) {
      const zoomIn = page.getByRole('button', { name: 'Zoom in' })
      if (await zoomIn.isEnabled()) await zoomIn.click()
    }
    const scroller = page.getByTestId('lane-scroller')
    await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 10)).toBe(true)
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(0)

    const box = (await scroller.boundingBox())!
    const from = await center(page, block(page, ids[0]))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 6, from.y, { steps: 10 })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await laneOrder(page)).toEqual(ids)
  })

  test('while zoomed in, dragging the playhead past the visible edge scrolls the lane and keeps scrubbing', async ({
    page,
  }) => {
    const { projectId } = await seed(Array.from({ length: 8 }, () => ({ state: 'ready' as const })))
    await open(page, projectId)
    for (let i = 0; i < 4; i++) {
      const zoomIn = page.getByRole('button', { name: 'Zoom in' })
      if (await zoomIn.isEnabled()) await zoomIn.click()
    }
    const scroller = page.getByTestId('lane-scroller')
    await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 10)).toBe(true)
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(0)

    const playhead = page.getByTestId('playhead')
    const box = (await scroller.boundingBox())!
    const handle = await center(page, page.getByTestId('playhead-handle'))
    await page.mouse.move(handle.x, handle.y)
    await page.mouse.down()
    // Past the right edge, then held still: the lane keeps scrolling under the pointer.
    await page.mouse.move(box.x + box.width + 20, handle.y, { steps: 10 })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50)
    // The share of the timeline the unscrolled lane shows.
    const firstScreen = await scroller.evaluate((el) => el.clientWidth / el.scrollWidth)
    await page.mouse.up()
    // The playhead went further than the first screen of the timeline could reach.
    const seconds = Number(await playhead.getAttribute('data-seconds'))
    expect(seconds / (8 * 5)).toBeGreaterThan(firstScreen)
  })
})
