import type { createClient } from '@/lib/supabase/server'
// Type-only, for the same reason as the image_prompts advance: this file never calls either
// directly, only via the injected params.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import { creditsFor } from '@/lib/config/credits'
import { advanceStep } from '@/lib/projects/advance-step'
import { stepIndex } from '@/lib/config/pipeline'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type AdvanceToStoryboardResult =
  | { ok: true; status: 200; data: { requiredCredits: number } }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 422; error: string; shotIds: string[] }
  | { ok: false; status: 402; error: string; requiredCredits: number; balanceCredits: number }
  | { ok: false; status: 500; error: string }

// Pure prompt-check, balance-check, then advanceStep gate: no provider call happens here,
// so there is nothing to CLAIM/RECOVER/PERSIST/SETTLE and no credit_ledger write - the
// client calls the images route next, which gates, claims and charges per image.
export async function runAdvanceToStoryboard({
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
}): Promise<AdvanceToStoryboardResult> {
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, furthest_step')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()

  if (projectError || !project) {
    return { ok: false, status: 404, error: 'Project not found' }
  }

  const { data: shots, error: shotsError } = await supabase
    .from('shots')
    .select('id, image_prompt')
    .eq('project_id', projectId)

  if (shotsError) {
    return { ok: false, status: 500, error: shotsError.message }
  }

  const required = creditsFor({
    step: 'storyboard',
    operation: 'generate_image',
    quantity: shots.length,
  })

  // A project that has already advanced to the storyboard owns this step: getting to it
  // spends nothing (generation is gated by its own route), so it must never be refused on
  // balance - e.g. from a page that was restored stale and still offered this button.
  if (project.furthest_step >= stepIndex('storyboard')) {
    await advanceStep(supabase, projectId, 'storyboard')
    return { ok: true, status: 200, data: { requiredCredits: required } }
  }

  // A shot with no image prompt can't be drawn, so the first advance - the one that
  // starts image generation - refuses it (the second of three layers: Continue is
  // disabled, the images route refuses too). Checked only here, past the
  // already-advanced return above: navigating back to a step already reached is never
  // blocked.
  const withoutPrompt = shots.filter((s) => s.image_prompt === null || s.image_prompt.trim() === '').map((s) => s.id)
  if (withoutPrompt.length > 0) {
    return { ok: false, status: 422, error: 'Some shots have no image prompt', shotIds: withoutPrompt }
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

  await advanceStep(supabase, projectId, 'storyboard')

  return { ok: true, status: 200, data: { requiredCredits: required } }
}
