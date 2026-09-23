import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

// The images route's continuation path, over HTTP. A continuation carries no user session,
// so its only credential is the internal-secret header: a wrong secret is refused outright,
// and a continuation-shaped body without the header is just a (malformed) user request -
// neither may resume a queued claim. No request here reaches the worker, so no provider.

async function seedQueuedClaim() {
  const { data: project } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Images route auth',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  const { data: shot } = await admin
    .from('shots')
    .insert({ project_id: project!.id, order_index: 0, shot_key: 'rrrrr', voice_over: 'x', image_prompt: 'A prompt.' })
    .select('id')
    .single()
  const now = new Date().toISOString()
  const { data: gen } = await admin
    .from('generations')
    .insert({
      project_id: project!.id,
      step: 'storyboard',
      operation: 'generate_image',
      shot_id: shot!.id,
      element_id: null,
      state: 'generating',
      started_at: now,
      queued_at: now,
      updated_at: now,
    })
    .select('id, queued_at')
    .single()
  return { projectId: project!.id as string, generationId: gen!.id as string, queuedAt: gen!.queued_at as string }
}

async function readClaim(generationId: string) {
  const { data } = await admin.from('generations').select('state, queued_at').eq('id', generationId).single()
  return data!
}

test.describe('images route - continuation auth', () => {
  test.setTimeout(120000)

  test('a wrong secret is refused with 403 and the claim stays queued', async ({ request }) => {
    const { projectId, generationId, queuedAt } = await seedQueuedClaim()
    const res = await request.post(`/api/projects/${projectId}/images`, {
      headers: { 'x-images-internal-secret': 'not-the-secret' },
      data: { userId: primary.user.id, projectId, generationIds: [generationId], chainDepth: 1 },
      timeout: 90000,
    })
    expect(res.status()).toBe(403)
    const claim = await readClaim(generationId)
    expect(claim.state).toBe('generating')
    expect(new Date(claim.queued_at!).getTime()).toBe(new Date(queuedAt).getTime())
    await admin.from('generations').update({ state: 'failed', queued_at: null }).eq('id', generationId)
  })

  test('a continuation body without the secret takes the user path and resumes nothing', async ({ request }) => {
    const { projectId, generationId, queuedAt } = await seedQueuedClaim()
    const res = await request.post(`/api/projects/${projectId}/images`, {
      data: { userId: primary.user.id, projectId, generationIds: [generationId], chainDepth: 1 },
      timeout: 90000,
    })
    expect(res.status()).toBe(400)
    const claim = await readClaim(generationId)
    expect(claim.state).toBe('generating')
    expect(new Date(claim.queued_at!).getTime()).toBe(new Date(queuedAt).getTime())
    await admin.from('generations').update({ state: 'failed', queued_at: null }).eq('id', generationId)
  })
})
