import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { stepIndex } from '../src/lib/config/pipeline'
import { creditsFor } from '../src/lib/config/credits'
import { formatCost } from '../src/lib/format-cost'

// The rail's spend figures on the Storyboard update from the status poll the moment a shot
// settles - no router.refresh(). The rail figure is a per-user monthly total, so this uses
// its own fresh user rather than a shared fixed one. Nothing here reaches a provider: the
// "charge" is a ledger row and a usage row written directly, as the worker would.

const IMAGE_PRICE = creditsFor({ step: 'storyboard', operation: 'generate_image', quantity: 1 })
const USAGE_COST = 0.042

test.setTimeout(120000)

test('the rail updates after a shot settles, with no router.refresh()', async ({ page, context }) => {
  const { user, cookie } = await createTestSession()
  try {
    const { data: project, error } = await admin
      .from('projects')
      .insert({
        user_id: user.id,
        title: 'Rail refresh',
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

    const { data: shot, error: shotError } = await admin
      .from('shots')
      .insert({
        project_id: projectId,
        order_index: 0,
        shot_key: 'bcdfg',
        voice_over: 'Line 1.',
        visual_description: 'A harbour at dawn',
        duration_sec: 5,
        section_label: null,
        image_prompt: 'A harbour at dawn, long enough to read as written.',
        image_prompt_edited: false,
        image_prompt_stale: false,
        image_stale: false,
        image_path: null,
      })
      .select('id')
      .single()
    expect(shotError).toBeNull()
    const shotId = shot!.id as string

    const { data: claim, error: claimError } = await admin
      .from('generations')
      .insert({
        project_id: projectId,
        step: 'storyboard',
        operation: 'generate_image',
        shot_id: shotId,
        element_id: null,
        state: 'generating',
        started_at: new Date().toISOString(),
        queued_at: null,
      })
      .select('id')
      .single()
    expect(claimError).toBeNull()

    await context.addCookies([cookie])
    const rscRequests: string[] = []
    page.on('request', (req) => {
      if (req.headers()['rsc'] === '1') rscRequests.push(req.url())
    })

    await page.goto(`/projects/${projectId}/storyboard`)
    await expect(page.getByTestId('storyboard-main')).toBeVisible({ timeout: 45000 })
    await expect(page.getByTestId('rail-credits-spend')).toHaveText('0 credits')
    await expect(page.getByTestId('rail-dollar-spend')).toHaveText(formatCost(0))
    rscRequests.length = 0

    // Settle the shot exactly as the worker does: image linked, claim succeeded, one spend
    // row on the ledger and one settled usage row.
    const imagePath = `${user.id}/${projectId}/images/${shotId}/${crypto.randomUUID()}.webp`
    const bytes = await sharp({ create: { width: 18, height: 32, channels: 3, background: { r: 90, g: 120, b: 160 } } })
      .webp()
      .toBuffer()
    await admin.storage.from('artifacts').upload(imagePath, bytes, { contentType: 'image/webp' })
    await admin.from('shots').update({ image_path: imagePath }).eq('id', shotId)
    const attemptId = crypto.randomUUID()
    const { error: ledgerError } = await admin.from('credit_ledger').insert({
      user_id: user.id,
      project_id: projectId,
      kind: 'spend',
      delta: -IMAGE_PRICE,
      step: 'storyboard',
      operation: 'generate_image',
      attempt_id: attemptId,
      pricing_mode: 'fixed',
      dedupe_key: `generate_image:${attemptId}`,
      price_version: 'test',
    })
    expect(ledgerError).toBeNull()
    const { error: usageError } = await admin.from('usage').insert({
      user_id: user.id,
      project_id: projectId,
      generation_id: claim!.id,
      step: 'storyboard',
      operation: 'generate_image',
      provider: 'openai',
      model: 'test-image-model',
      status: 'succeeded',
      estimated_cost: USAGE_COST,
    })
    expect(usageError).toBeNull()
    await admin.from('generations').update({ state: 'succeeded' }).eq('id', claim!.id)

    await expect(page.getByTestId('frames-ready')).toHaveText('1 of 1 frames ready', { timeout: 20000 })
    await expect(page.getByTestId('rail-credits-spend')).toHaveText(`${IMAGE_PRICE} credits`)
    await expect(page.getByTestId('rail-dollar-spend')).toHaveText(formatCost(USAGE_COST))
    expect(rscRequests).toEqual([])
  } finally {
    await admin.from('usage').delete().eq('user_id', user.id)
    await admin.from('credit_ledger').delete().eq('user_id', user.id)
    await deleteTestUser(user.id)
  }
})
