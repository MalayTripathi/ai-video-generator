import type { createClient } from '@/lib/supabase/server'
// Type-only, for the same reason as the image_prompts advance: this file never calls either
// directly, only via the injected params.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import { creditsFor } from '@/lib/config/credits'
import { advanceStep } from '@/lib/projects/advance-step'
import { stepIndex } from '@/lib/config/pipeline'
import { deriveImageState } from '@/lib/storyboard/image-state'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type AdvanceToVideoPromptsResult =
  | { ok: true; status: 200; data: { requiredCredits: number } }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 422; error: string; reason: 'no_shots' | 'frames_not_ready'; shotIds: string[] }
  | { ok: false; status: 402; error: string; requiredCredits: number; balanceCredits: number }
  | { ok: false; status: 500; error: string }

// Pure readiness-check, balance-check, then advanceStep gate: video-prompt generation is not
// built yet, so there is nothing to CLAIM/RECOVER/PERSIST/SETTLE and no credit_ledger or
// usage write - the real spend is recorded when that generation is wired.
export async function runAdvanceToVideoPrompts({
  supabase,
  projectId,
  userId,
  getBalance,
  ensureSignupGrant,
}: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  getBalance: typeof getBalanceType
  ensureSignupGrant: typeof ensureSignupGrantType
}): Promise<AdvanceToVideoPromptsResult> {
  // The child reads are RLS-scoped to the project's owner, so running them beside the
  // ownership read exposes nothing.
  const [projectResult, shotsResult, claimsResult] = await Promise.all([
    supabase.from('projects').select('id, furthest_step').eq('id', projectId).eq('user_id', userId).maybeSingle(),
    supabase.from('shots').select('id, image_path, image_stale').eq('project_id', projectId).is('binned_at', null),
    supabase
      .from('generations')
      .select('shot_id, state, started_at, queued_at')
      .eq('project_id', projectId)
      .eq('step', 'storyboard')
      .eq('operation', 'generate_image'),
  ])

  // A failed read is a server error, never a 404 - only a missing row is.
  if (projectResult.error) {
    return { ok: false, status: 500, error: projectResult.error.message }
  }
  const project = projectResult.data
  if (!project) {
    return { ok: false, status: 404, error: 'Project not found' }
  }
  if (shotsResult.error) {
    return { ok: false, status: 500, error: shotsResult.error.message }
  }
  if (claimsResult.error) {
    return { ok: false, status: 500, error: claimsResult.error.message }
  }

  // In-film shots only: a binned shot is not in the film, so it is neither priced nor
  // required to be ready.
  const shots = shotsResult.data
  const required = creditsFor({
    step: 'video_prompts',
    operation: 'write_video_prompts',
    quantity: shots.length,
  })

  // A project that has already advanced to video prompts owns this step: getting to it
  // spends nothing, so it is never refused on balance or readiness - e.g. from a page that
  // was restored stale and still offered this button.
  if (project.furthest_step >= stepIndex('video_prompts')) {
    await advanceStep(supabase, projectId, 'video_prompts')
    return { ok: true, status: 200, data: { requiredCredits: required } }
  }

  if (shots.length === 0) {
    return { ok: false, status: 422, error: 'The film has no shots', reason: 'no_shots', shotIds: [] }
  }

  // Ready = has an image and nothing in flight - the same rule as the timeline's
  // readiness(): a stale image still counts, it only warns.
  const claimByShot = new Map((claimsResult.data ?? []).map((row) => [row.shot_id, row]))
  const now = Date.now()
  const notReady = shots
    .filter((shot) => {
      const state = deriveImageState(shot, claimByShot.get(shot.id) ?? null, now)
      return state !== 'ready' && state !== 'stale'
    })
    .map((shot) => shot.id)
  if (notReady.length > 0) {
    return { ok: false, status: 422, error: 'Some frames are not ready', reason: 'frames_not_ready', shotIds: notReady }
  }

  await ensureSignupGrant(userId)
  const balance = await getBalance(userId)

  if (balance < required) {
    return {
      ok: false,
      status: 402,
      error: `Not enough credits: this step costs ${required}, balance is ${balance}.`,
      requiredCredits: required,
      balanceCredits: balance,
    }
  }

  await advanceStep(supabase, projectId, 'video_prompts')

  return { ok: true, status: 200, data: { requiredCredits: required } }
}
