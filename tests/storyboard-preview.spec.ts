import { test, expect, type Page } from '@playwright/test'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import type { AspectRatio } from '../src/lib/config/enums'
import { MIX_STEP_DB, MIX_VOICE_GAIN_DB, PREVIEW_MIX_MIN_WIDTH_PX, PREVIEW_PLAYER_SIZES } from '../src/lib/config/storyboard'

// Storyboard E: the transport, the shared playhead, Preview & mix and the mini player
// (canvas 15b / 15h / 15i). Every save is a real server action against a real row; no
// provider is ever reached - the seeded projects carry no voiceover, so the film plays silent.

const NAVIGATION = { timeout: 45000 }

test.setTimeout(120000)

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

async function seed(opts: { durations?: number[]; generating?: number[]; aspectRatio?: AspectRatio } = {}) {
  const durations = opts.durations ?? [6, 6, 6]
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Storyboard preview',
      source_text: 'A short film.',
      aspect_ratio: opts.aspectRatio ?? '9:16',
      video_model: 'wan-2.5',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  seededProjects.push(projectId)
  const rows = durations.map((d, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: shotKey(),
    voice_over: `Line ${i + 1}.`,
    visual_description: `Shot description ${i + 1}`,
    duration_sec: d,
    image_prompt: `Prompt ${i + 1}`,
  }))
  const { data: shots, error: shotError } = await admin.from('shots').insert(rows).select('id, order_index')
  expect(shotError).toBeNull()
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string)
  const now = new Date().toISOString()
  for (const [i, shotId] of ids.entries()) {
    if (opts.generating?.includes(i)) {
      await admin.from('generations').insert({
        project_id: projectId,
        step: 'storyboard',
        operation: 'generate_image',
        shot_id: shotId,
        element_id: null,
        state: 'generating',
        started_at: now,
      })
      continue
    }
    const imagePath = `${primary.user.id}/${projectId}/images/${shotId}/${crypto.randomUUID()}.webp`
    const bytes = await image()
    await admin.storage.from('artifacts').upload(imagePath, bytes, { contentType: 'image/webp' })
    await admin.storage.from('artifacts').upload(imagePath.replace(/\.webp$/, '_thumb.webp'), bytes, { contentType: 'image/webp' })
    await admin.from('shots').update({ image_path: imagePath }).eq('id', shotId)
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'storyboard',
      operation: 'generate_image',
      shot_id: shotId,
      element_id: null,
      state: 'succeeded',
    })
  }
  return { projectId, ids }
}

// Seeded live claims count against primary's balance in other specs' gates - release them.
test.afterEach(async () => {
  const ids = seededProjects.splice(0)
  if (ids.length === 0) return
  await admin.from('generations').update({ state: 'failed', queued_at: null }).in('project_id', ids).eq('state', 'generating')
})

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('storyboard-main')).toBeVisible(NAVIGATION)
  await expect(page.getByTestId('picture-lane')).toHaveAttribute('data-layout', 'measured')
}

async function playheadSeconds(page: Page) {
  return Number(await page.getByTestId('playhead').getAttribute('data-seconds'))
}

async function mixRow(projectId: string) {
  const { data } = await admin
    .from('projects')
    .select('mix_voice_gain_db, mix_music_gain_db, mix_duck_depth_db, mix_duck_bypass, music_muted')
    .eq('id', projectId)
    .single()
  return data!
}

test.describe('storyboard preview - transport', () => {
  test.use({ viewport: { width: 1920, height: 1200 } })

  test('Play is disabled while a frame is still drawing, and Preview stays locked at the player height', async ({ page }) => {
    const { projectId } = await seed({ generating: [1] })
    await open(page, projectId)
    const play = page.getByTestId('transport-play')
    await expect(play).toBeDisabled()
    await expect(play).toHaveAttribute('title', 'Available once every frame is ready.')
    await expect(page.getByTestId('preview-locked')).toBeVisible()
    await expect(page.getByTestId('preview-mix')).toHaveCount(0)
    const well = await page.getByTestId('preview-locked-well').boundingBox()
    expect(Math.round(well!.height)).toBe(480)
    // Space does nothing while locked.
    await page.keyboard.press('Space')
    await expect(play).toHaveAttribute('aria-pressed', 'false')
  })

  test('scrubbing seeks even while frames are drawing', async ({ page }) => {
    const { projectId } = await seed({ generating: [2] })
    await open(page, projectId)
    const ruler = page.getByTestId('ruler')
    const box = (await ruler.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    expect(await playheadSeconds(page)).toBeCloseTo(9, 0)
    await expect(page.getByTestId('transport-time')).toContainText('/ 0:18')

    // Dragging the handle moves the time only.
    const handle = (await page.getByTestId('playhead-handle').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.25, handle.y + handle.height / 2, { steps: 5 })
    await page.mouse.up()
    expect(await playheadSeconds(page)).toBeCloseTo(4.5, 0)
    await expect(page.getByTestId('transport-time')).toHaveText(/^0:0[45]\.\d \/ 0:18$/)
  })

  test('Space toggles play from anywhere, except while typing in a field', async ({ page }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    const play = page.getByTestId('transport-play')
    await expect(play).toBeEnabled()
    await expect(page.getByTestId('preview-mix')).toBeVisible()

    await page.keyboard.press('Space')
    await expect(play).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(0.3)
    await page.keyboard.press('Space')
    await expect(play).toHaveAttribute('aria-pressed', 'false')
    const paused = await playheadSeconds(page)
    await page.waitForTimeout(400)
    expect(await playheadSeconds(page)).toBe(paused)

    // Typing a space into the inspect panel's prompt is text, not a transport command.
    await page.locator(`[data-testid="shot-slot"][data-shot-id="${ids[0]}"] [data-testid="shot-block"]`).click()
    const prompt = page.getByTestId('inspect-panel').locator('textarea')
    await prompt.click()
    await page.keyboard.press('Space')
    await expect(play).toHaveAttribute('aria-pressed', 'false')
    await expect(prompt).toHaveValue(/ /)
  })

  test('the transport button and the preview play button drive the same clock', async ({ page }) => {
    const { projectId } = await seed()
    await open(page, projectId)
    await page.getByTestId('preview-play').click()
    await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('transport-play').click()
    await expect(page.getByTestId('preview-play')).toHaveAttribute('aria-label', 'Play')
  })
})

test.describe('storyboard preview - mini player', () => {
  test.use({ viewport: { width: 1440, height: 820 } })

  test('shows only while Preview is off-screen, hides when it scrolls into view, and closing it pauses', async ({ page }) => {
    const { projectId } = await seed({ durations: [8, 8, 8] })
    await open(page, projectId)
    await expect(page.getByTestId('preview-player')).not.toBeInViewport()
    await expect(page.getByTestId('mini-player')).toHaveCount(0)

    await page.getByTestId('transport-play').click()
    await expect(page.getByTestId('mini-player')).toBeVisible()
    const box = (await page.getByTestId('mini-player').boundingBox())!
    // 9:16: 240px on its long edge, so 135 wide.
    expect(Math.round(box.width)).toBe(135)

    await page.getByTestId('preview-player').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('mini-player')).toHaveCount(0)
    await page.getByTestId('storyboard-main').evaluate((el) => (el.scrollTop = 0))
    await expect(page.getByTestId('mini-player')).toBeVisible()

    await page.getByTestId('mini-player-close').click()
    await expect(page.getByTestId('mini-player')).toHaveCount(0)
    await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'false')
  })

  test('never appears while paused', async ({ page }) => {
    const { projectId } = await seed()
    await open(page, projectId)
    await page.getByTestId('storyboard-main').evaluate((el) => (el.scrollTop = 0))
    await page.waitForTimeout(300)
    await expect(page.getByTestId('mini-player')).toHaveCount(0)
  })
})

test.describe('storyboard preview - player size by ratio', () => {
  test.use({ viewport: { width: 1920, height: 1200 } })

  // Canvas 15b / 15i: 9:16 is 270 × 480 and 1:1 400 × 400. 16:9 is capped at the same 480px
  // height (853 × 480) rather than 15i's full section width. The mix sits beside the player
  // whenever the card can hold both.
  for (const [ratio, size] of Object.entries(PREVIEW_PLAYER_SIZES) as [AspectRatio, { width: number; height: number }][]) {
    test(`${ratio} is ${size.width} × ${size.height} with the mix beside it`, async ({ page }) => {
      const { projectId } = await seed({ aspectRatio: ratio })
      await open(page, projectId)
      const box = (await page.getByTestId('preview-player').boundingBox())!
      expect([Math.round(box.width), Math.round(box.height)]).toEqual([size.width, size.height])
      await expect(page.getByTestId('preview-card')).toHaveAttribute('data-layout', 'row')
      const slider = (await page.getByTestId('mix-slider-mix_voice_gain_db').boundingBox())!
      expect(slider.x).toBeGreaterThan(box.x + box.width)
      expect(slider.width).toBeGreaterThan(0)
    })
  }

  test('16:9 stacks the mix below the player when the column is too narrow for both', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 })
    const { projectId } = await seed({ aspectRatio: '16:9' })
    await open(page, projectId)
    const card = (await page.getByTestId('preview-card').boundingBox())!
    expect(card.width - 30).toBeLessThan(PREVIEW_PLAYER_SIZES['16:9'].width + 16 + PREVIEW_MIX_MIN_WIDTH_PX)
    await expect(page.getByTestId('preview-card')).toHaveAttribute('data-layout', 'stacked')
    const box = (await page.getByTestId('preview-player').boundingBox())!
    expect(box.width / box.height).toBeCloseTo(16 / 9, 1)
    const slider = (await page.getByTestId('mix-slider-mix_voice_gain_db').boundingBox())!
    expect(slider.y).toBeGreaterThan(box.y + box.height)
  })
})

test.describe('storyboard preview - mixer', () => {
  test.use({ viewport: { width: 1920, height: 1200 } })

  test('a slider change persists; double-click resets it to the default; Reset mix clears every setting', async ({ page }) => {
    const { projectId } = await seed()
    await open(page, projectId)
    const voice = page.getByTestId('mix-slider-mix_voice_gain_db')
    await expect(voice).toHaveAttribute('aria-valuenow', String(MIX_VOICE_GAIN_DB.default))

    await voice.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    const expected = MIX_VOICE_GAIN_DB.default - 2 * MIX_STEP_DB
    await expect(voice).toHaveAttribute('aria-valuenow', String(expected))
    await expect.poll(async () => (await mixRow(projectId)).mix_voice_gain_db).toBe(expected)

    await page.reload()
    await expect(page.getByTestId('mix-slider-mix_voice_gain_db')).toHaveAttribute('aria-valuenow', String(expected))

    await page.getByTestId('mix-slider-mix_voice_gain_db').dblclick()
    await expect(page.getByTestId('mix-slider-mix_voice_gain_db')).toHaveAttribute('data-default', 'true')
    await expect.poll(async () => (await mixRow(projectId)).mix_voice_gain_db).toBeNull()

    await page.getByTestId('mix-slider-mix_duck_depth_db').focus()
    await page.keyboard.press('ArrowRight')
    await page.getByTestId('mix-bypass').click()
    await expect.poll(async () => (await mixRow(projectId)).mix_duck_bypass).toBe(true)
    await expect.poll(async () => (await mixRow(projectId)).mix_duck_depth_db).not.toBeNull()

    await page.getByTestId('mix-reset').click()
    await expect.poll(() => mixRow(projectId)).toEqual({
      mix_voice_gain_db: null,
      mix_music_gain_db: null,
      mix_duck_depth_db: null,
      mix_duck_bypass: null,
      music_muted: null,
    })
    await expect(page.getByTestId('mix-bypass')).toHaveAttribute('aria-checked', 'false')
  })

  test('changing the mix marks nothing stale', async ({ page }) => {
    const { projectId } = await seed()
    await open(page, projectId)
    await page.getByTestId('mix-slider-mix_music_gain_db').focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await mixRow(projectId)).mix_music_gain_db).not.toBeNull()
    const { data: shots } = await admin
      .from('shots')
      .select('image_stale, image_prompt_stale, video_prompt_stale')
      .eq('project_id', projectId)
    expect(shots!.every((s) => !s.image_stale && !s.image_prompt_stale && !s.video_prompt_stale)).toBe(true)
    const { data: project } = await admin.from('projects').select('voiceover_stale').eq('id', projectId).single()
    expect(project!.voiceover_stale).toBe(false)
  })
})
