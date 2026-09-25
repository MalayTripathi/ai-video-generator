import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { creditsFor } from '../src/lib/config/credits'
import { VOICEOVER_VOICES } from '../src/lib/config/models'
import { buildScript } from '../src/lib/storyboard/voiceover'
import { SAMPLE_SECONDS, sampleAudio } from './helpers/voiceover-fakes'

// The Voiceover card, Fit to voiceover and the order-differs banner in the browser (canvas
// 15f / 15c c / 15b). A voiceover is seeded straight into the project's columns and
// storage, so nothing here reaches ElevenLabs; the one Generate click is intercepted.

const NAVIGATION = { timeout: 45000 }
test.use({ viewport: { width: 1920, height: 1200 } })
test.setTimeout(120000)

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
function shotKey() {
  return Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')
}

const LINES = ['The river rises at dawn.', 'The city wakes slowly.', 'The boats return home.']
const GEORGE = VOICEOVER_VOICES.en[0]

type SeedOptions = { voiceover?: boolean; binned?: number; swapped?: boolean; muted?: boolean }

async function seed(opts: SeedOptions = {}) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Storyboard voiceover UI',
      source_text: 'A short film.',
      aspect_ratio: '9:16',
      video_model: 'mochi-1',
      language: 'en',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  const rows = LINES.map((voice_over, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: shotKey(),
    voice_over,
    duration_sec: 3,
    image_prompt: `Prompt ${i + 1}`,
  }))
  const { data: shots } = await admin.from('shots').insert(rows).select('id, order_index')
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string)

  if (opts.voiceover) {
    // The read: one second-ish per shot across the sample's length, in script order.
    const script = buildScript(ids.map((id, i) => ({ id, voice_over: LINES[i], order_index: i })))
    const per = SAMPLE_SECONDS / ids.length
    const spans = script.ranges.map((r, i) => ({
      ...r,
      text: LINES[i],
      startSec: i * per + 0.1,
      endSec: (i + 1) * per - 0.1,
    }))
    const audioPath = `${primary.user.id}/${projectId}/voiceover/${crypto.randomUUID()}.mp3`
    await admin.storage.from('artifacts').upload(audioPath, sampleAudio(), { contentType: 'audio/mpeg' })
    await admin
      .from('projects')
      .update({
        audio_path: audioPath,
        voiceover_alignment_path: audioPath.replace('.mp3', '.alignment.json'),
        voice_id: GEORGE.id,
        language_code: 'en',
        tts_model: 'eleven_v3',
        total_duration_sec: SAMPLE_SECONDS,
        voiceover_source: 'generated',
        voiceover_generated_at: new Date().toISOString(),
        voiceover_muted: opts.muted ?? false,
        voiceover_spans: spans,
      })
      .eq('id', projectId)
  }
  if (opts.binned !== undefined) {
    await admin.from('shots').update({ binned_at: new Date().toISOString() }).eq('id', ids[opts.binned])
  }
  if (opts.swapped) {
    await admin.from('shots').update({ film_order: 2 }).eq('id', ids[1])
    await admin.from('shots').update({ film_order: 1 }).eq('id', ids[2])
  }
  return { projectId, ids }
}

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('storyboard-main')).toBeVisible(NAVIGATION)
}

async function projectRow(projectId: string) {
  const { data } = await admin.from('projects').select('audio_path, voiceover_muted').eq('id', projectId).single()
  return data!
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('empty: collapsed by default, expands to the project language’s four voices and the exact price', async ({ page }) => {
  const { projectId } = await seed()
  await open(page, projectId)
  const card = page.getByTestId('voiceover-section')
  await expect(card).toHaveAttribute('data-state', 'empty')
  await expect(card).toContainText('Optional · Not generated')
  await expect(page.getByTestId('fit-to-voiceover')).toHaveCount(0)

  await card.click()
  await expect(page.getByTestId('voice-card')).toHaveCount(4)
  for (const voice of VOICEOVER_VOICES.en) await expect(card).toContainText(voice.name)
  await expect(page.getByTestId('voiceover-language')).toHaveText('English')
  const chars = LINES.join(' ').length
  const price = creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: chars })
  await expect(page.getByTestId('generate-voiceover')).toContainText(`${price} cr`)
})

test('Generate sends the picked voice and the price shown, then reads the lane from the status poll', async ({ page }) => {
  const { projectId } = await seed()
  const sent: unknown[] = []
  await page.route(`**/api/projects/${projectId}/voiceover`, async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { ok: true, credits: 0 } })
  })
  await open(page, projectId)
  await page.getByTestId('voiceover-section').click()
  await page.getByTestId('voice-card').nth(2).click()
  await page.getByTestId('generate-voiceover').click()
  await expect.poll(() => sent.length).toBe(1)
  const price = creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: LINES.join(' ').length })
  expect(sent[0]).toEqual({ voiceId: VOICEOVER_VOICES.en[2].id, expectedCredits: price })
})

test('present: the collapsed line names the voice; Mute saves; Fit tiles the read into film lengths', async ({ page }) => {
  const { projectId, ids } = await seed({ voiceover: true })
  await open(page, projectId)
  const card = page.getByTestId('voiceover-section')
  await expect(card).toHaveAttribute('data-state', 'present')
  await expect(card).toContainText(`${GEORGE.name} · English · Generated`)

  await card.getByRole('button', { name: 'Mute' }).click()
  await expect.poll(async () => (await projectRow(projectId)).voiceover_muted).toBe(true)
  await expect(card.getByRole('button', { name: 'Unmute' })).toBeVisible()

  const fit = page.getByTestId('fit-to-voiceover')
  await expect(fit).toHaveAttribute('aria-disabled', 'false')
  await fit.click()
  await expect
    .poll(async () => {
      const { data } = await admin.from('shots').select('id, film_duration_sec').in('id', ids)
      return (data ?? []).every((s) => s.film_duration_sec !== null)
    })
    .toBe(true)
  const { data } = await admin.from('shots').select('film_duration_sec').in('id', ids)
  const total = (data ?? []).reduce((sum, s) => sum + (s.film_duration_sec ?? 0), 0)
  // Each shot is held to the 1s minimum, so the three tile at least the read's length.
  expect(total).toBeGreaterThanOrEqual(Math.round(SAMPLE_SECONDS * 10) / 10 - 0.05)
})

test('stale on bin: the card opens once, names the shot, and Fit is unavailable with a reason', async ({ page }) => {
  const { projectId } = await seed({ voiceover: true, binned: 1 })
  await open(page, projectId)
  const card = page.getByTestId('voiceover-section')
  await expect(card).toHaveAttribute('data-state', 'stale')
  await expect(page.getByTestId('voiceover-stale-message')).toContainText('Shot 2 was removed')
  const fit = page.getByTestId('fit-to-voiceover')
  await expect(fit).toHaveAttribute('aria-disabled', 'true')
  await expect(fit).toHaveAttribute('aria-label', /out of date/)

  // Restoring the shot from the bin clears the staleness.
  await page.getByTestId('bin-control').click()
  await page.getByTestId('bin-restore').click()
  await expect(card).toHaveAttribute('data-state', 'present')
  await expect(fit).toHaveAttribute('aria-disabled', 'false')
})

test('order differs: the banner is live, Fit is unavailable, and Restore script order clears both', async ({ page }) => {
  const { projectId } = await seed({ voiceover: true, swapped: true })
  await open(page, projectId)
  await expect(page.getByTestId('order-differs-banner')).toBeVisible()
  const fit = page.getByTestId('fit-to-voiceover')
  await expect(fit).toHaveAttribute('aria-disabled', 'true')
  await expect(fit).toHaveAttribute('aria-label', /order differs/)

  await page.getByTestId('restore-script-order').click()
  await expect(page.getByTestId('order-differs-banner')).toHaveCount(0)
  await expect(fit).toHaveAttribute('aria-disabled', 'false')
})

test('no banner without a voiceover, even when the picture is reordered', async ({ page }) => {
  const { projectId } = await seed({ swapped: true })
  await open(page, projectId)
  await expect(page.getByTestId('storyboard-main')).toBeVisible()
  await expect(page.getByTestId('order-differs-banner')).toHaveCount(0)
})

test('Remove clears the voiceover from the card', async ({ page }) => {
  const { projectId } = await seed({ voiceover: true })
  await open(page, projectId)
  const card = page.getByTestId('voiceover-section')
  await card.click()
  await page.getByTestId('voiceover-remove').click()
  // The card re-reads the lane from the status endpoint, which may still be compiling.
  await expect(card).toHaveAttribute('data-state', 'empty', { timeout: 20000 })
  await expect.poll(async () => (await projectRow(projectId)).audio_path).toBeNull()
})

test.describe('narrow header', () => {
  test.use({ viewport: { width: 1100, height: 1000 } })

  test('Fit to voiceover collapses to its icon, keeping its name for tooltips and assistive tech', async ({ page }) => {
    const { projectId } = await seed({ voiceover: true })
    await open(page, projectId)
    const fit = page.getByTestId('fit-to-voiceover')
    await expect(fit).toBeVisible()
    await expect(fit).toHaveText('')
    await expect(fit).toHaveAttribute('title', /Fit to voiceover/)
  })
})
