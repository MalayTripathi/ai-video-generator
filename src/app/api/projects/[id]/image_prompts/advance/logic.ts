import type { createClient } from '@/lib/supabase/server'
// Type-only: credits/balance.ts is service-role-free (a plain read on the ordinary
// cookie-scoped client), but stays type-only here the same as ensureSignupGrant - this
// file never calls either directly, only via the injected param, same discipline as
// runElementReferenceGeneration's logic.ts.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import { creditsFor } from '@/lib/config/credits'
import { advanceStep } from '@/lib/projects/advance-step'
import { stepIndex } from '@/lib/config/pipeline'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type AdvanceToImagePromptsResult =
  | { ok: true; status: 200; data: { requiredCredits: number } }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 402; error: string; requiredCredits: number; balanceCredits: number }
  | { ok: false; status: 500; error: string }

// Pure balance-check-then-advanceStep gate: no provider call happens here, so there is
// nothing to CLAIM/RECOVER/PERSIST/SETTLE and no credit_ledger write - the real spend is
// recorded when image-prompt generation itself is wired, in a later task.
export async function runAdvanceToImagePrompts({
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
}): Promise<AdvanceToImagePromptsResult> {
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, furthest_step')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()

  if (projectError || !project) {
    return { ok: false, status: 404, error: 'Project not found' }
  }

  const { count: shotCount, error: shotsError } = await supabase
    .from('shots')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)

  if (shotsError) {
    return { ok: false, status: 500, error: shotsError.message }
  }

  const required = creditsFor({
    step: 'image_prompts',
    operation: 'write_image_prompts',
    quantity: shotCount ?? 0,
  })

  // A project that has already advanced past the Workbench owns this step: getting to it
  // spends nothing (generation is gated by its own route), so it must never be refused on
  // balance - e.g. from a page that was restored stale and still offered this button.
  if (project.furthest_step >= stepIndex('image_prompts')) {
    await advanceStep(supabase, projectId, 'image_prompts')
    return { ok: true, status: 200, data: { requiredCredits: required } }
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

  await advanceStep(supabase, projectId, 'image_prompts')

  return { ok: true, status: 200, data: { requiredCredits: required } }
}
