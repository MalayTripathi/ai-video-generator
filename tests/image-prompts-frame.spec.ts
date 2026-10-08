import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { PLATE_SIZE } from '../src/app/(app)/projects/[id]/image_prompts/_components/plate-size'

// Step 3 cards show each shot's Storyboard frame in their plate: the thumbnail when one
// was written, else the full image; the grey placeholder when there's no image; dimmed with
// a Stale chip when image_stale is set. Display only. Nothing here reaches a provider.

const NAVIGATION = { timeout: 45000 }

async function webp() {
  return sharp({ create: { width: 18, height: 32, channels: 3, background: { r: 90, g: 120, b: 160 } } })
    .webp()
    .toBuffer()
}

type Spec = { image: 'thumb' | 'full-only' | null; stale?: boolean }

async function seed(specs: Spec[]) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Image prompts frame',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      aspect_ratio: '9:16',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  await admin.from('generations').insert({
    project_id: projectId,
    step: 'image_prompts',
    operation: 'write_image_prompts',
    shot_id: null,
    state: 'succeeded',
  })

  const { data: shots, error: shotError } = await admin
    .from('shots')
    .insert(
      specs.map((_, i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: `fr${i}${Math.random().toString(36).slice(2, 4)}`,
        voice_over: `Voice over ${i}`,
        image_prompt: `Prompt ${i + 1}, long enough to read as written.`,
        image_prompt_stale: false,
        image_prompt_edited: false,
      }))
    )
    .select('id, order_index')
  expect(shotError).toBeNull()
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string)

  const bytes = await webp()
  for (const [i, spec] of specs.entries()) {
    if (!spec.image) continue
    const base = `${primary.user.id}/${projectId}/images/${ids[i]}/${crypto.randomUUID()}`
    await admin.storage.from('artifacts').upload(`${base}.webp`, bytes, { contentType: 'image/webp' })
    if (spec.image === 'thumb') {
      await admin.storage.from('artifacts').upload(`${base}_thumb.webp`, bytes, { contentType: 'image/webp' })
    }
    await admin
      .from('shots')
      .update({ image_path: `${base}.webp`, image_stale: spec.stale ?? false })
      .eq('id', ids[i])
  }
  return { projectId, ids }
}

test('each card shows its Storyboard frame, the placeholder without one, and a Stale overlay when image_stale', async ({
  page,
}) => {
  const { projectId } = await seed([{ image: 'thumb' }, { image: 'full-only' }, { image: 'thumb', stale: true }, { image: null }])
  await page.goto(`/projects/${projectId}/image_prompts`)
  await expect(page.getByText('Shot 1', { exact: true })).toBeVisible(NAVIGATION)

  const frames = page.getByTestId('prompt-frame')
  await expect(frames).toHaveCount(3)
  const plate = PLATE_SIZE['9:16']

  // The thumbnail when one was written; the full image when it wasn't.
  const first = frames.nth(0).locator('img')
  await expect(first).toHaveAttribute('src', /_thumb\.webp/)
  await expect(first).toHaveAttribute('loading', 'lazy')
  await expect(frames.nth(1).locator('img')).toHaveAttribute('src', /\/[0-9a-f-]+\.webp\?/)
  for (let i = 0; i < 3; i++) {
    const img = frames.nth(i).locator('img')
    await img.scrollIntoViewIfNeeded()
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const box = (await frames.nth(i).boundingBox())!
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([plate.w, plate.h])
  }

  // Stale: dimmed, with the chip; fresh frames carry neither.
  await expect(frames.nth(2)).toHaveAttribute('data-stale', 'true')
  await expect(frames.nth(2).getByTestId('prompt-frame-stale')).toHaveText('Stale')
  await expect(frames.nth(2).locator('img')).toHaveClass(/opacity-50/)
  await expect(frames.nth(0).getByTestId('prompt-frame-stale')).toHaveCount(0)
  await expect(frames.nth(0).locator('img')).not.toHaveClass(/opacity-50/)

  // No image: the grey placeholder, unchanged.
  const placeholder = page.getByTestId('prompt-frame-placeholder')
  await expect(placeholder).toHaveCount(1)
  await expect(placeholder).toHaveText('9:16')

  // Display only: nothing to click.
  await expect(frames.nth(0).locator('button, a')).toHaveCount(0)
})
