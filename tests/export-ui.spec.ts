import { test, expect, type Page } from '@playwright/test'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { buildFilmTimeline } from '../src/lib/storyboard/film'
import { FILM_PROJECT_COLUMNS, FILM_SHOT_COLUMNS, filmInputFromRows } from '../src/lib/export/film-input'
import { filmHash } from '../src/lib/export/film-hash'

// Export on the Storyboard page (canvas 15g): the settings persist per field to the
// project and re-resolve the film (the B3 lane reads the project's defaults), and a history
// row whose film hash differs from the page's film shows "Edited since". No worker runs
// here - the exports rows are seeded as the worker would leave them.

const NAVIGATION = { timeout: 45000 }
test.setTimeout(120000)
test.use({ viewport: { width: 1920, height: 1200 } })

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')

async function seed() {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Export UI',
      source_text: 'A short film.',
      aspect_ratio: '9:16',
      video_model: 'wan-2.5',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id
  const { data: shots } = await admin
    .from('shots')
    .insert(
      [0, 1].map((i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: shotKey(),
        voice_over: `Line ${i + 1}.`,
        visual_description: `Shot ${i + 1}`,
        duration_sec: 3,
        image_prompt: `Prompt ${i + 1}`,
      }))
    )
    .select('id, order_index')
  const bytes = await sharp({ create: { width: 18, height: 32, channels: 3, background: { r: 90, g: 120, b: 160 } } })
    .webp()
    .toBuffer()
  for (const shot of shots!) {
    const imagePath = `${primary.user.id}/${projectId}/images/${shot.id}/${crypto.randomUUID()}.webp`
    await admin.storage.from('artifacts').upload(imagePath, bytes, { contentType: 'image/webp' })
    await admin.from('shots').update({ image_path: imagePath }).eq('id', shot.id)
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'storyboard',
      operation: 'generate_image',
      shot_id: shot.id,
      element_id: null,
      state: 'succeeded',
    })
  }
  return projectId
}

/** The film hash the server (and the worker) compute from the project's rows. */
async function serverHash(projectId: string) {
  const { data: project } = await admin.from('projects').select(FILM_PROJECT_COLUMNS).eq('id', projectId).single()
  const { data: shots } = await admin.from('shots').select(FILM_SHOT_COLUMNS).eq('project_id', projectId).order('order_index')
  return filmHash(buildFilmTimeline(filmInputFromRows(project!, shots!)))
}

async function succeeded(projectId: string, hash: string, minutesAgo: number) {
  const { data, error } = await admin
    .from('exports')
    .insert({
      user_id: primary.user.id,
      project_id: projectId,
      status: 'succeeded',
      settings: {
        motion: 'alternate',
        transition: 'dissolve',
        captions: 'off',
        captionStyle: 'reelcraft_default',
        captionPosition: 'bottom',
        loudness: 'streaming',
        aspectRatio: '9:16',
      },
      film_hash: hash,
      progress: 100,
      size_bytes: 1_900_000,
      duration_sec: 6,
      created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      finished_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id
}

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('export-section')).toBeVisible(NAVIGATION)
}

test('settings save per field to the project and re-resolve the film', async ({ page }) => {
  const projectId = await seed()
  await open(page, projectId)
  const summary = page.getByTestId('export-summary')
  await expect(summary).toHaveText('Alternate motion · Dissolve · Captions off · Streaming loudness')

  await page.getByRole('button', { name: 'Export settings' }).click()
  const panel = page.getByTestId('export-settings-panel')
  await panel.getByRole('radiogroup', { name: 'Motion' }).getByRole('radio', { name: 'Static' }).click()
  await panel.getByRole('radiogroup', { name: 'Transitions' }).getByRole('radio', { name: 'Cut' }).click()
  await panel.getByRole('combobox', { name: 'Loudness' }).click()
  await page.getByRole('option', { name: /Broadcast/ }).click()
  await expect(summary).toHaveText('Static motion · Cut · Captions off · Broadcast loudness')

  // No voiceover: captions are unavailable.
  await expect(panel.getByRole('radiogroup', { name: 'Captions' }).getByRole('radio', { name: 'Burned in' })).toBeDisabled()

  await expect
    .poll(async () => {
      const { data } = await admin
        .from('projects')
        .select('export_motion, export_transition, loudness_preset, caption_mode')
        .eq('id', projectId)
        .single()
      return data
    })
    .toEqual({ export_motion: 'static', export_transition: 'cut', loudness_preset: 'broadcast', caption_mode: null })

  // Persisted: a fresh load resolves the same settings from the project.
  await page.reload()
  await expect(page.getByTestId('export-summary')).toHaveText('Static motion · Cut · Captions off · Broadcast loudness', NAVIGATION)
})

test('an export whose film has been edited since shows the chip; the current one does not', async ({ page }) => {
  const projectId = await seed()
  await succeeded(projectId, await serverHash(projectId), 1)
  await succeeded(projectId, 'an-older-film', 30)
  await open(page, projectId)

  const rows = page.getByTestId('export-row')
  await expect(rows).toHaveCount(2)
  const latest = rows.nth(0)
  await expect(latest).toContainText('Latest')
  await expect(latest).toContainText('0:06 · 1.8 MB')
  await expect(latest.getByTestId('export-edited-since')).toHaveCount(0)
  await expect(rows.nth(1).getByTestId('export-edited-since')).toBeVisible()

  // Editing the film (the project's transition) makes the latest one "Edited since" too.
  await page.getByRole('button', { name: 'Export settings' }).click()
  await page.getByTestId('export-settings-panel').getByRole('radiogroup', { name: 'Transitions' }).getByRole('radio', { name: 'Cut' }).click()
  await expect(latest.getByTestId('export-edited-since')).toBeVisible()
})

