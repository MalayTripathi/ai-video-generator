import { test, expect, type Page } from '@playwright/test'
import sharp from 'sharp'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { fixedCredits } from './helpers/prices'
import { stepIndex } from '../src/lib/config/pipeline'

// The Storyboard's footer button, mirroring image-prompts-footer-navigation.spec.ts. The
// video_prompts advance route is left real so a call to it is observable, never blocked.
// Nothing here reaches a provider: the advance writes no ledger or usage row.

const STORYBOARD = stepIndex('storyboard')
const VIDEO_PROMPTS = stepIndex('video_prompts')
// Read from the config, never restated: a re-priced step must not turn these red.
const PER_SHOT = fixedCredits('video_prompts', 'write_video_prompts')

const NAVIGATION = { timeout: 45000 }

test.use({ viewport: { width: 1920, height: 1200 } })
test.setTimeout(120000)

type ShotSpec = { image?: boolean; stale?: boolean; binned?: boolean }
type AudioSpec = {
  // A settled voiceover read; `edited` makes its narration differ from the shots' (stale).
  voiceover?: { totalSec: number; edited?: boolean }
  music?: { durationSec: number; loop: boolean }
}

let tinyImage: Buffer | null = null
async function image() {
  tinyImage ??= await sharp({ create: { width: 18, height: 32, channels: 3, background: { r: 90, g: 120, b: 160 } } })
    .webp()
    .toBuffer()
  return tinyImage
}

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
function shotKey() {
  return Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')
}

// Every shot is 5s, so the picture is 5s per in-film shot.
async function seed(userId: string, opts: { furthestStep: number; shots: ShotSpec[] } & AudioSpec) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Storyboard footer navigation',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      aspect_ratio: '9:16',
      status: 'in_progress',
      // Deliberately 'storyboard' whatever furthest_step is: a plain navigation must leave
      // it there, since the only writer of current_step is advanceStep().
      current_step: 'storyboard',
      furthest_step: opts.furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string

  const rows = opts.shots.map((spec, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: shotKey(),
    voice_over: `Line ${i + 1}.`,
    visual_description: `Shot description ${i + 1}`,
    duration_sec: 5,
    image_prompt: `Prompt for shot ${i + 1}.`,
    image_stale: spec.stale ?? false,
    binned_at: spec.binned ? new Date().toISOString() : null,
  }))
  const { data: shots, error: shotError } = await admin.from('shots').insert(rows).select('id, order_index')
  expect(shotError).toBeNull()
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string)

  for (const [i, spec] of opts.shots.entries()) {
    if (spec.image === false) continue
    const shotId = ids[i]
    const imagePath = `${userId}/${projectId}/images/${shotId}/${crypto.randomUUID()}.webp`
    await admin.storage.from('artifacts').upload(imagePath, await image(), { contentType: 'image/webp' })
    await admin.from('shots').update({ image_path: imagePath }).eq('id', shotId)
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'storyboard',
      operation: 'generate_image',
      shot_id: shotId,
      element_id: null,
      state: 'succeeded',
      started_at: null,
      queued_at: null,
    })
  }

  const audio: Record<string, unknown> = {}
  if (opts.voiceover) {
    const { totalSec, edited } = opts.voiceover
    const audioPath = `${userId}/${projectId}/voiceover/${crypto.randomUUID()}.mp3`
    await admin.storage.from('artifacts').upload(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]), { contentType: 'audio/mpeg' })
    const inFilm = ids.filter((_, i) => !opts.shots[i].binned)
    Object.assign(audio, {
      audio_path: audioPath,
      total_duration_sec: totalSec,
      voiceover_source: 'generated',
      voiceover_generated_at: new Date().toISOString(),
      voiceover_spans: inFilm.map((id) => {
        const i = ids.indexOf(id)
        return {
          shotId: id,
          from: 0,
          to: 0,
          text: edited ? `An older line ${i + 1}.` : `Line ${i + 1}.`,
          startSec: (inFilm.indexOf(id) * totalSec) / inFilm.length,
          endSec: ((inFilm.indexOf(id) + 1) * totalSec) / inFilm.length,
        }
      }),
    })
  }
  if (opts.music) {
    const musicPath = `${userId}/${projectId}/music/${crypto.randomUUID()}.mp3`
    await admin.storage.from('artifacts').upload(musicPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]), { contentType: 'audio/mpeg' })
    Object.assign(audio, {
      music_path: musicPath,
      music_duration_sec: opts.music.durationSec,
      music_source: 'generated',
      music_generated_at: new Date().toISOString(),
      music_loop: opts.music.loop,
    })
  }
  if (Object.keys(audio).length > 0) {
    const { error: audioError } = await admin.from('projects').update(audio).eq('id', projectId)
    expect(audioError).toBeNull()
  }
  return projectId
}

async function readProject(projectId: string) {
  const { data } = await admin.from('projects').select('current_step, furthest_step, status').eq('id', projectId).single()
  return data!
}

async function spendRowsFor(projectId: string) {
  const [{ count: ledger }, { count: usage }] = await Promise.all([
    admin.from('credit_ledger').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
    admin.from('usage').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
  ])
  return { ledger, usage }
}

async function drain(userId: string, leave: number) {
  const { error } = await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'spend',
    delta: -(5000 - leave),
    dedupe_key: `test-drain-${crypto.randomUUID()}`,
    attempt_id: crypto.randomUUID(),
    pricing_mode: 'fixed',
    price_version: 'test',
    step: 'workbench',
    operation: 'generate_shots',
  })
  expect(error).toBeNull()
}

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('storyboard-main')).toBeVisible(NAVIGATION)
}

test.describe('Storyboard footer button', () => {
  // A cold dev server answers a route it has not registered yet with the app's 404 page,
  // even for a POST that arrives right after the page. Wait until the advance endpoint
  // exists (a GET is a 405 once it does) so the tests measure the app, not start-up order.
  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90000)
    const api = await playwright.request.newContext({ baseURL: 'http://localhost:3000' })
    const url = '/api/projects/00000000-0000-0000-0000-000000000000/video_prompts/advance'
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if ((await api.get(url)).status() !== 404) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await api.dispose()
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('at the frontier it prices the in-film shots, excluding binned ones, and advances on confirm', async ({ page }) => {
    const projectId = await seed(primary.user.id, {
      furthestStep: STORYBOARD,
      shots: [{}, {}, { binned: true, image: false }],
    })

    await open(page, projectId)
    const button = page.getByTestId('generate-video-prompts')
    await expect(button).toHaveText(`Generate Video Prompts — ${2 * PER_SHOT} Credits`)
    await expect(button).toBeEnabled()
    await expect(page.getByTestId('go-to-video-prompts')).toHaveCount(0)

    await button.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Generate video prompts?')
    await expect(dialog).toContainText(`uses ${2 * PER_SHOT} credits`)
    await expect(dialog.getByRole('note')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Generate' }).click()

    await expect(page).toHaveURL(`/projects/${projectId}/video_prompts`, NAVIGATION)
    await expect(page.getByTestId('video-prompts-placeholder')).toBeVisible(NAVIGATION)
    expect(await readProject(projectId)).toMatchObject({
      current_step: 'video_prompts',
      furthest_step: VIDEO_PROMPTS,
      status: 'in_progress',
    })
    // A read-only balance check: generation is not built, so nothing is recorded.
    expect(await spendRowsFor(projectId)).toEqual({ ledger: 0, usage: 0 })
  })

  test('stays disabled until every in-film frame has an image', async ({ page }) => {
    const projectId = await seed(primary.user.id, { furthestStep: STORYBOARD, shots: [{}, { image: false }] })

    await open(page, projectId)
    await expect(page.getByTestId('generate-video-prompts')).toBeDisabled()
  })

  test('the confirmation warns about every imperfection that applies, without blocking', async ({ page }) => {
    // Picture: 2 × 5s = 0:10. One stale frame; a stale voiceover read 0:20 long; music 0:04
    // with Loop off.
    const projectId = await seed(primary.user.id, {
      furthestStep: STORYBOARD,
      shots: [{ stale: true }, {}],
      voiceover: { totalSec: 20, edited: true },
      music: { durationSec: 4, loop: false },
    })

    await open(page, projectId)
    await page.getByTestId('generate-video-prompts').click()
    const notes = page.getByRole('dialog').getByRole('note')
    await expect(notes).toHaveCount(4)
    await expect(notes.nth(0)).toHaveText('1 frame is stale — video prompts will be written from it as it is.')
    await expect(notes.nth(1)).toHaveText('The voiceover is stale — it no longer matches the shots in the film.')
    await expect(notes.nth(2)).toHaveText('The voiceover is 0:20 and the picture is 0:10 — they differ in length.')
    await expect(notes.nth(3)).toContainText('shorter than the picture')
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Generate' })).toBeEnabled()
  })

  test('a matching voiceover and looped music raise no warning', async ({ page }) => {
    // Within the 0.1s tolerance, narration unchanged, and short music that loops to fit.
    const projectId = await seed(primary.user.id, {
      furthestStep: STORYBOARD,
      shots: [{}, {}],
      voiceover: { totalSec: 10.05 },
      music: { durationSec: 4, loop: true },
    })

    await open(page, projectId)
    await page.getByTestId('generate-video-prompts').click()
    await expect(page.getByRole('dialog')).toContainText('Generate video prompts?')
    await expect(page.getByRole('dialog').getByRole('note')).toHaveCount(0)
  })

  test('an insufficient balance keeps Confirm disabled and Cancel enabled, and does not advance', async ({
    page,
    context,
  }) => {
    // A drained balance is a global per-user fact, so this one keeps its own fresh user.
    const { user, cookie } = await createTestSession()
    try {
      await drain(user.id, 1)
      const projectId = await seed(user.id, { furthestStep: STORYBOARD, shots: [{}, {}] })
      await context.addCookies([cookie])

      await open(page, projectId)
      await page.getByTestId('generate-video-prompts').click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Generate' }).click()

      await expect(dialog.getByRole('alert')).toContainText('Not enough credits for video prompts')
      await expect(dialog.getByRole('button', { name: 'Generate' })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled()
      expect(await readProject(projectId)).toMatchObject({ current_step: 'storyboard', furthest_step: STORYBOARD })
      expect(await spendRowsFor(projectId)).toEqual({ ledger: 0, usage: 0 })

      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page).toHaveURL(`/projects/${projectId}/storyboard`)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('past the Storyboard it is a plain link: no credit figure, no modal, no advance call, no step write', async ({
    page,
  }) => {
    // A frame not ready does not matter here: navigating to a reached step is never gated.
    const projectId = await seed(primary.user.id, { furthestStep: VIDEO_PROMPTS, shots: [{}, { image: false }] })
    let advanceCalls = 0
    await page.route('**/api/projects/*/video_prompts/advance', async (route) => {
      advanceCalls++
      await route.continue()
    })

    await open(page, projectId)
    const link = page.getByTestId('go-to-video-prompts')
    await expect(link).toHaveText('Go to Video Prompts')
    await expect(link).toHaveAttribute('href', `/projects/${projectId}/video_prompts`)
    await expect(page.getByTestId('generate-video-prompts')).toHaveCount(0)

    await link.click()
    await expect(page).toHaveURL(`/projects/${projectId}/video_prompts`, NAVIGATION)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(advanceCalls).toBe(0)
    expect(await readProject(projectId)).toMatchObject({ current_step: 'storyboard', furthest_step: VIDEO_PROMPTS })
  })

  test('the storyboard stays editable once the project has reached video prompts', async ({ page }) => {
    const projectId = await seed(primary.user.id, { furthestStep: VIDEO_PROMPTS, shots: [{}, {}] })

    await open(page, projectId)
    // The agent and the shot controls are both live - nothing freezes at the next step.
    await expect(page.getByLabel('Ask for a change')).toBeEnabled(NAVIGATION)
    await page.locator('[data-testid="shot-block"]').first().click()
    await expect(page.getByTestId('inspect-remove')).toBeEnabled()
  })
})
