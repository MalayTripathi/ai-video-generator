import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { STORYBOARD_MIN_SHOT_SEC } from '../src/lib/config/storyboard'

// Storyboard B3: Motion & transitions mode (canvas 15d). Every save is a real server action
// against a real row; the only stub is a forced save failure. Nothing reaches a provider.

const NAVIGATION = { timeout: 45000 }

test.use({ viewport: { width: 1920, height: 1200 } })
test.setTimeout(120000)

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
function shotKey() {
  return Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')
}

type SeedOptions = {
  furthestStep?: number
  shots?: { duration: number; transition_out?: string }[]
  /** Word boundaries of a seeded voiceover, as [start, end] pairs. */
  words?: [number, number][]
}

async function seed(opts: SeedOptions = {}) {
  const specs = opts.shots ?? [{ duration: 5 }, { duration: 5 }, { duration: 5 }]
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Storyboard motion',
      source_text: 'A short film.',
      aspect_ratio: '9:16',
      video_model: 'Kling 2.1',
      current_step: 'storyboard',
      furthest_step: opts.furthestStep ?? stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  const rows = specs.map((spec, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: shotKey(),
    voice_over: `Line ${i + 1}.`,
    visual_description: `Shot description ${i + 1}`,
    duration_sec: spec.duration,
    image_prompt: `Prompt ${i + 1}`,
    transition_out: spec.transition_out ?? null,
  }))
  const { data: shots, error: shotError } = await admin.from('shots').insert(rows).select('id, order_index')
  expect(shotError).toBeNull()
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string)

  if (opts.words) {
    // A settled read: its word boundaries live on the project, computed when it settled.
    const audioPath = `${primary.user.id}/${projectId}/voiceover/${crypto.randomUUID()}.mp3`
    await admin.storage.from('artifacts').upload(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]), { contentType: 'audio/mpeg' })
    const total = opts.words[opts.words.length - 1][1]
    const spans = ids.map((id, i) => ({
      shotId: id,
      from: 0,
      to: 0,
      text: `Line ${i + 1}.`,
      startSec: (i * total) / ids.length,
      endSec: ((i + 1) * total) / ids.length,
    }))
    await admin
      .from('projects')
      .update({
        audio_path: audioPath,
        voiceover_alignment_path: audioPath.replace('.mp3', '.alignment.json'),
        total_duration_sec: total,
        voiceover_source: 'generated',
        voiceover_generated_at: new Date().toISOString(),
        voiceover_spans: spans,
        voiceover_words: opts.words,
      })
      .eq('id', projectId)
  }
  return { projectId, ids }
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('storyboard-main')).toBeVisible(NAVIGATION)
  await expect(page.getByTestId('picture-lane')).toHaveAttribute('data-layout', 'measured')
}

async function motionMode(page: Page) {
  await page.getByRole('button', { name: 'Motion & transitions' }).click()
  await expect(page.getByRole('button', { name: 'Motion & transitions' })).toHaveAttribute('aria-pressed', 'true')
}

async function shotRows(projectId: string) {
  const { data } = await admin
    .from('shots')
    .select(
      'id, order_index, film_order, film_duration_sec, binned_at, motion, split_at, split_motion, transition_out, image_stale, image_prompt_stale, video_prompt_stale'
    )
    .eq('project_id', projectId)
    .order('order_index')
  return data!
}

async function row(projectId: string, shotId: string) {
  return (await shotRows(projectId)).find((r) => r.id === shotId)!
}

function segment(page: Page, shotId: string, seg: 'a' | 'b' = 'a') {
  return page.locator(`[data-testid="motion-segment"][data-shot-id="${shotId}"][data-segment="${seg}"]`)
}

function join(page: Page, shotId: string) {
  return page.locator(`[data-testid="join-chip"][data-shot-id="${shotId}"]`)
}

async function laneOrder(page: Page) {
  return page.getByTestId('shot-slot').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.shotId))
}

function countActionPosts(page: Page) {
  const posts: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.headers()['next-action']) posts.push(req.url())
  })
  return posts
}

test.describe('storyboard motion - mode behaviour', () => {
  test('Motion mode swaps grips for join chips, disables boundary drags and reordering, and keeps the lane geometry', async ({
    page,
  }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    const widths = async () =>
      page.getByTestId('shot-slot').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)))
    const retimeWidths = await widths()

    await motionMode(page)
    await expect(page.getByTestId('shot-grip')).toHaveCount(0)
    await expect(page.getByTestId('join-chip')).toHaveCount(2)
    expect(await widths()).toEqual(retimeWidths)

    const posts = countActionPosts(page)
    // A shot drag across the lane does nothing in Motion mode.
    const from = (await segment(page, ids[0]).boundingBox())!
    const to = (await segment(page, ids[2]).boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, { steps: 12 })
    await page.mouse.up()
    await segment(page, ids[0]).focus()
    await page.keyboard.press('Alt+ArrowRight')
    await page.waitForTimeout(300)
    expect(await laneOrder(page)).toEqual(ids)
    expect(posts).toHaveLength(0)

    await page.getByRole('button', { name: 'Retime' }).click()
    await expect(page.getByTestId('shot-grip')).toHaveCount(3)
    await expect(page.getByTestId('join-chip')).toHaveCount(0)
  })

  test('clicking a shot opens Selected shot, clicking a join opens Selected join, and neither opens the inspect panel', async ({
    page,
  }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    await motionMode(page)

    await segment(page, ids[1]).click()
    const shotPanel = page.getByTestId('selected-shot-panel')
    await expect(shotPanel).toContainText('Selected shot · 2')
    await expect(page.getByTestId('selected-join-panel')).toHaveCount(0)
    await expect(page.getByTestId('inspect-motion')).toHaveCount(0)

    await join(page, ids[0]).click()
    await expect(page.getByTestId('selected-join-panel')).toContainText('Selected join · 1 → 2')
    await expect(join(page, ids[0])).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('inspect-motion')).toHaveCount(0)
  })

  test('Delete sends the selected shot to the bin, the same as Remove', async ({ page }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    await motionMode(page)
    await segment(page, ids[1]).click()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await row(projectId, ids[1])).binned_at).not.toBeNull()
    await expect(page.getByTestId('shot-slot')).toHaveCount(2)
  })
})

test.describe('storyboard motion - edits', () => {
  test('picking a motion saves it, Film default clears it, and nothing is marked stale', async ({ page }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    await motionMode(page)
    await segment(page, ids[1]).click()
    const panel = page.getByTestId('selected-shot-panel')

    await panel.getByRole('button', { name: 'Pan up' }).click()
    await expect(segment(page, ids[1])).toHaveAttribute('data-motion', 'pan_up')
    await expect.poll(async () => (await row(projectId, ids[1])).motion).toBe('pan_up')

    await panel.getByRole('button', { name: 'Film default' }).click()
    await expect(panel.getByRole('button', { name: 'Film default' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await row(projectId, ids[1])).motion).toBeNull()

    const rows = await shotRows(projectId)
    expect(rows.every((r) => !r.image_stale && !r.image_prompt_stale && !r.video_prompt_stale)).toBe(true)
  })

  test('Split stores a fraction, each segment takes its own motion, and Remove split merges it back', async ({ page }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    await motionMode(page)
    await segment(page, ids[0]).click()
    const panel = page.getByTestId('selected-shot-panel')

    await panel.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(page.getByTestId('split-marker')).toHaveCount(1)
    await expect.poll(async () => (await row(projectId, ids[0])).split_at).toBe(0.5)
    // Still one shot: one slot per shot, and the join count is unchanged.
    await expect(page.getByTestId('shot-slot')).toHaveCount(3)
    await expect(page.getByTestId('join-chip')).toHaveCount(2)

    await segment(page, ids[0], 'b').click()
    await expect(panel).toContainText('Selected shot · 1b')
    await panel.getByRole('button', { name: 'Static' }).click()
    await expect.poll(async () => (await row(projectId, ids[0])).split_motion).toBe('static')

    await panel.getByRole('button', { name: 'Remove split' }).click()
    await expect(page.getByTestId('split-marker')).toHaveCount(0)
    await expect
      .poll(async () => {
        const r = await row(projectId, ids[0])
        return [r.split_at, r.split_motion]
      })
      .toEqual([null, null])
  })

  test('dragging the split marker clamps each segment to the minimum shot length', async ({ page }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    await motionMode(page)
    await segment(page, ids[0]).click()
    await page.getByTestId('selected-shot-panel').getByRole('button', { name: 'Split', exact: true }).click()
    await expect.poll(async () => (await row(projectId, ids[0])).split_at).toBe(0.5)

    const block = (await page.locator(`[data-testid="shot-block"][data-shot-id="${ids[0]}"]`).boundingBox())!
    const marker = (await page.getByTestId('split-marker').boundingBox())!
    await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2)
    await page.mouse.down()
    await page.mouse.move(block.x + 1, marker.y + marker.height / 2, { steps: 10 })
    await page.mouse.up()
    // 5s shot: the first segment holds at the minimum, 1.0s = 0.2.
    await expect.poll(async () => Number((await row(projectId, ids[0])).split_at)).toBeCloseTo(STORYBOARD_MIN_SHOT_SEC / 5, 3)
  })

  test('a shot too short to split shows Split unavailable, with the reason', async ({ page }) => {
    const { projectId, ids } = await seed({ shots: [{ duration: 1.5 }, { duration: 5 }] })
    await open(page, projectId)
    await motionMode(page)
    await segment(page, ids[0]).click()
    const panel = page.getByTestId('selected-shot-panel')
    await expect(panel.getByRole('button', { name: 'Split', exact: true })).toBeDisabled()
    await expect(panel.getByTestId('split-unavailable')).toContainText('at least')
  })

  test('choosing Cut on a join saves transition_out and the chip reads Cut', async ({ page }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    await motionMode(page)
    await expect(join(page, ids[0])).toHaveAttribute('data-transition', 'dissolve')
    await join(page, ids[0]).click()
    await page.getByTestId('selected-join-panel').getByRole('button', { name: 'Cut' }).click()
    await expect(join(page, ids[0])).toHaveAttribute('data-transition', 'cut')
    await expect(join(page, ids[0])).toHaveText('Cut')
    await expect.poll(async () => (await row(projectId, ids[0])).transition_out).toBe('cut')
  })

  test('a failed save rolls the change back and shows an inline error', async ({ page }) => {
    const { projectId, ids } = await seed()
    await open(page, projectId)
    await motionMode(page)
    await page.route(`**/projects/${projectId}/storyboard`, async (route) => {
      if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
        await route.fulfill({ status: 500, body: 'boom' })
      } else {
        await route.fallback()
      }
    })
    const before = await segment(page, ids[1]).getAttribute('data-motion')
    await segment(page, ids[1]).click()
    await page.getByTestId('selected-shot-panel').getByRole('button', { name: 'Pan down' }).click()
    await expect(page.getByRole('alert').filter({ hasText: "couldn't be saved" })).toBeVisible()
    await expect(segment(page, ids[1])).toHaveAttribute('data-motion', before!)

    await page.getByTestId('selected-shot-panel').getByRole('button', { name: 'Split', exact: true }).click()
    await expect(page.getByTestId('split-marker')).toHaveCount(0)
    const r = await row(projectId, ids[1])
    expect([r.motion, r.split_at]).toEqual([null, null])
  })
})

test.describe('storyboard motion - forced cut', () => {
  test('a dissolve whose join falls inside a spoken word shows Cut with the reason, and the stored value stays', async ({
    page,
  }) => {
    // Join 1→2 at 5.0s sits inside the word 4.6–5.4; join 2→3 at 10.0s falls between words.
    const { projectId, ids } = await seed({
      shots: [
        { duration: 5, transition_out: 'dissolve' },
        { duration: 5, transition_out: 'dissolve' },
        { duration: 5 },
      ],
      words: [
        [0.2, 4.6],
        [4.6, 5.4],
        [5.6, 9.8],
        [10.2, 14.8],
      ],
    })
    await open(page, projectId)
    await motionMode(page)

    await expect(join(page, ids[0])).toHaveAttribute('data-transition', 'cut')
    await expect(join(page, ids[0])).toHaveAttribute('data-forced', 'true')
    await expect(join(page, ids[1])).toHaveAttribute('data-transition', 'dissolve')

    await join(page, ids[0]).click()
    const panel = page.getByTestId('selected-join-panel')
    await expect(panel.getByRole('button', { name: 'Cut' })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByTestId('forced-cut-reason')).toHaveText('Forced to a cut — this join falls inside a spoken word.')
    expect((await row(projectId, ids[0])).transition_out).toBe('dissolve')
  })

  test('with no voiceover nothing is forced', async ({ page }) => {
    const { projectId, ids } = await seed({ shots: [{ duration: 5, transition_out: 'dissolve' }, { duration: 5 }] })
    await open(page, projectId)
    await motionMode(page)
    await expect(join(page, ids[0])).toHaveAttribute('data-transition', 'dissolve')
    await expect(join(page, ids[0])).not.toHaveAttribute('data-forced', 'true')
  })
})

test.describe('storyboard motion - server actions', () => {
  test('refuse invalid values, a second segment without a split, an out-of-range split and a locked storyboard', async () => {
    const { saveShotMotionForUser, saveShotSplitForUser, saveTransitionForUser } = await import(
      '../src/app/(app)/projects/[id]/storyboard/actions'
    )
    const { projectId, ids } = await seed()
    const uid = primary.user.id

    expect((await saveShotMotionForUser(admin, uid, projectId, ids[0], 'a', 'spin' as never)).success).toBe(false)
    expect((await saveShotMotionForUser(admin, uid, projectId, ids[0], 'b', 'static')).success).toBe(false)
    expect(await saveShotMotionForUser(admin, uid, projectId, ids[0], 'a', null)).toEqual({ success: true, unchanged: true })
    expect(await saveShotMotionForUser(admin, uid, projectId, ids[0], 'a', 'static')).toEqual({ success: true })

    expect((await saveShotSplitForUser(admin, uid, projectId, ids[0], 0.1)).success).toBe(false)
    expect((await saveShotSplitForUser(admin, uid, projectId, ids[0], 1)).success).toBe(false)
    expect(await saveShotSplitForUser(admin, uid, projectId, ids[0], 0.4)).toEqual({ success: true })
    expect(await saveShotMotionForUser(admin, uid, projectId, ids[0], 'b', 'pan_up')).toEqual({ success: true })
    expect(await saveShotSplitForUser(admin, uid, projectId, ids[0], null)).toEqual({ success: true })

    expect((await saveTransitionForUser(admin, uid, projectId, ids[0], 'wipe' as never)).success).toBe(false)
    expect(await saveTransitionForUser(admin, uid, projectId, ids[0], 'cut')).toEqual({ success: true })

    const r = await row(projectId, ids[0])
    expect([r.motion, r.split_at, r.split_motion, r.transition_out]).toEqual(['static', null, null, 'cut'])

    // Never frozen: a project past the storyboard still saves.
    const advanced = await seed({ furthestStep: stepIndex('video_prompts') })
    expect(await saveShotMotionForUser(admin, uid, advanced.projectId, advanced.ids[0], 'a', 'pan_up')).toEqual({
      success: true,
    })
    expect((await row(advanced.projectId, advanced.ids[0])).motion).toBe('pan_up')
  })
})
