import { test, expect, type Page, type Route } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { creditsFor } from '../src/lib/config/credits'
import { STORYBOARD_IMAGE_SIZES, STORYBOARD_MAX_BLOCK_PX } from '../src/lib/config/storyboard'
import type { AspectRatio } from '../src/lib/config/enums'
import { EMPTY_IMAGE_PROMPT_MESSAGE } from '../src/lib/image-prompt-edit'
import { blockTier, LANE_GUTTER_PX, laneLayout } from '../src/lib/storyboard/timeline'

// The Storyboard page (canvas 15a/15c/15e). Frame states are real rows - seeded images,
// seeded claims - read through the real status endpoint. Every action POST is stubbed with
// page.route, so nothing here can reach an image or Claude provider.

const NAVIGATION = { timeout: 45000 }
const IMAGE_PRICE = creditsFor({ step: 'storyboard', operation: 'generate_image', quantity: 1 })
const PROMPT_PRICE = creditsFor({ step: 'image_prompts', operation: 'write_image_prompts', quantity: 1 })

test.use({ viewport: { width: 1920, height: 1200 } })
test.setTimeout(120000)

type Seeded = 'ready' | 'ready_no_thumb' | 'stale' | 'failed' | 'queued' | 'generating' | 'not_generated'

type ShotSpec = {
  state: Seeded
  duration?: number | null
  section?: string | null
  edited?: boolean
  description?: string
}

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

async function seed(specs: ShotSpec[], opts: { furthestStep?: number; aspectRatio?: AspectRatio } = {}) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Storyboard page',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      aspect_ratio: opts.aspectRatio ?? '9:16',
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
    visual_description: spec.description ?? `Shot description ${i + 1}`,
    duration_sec: spec.duration === undefined ? 5 : spec.duration,
    section_label: spec.section === undefined ? null : spec.section,
    image_prompt: `Prompt for shot ${i + 1}, long enough to read as written.`,
    image_prompt_edited: spec.edited ?? false,
    image_prompt_stale: false,
    image_stale: spec.state === 'stale',
    image_path: null as string | null,
  }))
  const { data: shots, error: shotError } = await admin.from('shots').insert(rows).select('id, order_index')
  expect(shotError).toBeNull()
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string)

  const now = new Date().toISOString()
  for (const [i, spec] of specs.entries()) {
    const shotId = ids[i]
    if (spec.state === 'ready' || spec.state === 'ready_no_thumb' || spec.state === 'stale') {
      const imagePath = `${primary.user.id}/${projectId}/images/${shotId}/${crypto.randomUUID()}.webp`
      const bytes = await image()
      await admin.storage.from('artifacts').upload(imagePath, bytes, { contentType: 'image/webp' })
      if (spec.state !== 'ready_no_thumb') {
        await admin.storage
          .from('artifacts')
          .upload(imagePath.replace(/\.webp$/, '_thumb.webp'), bytes, { contentType: 'image/webp' })
      }
      await admin.from('shots').update({ image_path: imagePath }).eq('id', shotId)
      await admin.from('generations').insert({
        project_id: projectId,
        step: 'storyboard',
        operation: 'generate_image',
        shot_id: shotId,
        element_id: null,
        state: 'succeeded',
      })
    } else if (spec.state !== 'not_generated') {
      await admin.from('generations').insert({
        project_id: projectId,
        step: 'storyboard',
        operation: 'generate_image',
        shot_id: shotId,
        element_id: null,
        state: spec.state === 'failed' ? 'failed' : 'generating',
        started_at: spec.state === 'failed' ? null : now,
        queued_at: spec.state === 'queued' ? now : null,
      })
    }
  }
  return { projectId, ids }
}

// Seeded live claims count against primary's balance in other specs' gates - release them.
test.afterEach(async () => {
  const ids = seededProjects.splice(0)
  if (ids.length === 0) return
  await admin
    .from('generations')
    .update({ state: 'failed', queued_at: null })
    .in('project_id', ids)
    .eq('state', 'generating')
})

type Captured = { url: string; body: unknown }

async function stubImagesPost(page: Page, captured: Captured[], status = 202) {
  await page.route('**/api/projects/*/images', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON()
    captured.push({ url: route.request().url(), body })
    await route.fulfill({
      status,
      json:
        status === 202
          ? { ok: true, claimed: body.shotIds, notGenerated: [], inFlight: [] }
          : { ok: false, error: 'Not enough credits', requiredCredits: IMAGE_PRICE, balanceCredits: 0 },
    })
  })
}

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('storyboard-main')).toBeVisible(NAVIGATION)
  // Hydrated and measured: the lane has switched from its first-paint flex to real widths.
  await expect(page.getByTestId('picture-lane')).toHaveAttribute('data-layout', 'measured')
}

function promptField(page: Page) {
  return page.getByTestId('inspect-prompt').getByRole('textbox', { name: 'Image prompt' })
}

// Server-action POSTs carry a next-action header - the manual-edit save is one.
function countActionPosts(page: Page) {
  const posts: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.headers()['next-action']) posts.push(req.url())
  })
  return posts
}

async function shotRow(shotId: string) {
  const { data } = await admin
    .from('shots')
    .select('image_prompt, image_prompt_edited, image_stale, updated_at')
    .eq('id', shotId)
    .single()
  return data!
}

function block(page: Page, shotId: string) {
  return page.locator(`[data-testid="shot-block"][data-shot-id="${shotId}"]`)
}

test.describe('storyboard page - picture lane', () => {
  test('every frame state renders per 15c, with prices read from credits.ts', async ({ page }) => {
    const { projectId, ids } = await seed([
      { state: 'ready' },
      { state: 'stale' },
      { state: 'failed' },
      { state: 'queued' },
      { state: 'generating' },
      { state: 'not_generated' },
    ])
    await open(page, projectId)

    const states = ['ready', 'stale', 'failed', 'queued', 'generating', 'not_generated']
    for (const [i, state] of states.entries()) {
      await expect(block(page, ids[i])).toHaveAttribute('data-state', state)
      await expect(block(page, ids[i])).toHaveAttribute('data-tier', 'wide')
    }

    await expect(block(page, ids[0])).toContainText('5.0s')
    await expect(block(page, ids[0]).getByTestId('shot-thumb')).toHaveCount(1)
    await expect(block(page, ids[1])).toContainText('Stale')
    await expect(block(page, ids[1])).toHaveClass(/border-status-stale-line/)
    await expect(block(page, ids[2]).getByTestId('shot-action')).toHaveText(`Retry${IMAGE_PRICE} cr`)
    await expect(block(page, ids[3])).toContainText(/~\d+s/)
    await expect(block(page, ids[3])).toHaveClass(/border-sb-active-line/)
    await expect(block(page, ids[4])).toContainText(/~\d+s/)
    // In flight is never amber.
    await expect(block(page, ids[4])).not.toHaveClass(/status-active|stale/)
    await expect(block(page, ids[5]).getByTestId('shot-action')).toHaveText(`Generate${IMAGE_PRICE} cr`)

    await block(page, ids[0]).click()
    await expect(block(page, ids[0])).toHaveAttribute('data-selected', 'true')
    await expect(block(page, ids[0])).toHaveClass(/outline-text-primary/)
  })

  test('fit: block widths are proportional to duration_sec, fill the lane, and the narrow threshold follows measured width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1000 })
    const durations = [12, 6, 3, 1.5, 0.8]
    const { projectId, ids } = await seed(durations.map((d) => ({ state: 'not_generated' as const, duration: d })))
    await open(page, projectId)

    const slots = page.getByTestId('shot-slot')
    await expect(slots).toHaveCount(durations.length)
    const laneWidth = (await page.getByTestId('picture-lane').boundingBox())!.width
    const layout = laneLayout(laneWidth, durations, STORYBOARD_MAX_BLOCK_PX)
    // At this width the cap does not bite: the blocks and gutters fill the lane.
    expect(Math.max(...layout.blocks)).toBeLessThan(STORYBOARD_MAX_BLOCK_PX)
    const widths = await Promise.all(ids.map(async (_, i) => (await slots.nth(i).boundingBox())!.width))
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(laneWidth, 0)

    const blocks = widths.map((w, i) => w - (i === widths.length - 1 ? 0 : LANE_GUTTER_PX))
    for (let i = 1; i < durations.length; i++) {
      expect(blocks[0] / blocks[i]).toBeCloseTo(durations[0] / durations[i], 1)
    }
    for (const [i] of durations.entries()) {
      await expect(block(page, ids[i])).toHaveAttribute('data-tier', blockTier(layout.blocks[i]))
    }
    // A narrow not-generated block carries "+" with its price in the tooltip.
    const narrowIndex = layout.blocks.findIndex((w) => blockTier(w) !== 'wide')
    expect(narrowIndex).toBeGreaterThan(-1)
    const narrowAction = block(page, ids[narrowIndex]).getByTestId('shot-action')
    await expect(narrowAction).toHaveText('+')
    await expect(narrowAction).toHaveAttribute('title', `Generate this frame · ${IMAGE_PRICE} credits`)
  })

  test('cap: a short project on a wide screen stops at the max block width, and ruler and bands match the blocks', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 2400, height: 1200 })
    const durations = [2, 4, 3]
    const { projectId, ids } = await seed(durations.map((d) => ({ state: 'not_generated' as const, duration: d })))
    await open(page, projectId)

    const laneWidth = (await page.getByTestId('picture-lane').boundingBox())!.width
    const layout = laneLayout(laneWidth, durations, STORYBOARD_MAX_BLOCK_PX)
    expect(layout.contentWidth).toBeLessThan(laneWidth)

    const blockWidths = await Promise.all(ids.map(async (id) => (await block(page, id).boundingBox())!.width))
    expect(Math.max(...blockWidths)).toBeLessThanOrEqual(STORYBOARD_MAX_BLOCK_PX + 0.5)
    expect(blockWidths[1]).toBeCloseTo(STORYBOARD_MAX_BLOCK_PX, 0)
    expect(blockWidths[0] / blockWidths[1]).toBeCloseTo(2 / 4, 2)

    const ruler = (await page.getByTestId('ruler').boundingBox())!.width
    const bands = (await page.getByTestId('scene-bands').boundingBox())!.width
    expect(ruler).toBeCloseTo(layout.contentWidth, 0)
    expect(bands).toBeCloseTo(layout.contentWidth, 0)
  })

  for (const aspectRatio of ['16:9', '9:16', '1:1'] as const) {
    test(`aspect follows the project: ${aspectRatio} thumbnail and inspect image`, async ({ page }) => {
      const { projectId, ids } = await seed([{ state: 'ready', duration: 8 }, { state: 'not_generated', duration: 8 }], {
        aspectRatio,
      })
      await open(page, projectId)
      const [w, h] = STORYBOARD_IMAGE_SIZES[aspectRatio].split('x').map(Number)

      for (const locator of [
        block(page, ids[0]).getByTestId('shot-thumb'),
        block(page, ids[1]).getByTestId('shot-thumb-empty'),
      ]) {
        const box = (await locator.boundingBox())!
        expect(box.width / box.height).toBeCloseTo(w / h, 1)
      }

      await block(page, ids[0]).click()
      const frame = (await page.getByTestId('inspect-frame').boundingBox())!
      expect(frame.width / frame.height).toBeCloseTo(w / h, 2)
      await expect(page.getByTestId('inspect-sub')).toContainText(`${w} × ${h}`)
    })
  }

  test('scene bands group consecutive section labels; counter and total read real data', async ({ page }) => {
    const { projectId } = await seed([
      { state: 'ready', section: 'Origins', duration: 5.5 },
      { state: 'stale', section: 'Origins', duration: 6 },
      { state: 'not_generated', section: 'The work', duration: 4.5 },
      { state: 'failed', section: 'The work', duration: 7 },
      { state: 'not_generated', section: 'Origins', duration: 6 },
      { state: 'ready', section: 'Origins', duration: 5 },
    ])
    await open(page, projectId)

    const bands = page.getByTestId('scene-band')
    await expect(bands).toHaveText(['Origins', 'The work', 'Origins'])
    await expect(page.getByTestId('frames-ready')).toHaveText('3 of 6 frames ready')
    await expect(page.getByTestId('timeline-total')).toHaveText('Total 0:34 · provisional')
    // Locked reason is driven by readiness: one failed, nothing in flight.
    await expect(page.getByTestId('preview-locked-reason')).toHaveText('Available once every frame is ready — one has failed.')
  })

  test('the lane uses the thumbnail, and falls back to the full image when there is none', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready_no_thumb' }])
    await open(page, projectId)

    const withThumb = await block(page, ids[0]).getByTestId('shot-thumb').getAttribute('data-src')
    const fallback = await block(page, ids[1]).getByTestId('shot-thumb').getAttribute('data-src')
    expect(withThumb).toContain('_thumb.webp')
    expect(fallback).toBeTruthy()
    expect(fallback).not.toContain('_thumb')
    expect(fallback).toContain('.webp')
  })
})

test.describe('storyboard page - actions', () => {
  test('Retry, Generate and Regenerate image send the right shot ids to the images route', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'failed' }, { state: 'not_generated' }])
    const captured: Captured[] = []
    await stubImagesPost(page, captured)
    await open(page, projectId)

    await block(page, ids[1]).getByTestId('shot-action').click()
    await expect.poll(() => captured.length).toBe(1)
    await block(page, ids[2]).getByTestId('shot-action').click()
    await expect.poll(() => captured.length).toBe(2)

    await block(page, ids[0]).click()
    const regen = page.getByTestId('inspect-regenerate-image')
    await expect(regen).toHaveText(`Regenerate image${IMAGE_PRICE} cr`)
    await regen.click()
    await expect.poll(() => captured.length).toBe(3)

    expect(captured.map((c) => c.body)).toEqual([{ shotIds: [ids[1]] }, { shotIds: [ids[2]] }, { shotIds: [ids[0]] }])
    captured.forEach((c) => expect(c.url).toContain(`/api/projects/${projectId}/images`))
  })

  test('case 2: not enough credits for the last N offers Generate remaining for exactly those frames', async ({
    page,
  }) => {
    const { projectId, ids } = await seed([
      { state: 'ready' },
      { state: 'generating' },
      { state: 'not_generated' },
      { state: 'not_generated' },
    ])
    const captured: Captured[] = []
    await stubImagesPost(page, captured)
    // Rewrite the real status response's balance only - no drain of the shared user's ledger.
    await page.route('**/api/projects/*/images/status', async (route) => {
      const response = await route.fetch()
      const json = await response.json()
      await route.fulfill({ response, json: { ...json, balanceCredits: IMAGE_PRICE } })
    })
    await open(page, projectId)

    const banner = page.getByRole('alert').filter({ hasText: 'Not enough credits for the last two frames' })
    await expect(banner).toBeVisible({ timeout: 15000 })
    await expect(banner).toContainText(
      `One frame is drawn and kept. Finishing the other two needs ${IMAGE_PRICE * 2} credits. You have ${IMAGE_PRICE} ${IMAGE_PRICE === 1 ? 'credit' : 'credits'} left.`
    )
    const button = banner.getByRole('button', { name: /Generate remaining/ })
    await expect(button).toHaveText(`Generate remaining${IMAGE_PRICE * 2} cr`)
    await button.click()
    await expect.poll(() => captured.length).toBe(1)
    expect(captured[0].body).toEqual({ shotIds: [ids[2], ids[3]] })
    // Shot 2 is in flight, so a status poll can still be mid-route when the test ends.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('a 402 from the images route shows the insufficient-credits banner', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'failed' }])
    await stubImagesPost(page, [], 402)
    await open(page, projectId)
    await block(page, ids[0]).getByTestId('shot-action').click()
    await expect(page.getByRole('alert').filter({ hasText: 'Not enough credits to draw this frame' })).toBeVisible()
  })
})

test.describe('storyboard page - polling', () => {
  test('polls only while a frame is in flight, stops once none is, and never refreshes the router', async ({ page }) => {
    const { projectId } = await seed([{ state: 'ready' }, { state: 'generating' }])
    let calls = 0
    let settled = false
    const rscRequests: string[] = []
    // router.refresh() re-fetches the current route's RSC payload.
    page.on('request', (req) => {
      if (req.headers()['rsc'] === '1' && req.url().includes(`/projects/${projectId}/storyboard`)) rscRequests.push(req.url())
    })
    await page.route('**/api/projects/*/images/status', async (route: Route) => {
      calls++
      const response = await route.fetch()
      const json = await response.json()
      if (calls >= 2) settled = true
      if (settled) {
        json.shots = json.shots.map((s: { state: string }) => ({ ...s, state: 'ready' }))
      }
      await route.fulfill({ response, json })
    })

    await open(page, projectId)
    rscRequests.length = 0
    await expect.poll(() => calls, { timeout: 20000 }).toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('frames-ready')).toHaveText('2 of 2 frames ready')
    const after = calls
    await page.waitForTimeout(8000)
    expect(calls).toBe(after)
    expect(rscRequests).toEqual([])
  })

  test('a project with nothing in flight never polls', async ({ page }) => {
    const { projectId } = await seed([{ state: 'ready' }, { state: 'not_generated' }])
    let calls = 0
    await page.route('**/api/projects/*/images/status', async (route) => {
      calls++
      await route.fallback()
    })
    await open(page, projectId)
    await page.waitForTimeout(7000)
    expect(calls).toBe(0)
  })

  test('an action restarts polling, and signed URLs are replaced on every poll', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'not_generated' }])
    const captured: Captured[] = []
    await stubImagesPost(page, captured)
    let calls = 0
    await page.route('**/api/projects/*/images/status', async (route) => {
      calls++
      const response = await route.fetch()
      const json = await response.json()
      // Keep shot 2 in flight for three polls, and stamp each response's URLs so a fresh
      // signing is observable.
      json.shots = json.shots.map((s: { shotId: string; thumbUrl: string | null }) =>
        s.shotId === ids[1]
          ? { ...s, state: calls <= 3 ? 'queued' : 'not_generated', queuedAt: new Date().toISOString() }
          : { ...s, thumbUrl: s.thumbUrl ? `${s.thumbUrl}&poll=${calls}` : s.thumbUrl }
      )
      await route.fulfill({ response, json })
    })
    await open(page, projectId)
    expect(calls).toBe(0)

    await block(page, ids[1]).getByTestId('shot-action').click()
    await expect.poll(() => calls, { timeout: 20000 }).toBeGreaterThanOrEqual(3)
    const thumb = block(page, ids[0]).getByTestId('shot-thumb')
    await expect(thumb).toHaveAttribute('data-src', /poll=3$/)
    await expect.poll(() => calls, { timeout: 20000 }).toBe(4)
    await expect(thumb).toHaveAttribute('data-src', /poll=4$/)
  })

  test('no router.refresh or useRouter anywhere in the storyboard page', () => {
    const dir = path.resolve(__dirname, '../src/app/(app)/projects/[id]/storyboard')
    const files: string[] = []
    const walk = (d: string) =>
      readdirSync(d).forEach((f) => {
        const p = path.join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(f)) files.push(p)
      })
    walk(dir)
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/router\.refresh|useRouter/)
    }
  })
})

test.describe('storyboard page - inspect panel', () => {
  test('opens on a shot, takes the agent column, and Back and × both return it with the draft kept', async ({
    page,
  }) => {
    const { projectId, ids } = await seed([{ state: 'ready', duration: 5 }, { state: 'not_generated' }])
    await open(page, projectId)

    const draft = page.getByLabel('Ask for a change')
    await draft.fill('keep this draft')
    await expect(page.getByTestId('inspect-panel')).toHaveCount(0)

    await block(page, ids[0]).click()
    const panel = page.getByTestId('inspect-panel')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('agent-column')).toBeHidden()
    await expect(panel).toContainText('Shot 1')
    await expect(page.getByTestId('inspect-sub')).toHaveText(/^Drawn \d{1,2}:\d{2} [AP]M · 1008 × 1792$/)
    await expect(page.getByTestId('inspect-duration')).toHaveText('5.0s')
    await expect(panel.locator('img')).toHaveAttribute('src', /\.webp/)
    await expect(panel.locator('img')).not.toHaveAttribute('src', /_thumb/)
    await expect(promptField(page)).toHaveValue('Prompt for shot 1, long enough to read as written.')

    await panel.getByRole('button', { name: 'Back to agent' }).click()
    await expect(page.getByTestId('inspect-panel')).toHaveCount(0)
    await expect(draft).toBeVisible()
    await expect(draft).toHaveValue('keep this draft')

    await block(page, ids[1]).click()
    await expect(page.getByTestId('inspect-panel')).toContainText('Shot 2')
    await expect(page.getByTestId('inspect-sub')).toHaveText('Not drawn yet')
    await page.getByTestId('inspect-panel').getByRole('button', { name: 'Close' }).click()
    await expect(page.getByTestId('inspect-panel')).toHaveCount(0)
    await expect(draft).toHaveValue('keep this draft')
  })

  test('Regenerate prompt shows the overwrite modal only when the prompt was edited', async ({ page }) => {
    const { projectId, ids } = await seed([
      { state: 'ready', edited: false },
      { state: 'ready', edited: true },
    ])
    const captured: Captured[] = []
    await page.route('**/api/projects/*/image-prompts', async (route) => {
      const body = route.request().postDataJSON()
      captured.push({ url: route.request().url(), body })
      const { data: shots } = await admin.from('shots').select('*').eq('project_id', projectId)
      await route.fulfill({
        status: 200,
        json: {
          shots: shots!.map((s) =>
            s.id === body.shotIds[0]
              ? { ...s, image_prompt: 'A rewritten prompt.', image_prompt_edited: false, image_stale: true }
              : s
          ),
        },
      })
    })
    await open(page, projectId)

    await block(page, ids[0]).click()
    const button = page.getByTestId('inspect-regenerate-prompt')
    await expect(button).toHaveText(`Regenerate prompt${PROMPT_PRICE} cr`)
    await button.click()
    await expect.poll(() => captured.length).toBe(1)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(captured[0].body).toEqual({ shotIds: [ids[0]], retry: true })
    await expect(promptField(page)).toHaveValue('A rewritten prompt.')

    await block(page, ids[1]).click()
    await page.getByTestId('inspect-regenerate-prompt').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Regenerate Shot 2?')
    await expect(dialog).toContainText('Your version')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(captured).toHaveLength(1)

    await page.getByTestId('inspect-regenerate-prompt').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Regenerate' }).click()
    await expect.poll(() => captured.length).toBe(2)
    expect(captured[1].body).toEqual({ shotIds: [ids[1]], retry: true })
  })

  test('a stale frame carries the stale treatment in the inspect panel', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'stale' }, { state: 'ready' }])
    await open(page, projectId)

    await block(page, ids[0]).click()
    await expect(page.getByTestId('inspect-stale-chip')).toHaveText('Stale')
    await expect(page.getByTestId('inspect-frame')).toHaveClass(/border-status-stale-line/)
    await expect(page.getByTestId('inspect-regenerate-image')).toHaveClass(/text-status-stale-fg/)
    await expect(page.getByTestId('inspect-note')).toHaveText(
      'This frame was drawn from the previous prompt. Regenerating the image clears the badge.'
    )
    await expect(page.getByTestId('inspect-note')).toHaveClass(/text-status-stale-fg/)

    await block(page, ids[1]).click()
    await expect(page.getByTestId('inspect-stale-chip')).toHaveCount(0)
    await expect(page.getByTestId('inspect-frame')).not.toHaveClass(/stale/)
    await expect(page.getByTestId('inspect-note')).toHaveText(
      'Editing marks this frame stale; it does not redraw it.'
    )
  })

  test('the prompt saves on blur, a no-op edit writes nothing, and a real edit marks the frame stale and edited', async ({
    page,
  }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }, { state: 'ready' }])
    const posts = countActionPosts(page)
    await open(page, projectId)
    await block(page, ids[0]).click()
    const field = promptField(page)
    const before = await shotRow(ids[0])

    // Focus and leave without a change: no request at all.
    await field.focus()
    await field.blur()
    // A whitespace-only change reaches the action, which diffs the trimmed value and writes nothing.
    await field.fill(`${before.image_prompt}  `)
    await field.blur()
    await expect.poll(() => posts.length).toBe(1)
    await page.waitForTimeout(500)
    const unchanged = await shotRow(ids[0])
    expect(unchanged.updated_at).toBe(before.updated_at)
    expect(unchanged.image_stale).toBe(false)
    expect(unchanged.image_prompt_edited).toBe(false)
    await expect(page.getByTestId('edited-chip')).toHaveCount(0)

    // A real edit: saved on blur, image marked stale, prompt marked edited.
    await field.fill('A lighthouse in heavy fog, lamp lit.')
    await field.blur()
    await expect.poll(async () => (await shotRow(ids[0])).image_prompt).toBe('A lighthouse in heavy fog, lamp lit.')
    const edited = await shotRow(ids[0])
    expect(edited.image_stale).toBe(true)
    expect(edited.image_prompt_edited).toBe(true)
    await expect(page.getByTestId('edited-chip')).toHaveText('Edited by you')
    await expect(block(page, ids[0])).toHaveAttribute('data-state', 'stale')
    await expect(page.getByTestId('inspect-stale-chip')).toHaveText('Stale')
    // The other shot is untouched.
    expect((await shotRow(ids[1])).image_stale).toBe(false)

    // Regenerate prompt now asks before overwriting the hand edit.
    await page.route('**/api/projects/*/image-prompts', (route) => route.abort())
    await page.getByTestId('inspect-regenerate-prompt').click()
    await expect(page.getByRole('dialog')).toContainText('Your version')
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  })

  test('an empty prompt shows the Step 3 validation error and writes nothing', async ({ page }) => {
    const { projectId, ids } = await seed([{ state: 'ready' }])
    await open(page, projectId)
    await block(page, ids[0]).click()
    const before = await shotRow(ids[0])

    const field = promptField(page)
    await field.fill('   ')
    await field.blur()
    await expect(page.getByTestId('inspect-panel').getByRole('alert')).toHaveText(EMPTY_IMAGE_PROMPT_MESSAGE)
    const after = await shotRow(ids[0])
    expect(after.image_prompt).toBe(before.image_prompt)
    expect(after.updated_at).toBe(before.updated_at)
    expect(after.image_stale).toBe(false)
  })
})
