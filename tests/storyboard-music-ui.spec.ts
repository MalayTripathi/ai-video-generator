import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { creditsFor } from '../src/lib/config/credits'
import { requestedMusicSec } from '../src/lib/music/length'
import { SAMPLE_SECONDS, sampleAudio } from './helpers/voiceover-fakes'

// The Music card in the browser (canvas 15f music row, StoryboardFrame pass 2). Music is
// seeded straight into the project's columns and storage, and every paid or Claude-backed
// request the card makes is intercepted, so nothing here reaches a provider.

const NAVIGATION = { timeout: 45000 }
test.use({ viewport: { width: 1920, height: 1200 } })
test.setTimeout(120000)

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
function shotKey() {
  return Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')
}

type SeedOptions = { durations?: number[]; stylePrompt?: string | null; music?: boolean }

async function seed(opts: SeedOptions = {}) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Storyboard music UI',
      source_text: 'A short film.',
      aspect_ratio: '9:16',
      video_model: 'wan-3.0',
      language: 'en',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
      music_style_prompt: opts.stylePrompt === undefined ? null : opts.stylePrompt,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  const durations = opts.durations ?? [3, 3, 3]
  await admin.from('shots').insert(
    durations.map((duration_sec, i) => ({
      project_id: projectId,
      order_index: i,
      shot_key: shotKey(),
      voice_over: `Line ${i + 1}.`,
      duration_sec,
      image_prompt: `Prompt ${i + 1}`,
    }))
  )
  if (opts.music) {
    const path = `${primary.user.id}/${projectId}/music/${crypto.randomUUID()}.mp3`
    await admin.storage.from('artifacts').upload(path, sampleAudio(), { contentType: 'audio/mpeg' })
    await admin
      .from('projects')
      .update({
        music_path: path,
        music_duration_sec: SAMPLE_SECONDS,
        music_source: 'generated',
        music_generated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
  }
  return { projectId, pictureSec: durations.reduce((a, b) => a + b, 0) }
}

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('storyboard-main')).toBeVisible(NAVIGATION)
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('the style prompt is never derived on page render, and exactly once on the first expand', async ({ page }) => {
  const { projectId } = await seed()
  let derivations = 0
  await page.route(`**/api/projects/${projectId}/music/prompt`, async (route) => {
    derivations++
    await route.fulfill({ status: 200, json: { ok: true, prompt: 'Soft strings and piano, hopeful, slow' } })
  })
  await open(page, projectId)
  const card = page.getByTestId('music-section')
  await expect(card).toHaveAttribute('data-state', 'empty')
  await expect(card).toContainText('Optional · Not generated')
  await page.waitForLoadState('networkidle')
  expect(derivations).toBe(0)

  await card.click()
  await expect(page.getByTestId('music-style-prompt')).toHaveValue('Soft strings and piano, hopeful, slow')
  expect(derivations).toBe(1)

  // Collapse and re-expand: no second request.
  await card.getByRole('button', { expanded: true }).first().click()
  await page.getByTestId('music-section').click()
  await expect(page.getByTestId('music-style-prompt')).toHaveValue('Soft strings and piano, hopeful, slow')
  expect(derivations).toBe(1)
})

test('a failed derivation leaves the field empty with its placeholder', async ({ page }) => {
  const { projectId } = await seed()
  await page.route(`**/api/projects/${projectId}/music/prompt`, (route) =>
    route.fulfill({ status: 500, json: { ok: false, error: 'boom' } })
  )
  await open(page, projectId)
  await page.getByTestId('music-section').click()
  const field = page.getByTestId('music-style-prompt')
  await expect(field).toHaveAttribute('placeholder', /Instruments, mood and tempo/)
  await expect(field).toHaveValue('')
  await expect(page.getByTestId('generate-music')).toBeDisabled()
})

test('Generate shows the per-minute price for the picture’s length and sends it', async ({ page }) => {
  const { projectId, pictureSec } = await seed({ stylePrompt: 'Soft piano, hopeful, slow' })
  const sent: unknown[] = []
  await page.route(`**/api/projects/${projectId}/music`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { ok: true, credits: 0 } })
  })
  await open(page, projectId)
  await page.getByTestId('music-section').click()
  const price = creditsFor({ step: 'storyboard', operation: 'background_music', quantity: requestedMusicSec(pictureSec) })
  await expect(page.getByTestId('generate-music')).toContainText(`${price} cr`)
  await page.getByTestId('generate-music').click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toEqual({ expectedCredits: price })
})

test('a 402 never shows Generating: the button only spins, then the banner shows and the card is unchanged', async ({ page }) => {
  const { projectId, pictureSec } = await seed({ stylePrompt: 'Soft piano, hopeful, slow' })
  let release: (res: { status: number; json: unknown }) => void = () => {}
  const answer = new Promise<{ status: number; json: unknown }>((resolve) => (release = resolve))
  let hits = 0
  await page.route(`**/api/projects/${projectId}/music`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    hits++
    await route.fulfill(await answer)
  })
  await open(page, projectId)
  const card = page.getByTestId('music-section')
  await card.click()
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __musicStates: string[] }).__musicStates = seen
    const note = () => {
      const state = document.querySelector('[data-testid="music-section"]')?.getAttribute('data-state')
      if (state && seen[seen.length - 1] !== state) seen.push(state)
    }
    note()
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] })
  })

  const button = page.getByTestId('generate-music')
  await button.click()
  await expect.poll(() => hits).toBe(1)
  await expect(button).toHaveAttribute('aria-busy', 'true')
  await expect(card).toHaveAttribute('data-state', 'empty')
  await expect(card).not.toContainText('Writing')

  const price = creditsFor({ step: 'storyboard', operation: 'background_music', quantity: requestedMusicSec(pictureSec) })
  release({ status: 402, json: { ok: false, error: 'Not enough credits', requiredCredits: price, balanceCredits: 0 } })
  await expect(page.getByRole('alert').filter({ hasText: 'Not enough credits for this music' })).toBeVisible()
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await expect(card).toHaveAttribute('data-state', 'empty')
  await expect(page.getByTestId('music-style-prompt')).toHaveValue('Soft piano, hopeful, slow')
  expect(await page.evaluate(() => (window as unknown as { __musicStates: string[] }).__musicStates)).toEqual(['empty'])
})

test('music shorter than the picture warns, and Loop to fit loops it across the lane for free', async ({ page }) => {
  const { projectId } = await seed({ music: true, durations: [3, 3, 3] })
  await page.route(`**/api/projects/${projectId}/music/prompt`, (route) =>
    route.fulfill({ status: 200, json: { ok: true, prompt: null } })
  )
  await open(page, projectId)
  const card = page.getByTestId('music-section')
  await expect(card).toHaveAttribute('data-state', 'short')
  await expect(page.getByTestId('music-short-chip')).toHaveText('0:03 · Shorter than picture')
  await expect(page.getByTestId('music-lane')).toHaveAttribute('data-passes', '1')

  await card.click()
  await expect(page.getByTestId('music-short-message')).toContainText('shorter than the picture')
  await page.getByTestId('music-loop').last().click()
  await expect(card).toHaveAttribute('data-state', 'present')
  await expect(card).toContainText('Looped to fit')
  await expect.poll(async () => Number(await page.getByTestId('music-lane').getAttribute('data-passes'))).toBeGreaterThan(1)
  const { data } = await admin.from('projects').select('music_loop').eq('id', projectId).single()
  expect(data!.music_loop).toBe(true)
  const { data: ledger } = await admin.from('credit_ledger').select('id').eq('project_id', projectId)
  expect(ledger).toHaveLength(0)
})

test('music longer than the picture shows no warning (it fades at the picture’s end)', async ({ page }) => {
  const { projectId } = await seed({ music: true, durations: [1, 1] })
  await open(page, projectId)
  const card = page.getByTestId('music-section')
  await expect(card).toHaveAttribute('data-state', 'present')
  await expect(card).toContainText('Generated from your style prompt')
  await expect(page.getByTestId('music-short-chip')).toHaveCount(0)
})
