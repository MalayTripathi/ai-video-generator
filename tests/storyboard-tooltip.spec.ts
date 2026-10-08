import { test, expect, type Page } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

// Storyboard polish: the picture lane's narration tooltip. Hovering anywhere on a block shows
// its whole narration (or its visual description when the narration is empty) at every width
// tier and in both modes, and never while a drag is under way. Nothing here reaches a provider.

const NAVIGATION = { timeout: 45000 }

test.use({ viewport: { width: 1920, height: 1200 } })
test.setTimeout(120000)

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
function shotKey() {
  return Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')
}

const LONG_NARRATION =
  'First the foundation, stone laid on stone, and scaffolding climbing above it while the river keeps its slow and patient watch.'

type Spec = { seconds: number; voiceOver: string; description: string }

async function seed(specs: Spec[]) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Storyboard tooltip',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      aspect_ratio: '9:16',
      video_model: 'wan-2.5',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  const rows = specs.map((spec, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: shotKey(),
    voice_over: spec.voiceOver,
    visual_description: spec.description,
    duration_sec: spec.seconds,
    film_duration_sec: spec.seconds,
    image_prompt: `Prompt for shot ${i + 1}.`,
  }))
  const { data: shots, error: shotError } = await admin.from('shots').insert(rows).select('id, order_index')
  expect(shotError).toBeNull()
  return { projectId, ids: shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string) }
}

async function open(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/storyboard`)
  await expect(page.getByTestId('storyboard-main')).toBeVisible(NAVIGATION)
  await expect(page.getByTestId('picture-lane')).toHaveAttribute('data-layout', 'measured')
}

function block(page: Page, shotId: string) {
  return page.locator(`[data-testid="shot-block"][data-shot-id="${shotId}"]`)
}

// One long shot and two short ones, so the lane draws all three width tiers.
const TIERED: Spec[] = [
  { seconds: 24, voiceOver: 'The river rises.', description: 'Wide shot of the river' },
  { seconds: 1.8, voiceOver: LONG_NARRATION, description: 'Scaffolding against the sky' },
  { seconds: 0.6, voiceOver: '', description: 'Close on a mason’s hands' },
]

test('the whole narration shows on hover at every width tier, in Retime and Motion mode', async ({ page }) => {
  const { projectId, ids } = await seed(TIERED)
  await open(page, projectId)
  const tooltip = page.getByTestId('narration-tooltip')

  const tiers = await Promise.all(ids.map((id) => block(page, id).getAttribute('data-tier')))
  expect(tiers).toEqual(['wide', 'narrow', 'fill'])

  const expected = ['The river rises.', LONG_NARRATION, 'Close on a mason’s hands']
  for (const mode of ['retime', 'motion'] as const) {
    if (mode === 'motion') {
      await page.getByRole('button', { name: 'Motion & transitions' }).click()
      await expect(page.getByRole('button', { name: 'Motion & transitions' })).toHaveAttribute('aria-pressed', 'true')
    }
    for (const [i, id] of ids.entries()) {
      await page.mouse.move(0, 0)
      await expect(tooltip).toHaveCount(0)
      await block(page, id).hover()
      await expect(tooltip).toBeVisible()
      // Whole, never truncated; the empty narration falls back to the visual description.
      await expect(page.getByTestId('narration-tooltip-text')).toHaveText(expected[i])
    }
  }
})

test('no tooltip while a boundary drag is under way', async ({ page }) => {
  const { projectId, ids } = await seed(TIERED)
  await open(page, projectId)
  const tooltip = page.getByTestId('narration-tooltip')

  await block(page, ids[0]).hover()
  await expect(tooltip).toBeVisible()

  const grip = page.locator(`[data-testid="shot-grip"][data-shot-id="${ids[0]}"]`)
  const box = (await grip.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(tooltip).toHaveCount(0)
  // Sweep back across the long block and over the short ones while the button is held.
  await page.mouse.move(box.x - 300, box.y + box.height / 2, { steps: 6 })
  await expect(page.getByTestId('retime-tooltip')).toBeVisible()
  await expect(tooltip).toHaveCount(0)
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 })
  await expect(tooltip).toHaveCount(0)
  await page.mouse.up()
})
