'use server'

import { createClient } from '@/lib/supabase/server'
import { stepIndex } from '@/lib/config/pipeline'
import { EMPTY_IMAGE_PROMPT_MESSAGE, imagePromptIsValid } from '@/lib/image-prompt-edit'
import { getBalance } from '@/lib/credits/balance'
import { gateImagePromptsBalance } from '@/app/api/projects/[id]/image-prompts/logic'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// Field-attributed, plain result object, never thrown - same shape as the Workbench's
// per-field saves, so a card can retry exactly the field that failed.
export type ImagePromptSaveResult =
  | { field: 'image_prompt'; success: true; unchanged?: true }
  | { field: 'image_prompt'; success: false; error: string; reason?: 'invalid' }

const PROMPTS_LOCKED_MESSAGE =
  "This project's image prompts are locked - later steps have already started, so they can no longer be changed here."

// Saves a hand edit. Deliberately does NOT touch image_prompt_stale: an edit is not a
// judgement that the prompt now matches its shot, so a stale prompt stays stale (a
// prompt can be both). Never calls advanceStep - saving is not advancing.
export async function updateShotImagePromptForUser(
  supabase: SupabaseServerClient,
  shotId: string,
  value: string,
  userId: string
): Promise<ImagePromptSaveResult> {
  const field = 'image_prompt' as const

  // Ownership resolves through the projects join (shots has no user_id); RLS is the
  // backstop.
  const { data: shot } = await supabase
    .from('shots')
    .select('id, project_id, image_prompt, projects!inner(user_id)')
    .eq('id', shotId)
    .eq('projects.user_id', userId)
    .maybeSingle()
  if (!shot) return { field, success: false, error: 'Shot not found' }
  // The read-only lock is the same boundary the Workbench's field saves enforce (a
  // separate query, mirroring its isWorkbenchLockedForProject).
  const { data: project } = await supabase.from('projects').select('furthest_step').eq('id', shot.project_id).single()
  if (project && project.furthest_step >= stepIndex('storyboard')) {
    return { field, success: false, error: PROMPTS_LOCKED_MESSAGE }
  }

  // Never nulled: a blank prompt would render identically to a shot that was never
  // generated and throw away paid output. Checked before the diff, unconditionally.
  if (!imagePromptIsValid(value)) {
    return { field, success: false, reason: 'invalid', error: EMPTY_IMAGE_PROMPT_MESSAGE }
  }

  const trimmed = value.trim()
  if (trimmed === shot.image_prompt) return { field, success: true, unchanged: true }

  const { error } = await supabase
    .from('shots')
    .update({ image_prompt: trimmed, image_prompt_edited: true, updated_at: new Date().toISOString() })
    .eq('id', shotId)
  if (error) return { field, success: false, error: error.message }

  return { field, success: true }
}

export async function updateShotImagePrompt(shotId: string, value: string): Promise<ImagePromptSaveResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { field: 'image_prompt', success: false, error: 'Not authenticated' }

  return updateShotImagePromptForUser(supabase, shotId, value, user.id)
}

// What the client learns before it enters its writing state. `error` means the check
// itself couldn't run - the caller proceeds and lets the route (the authoritative gate)
// decide, so a broken preflight never blocks a request the route would have allowed.
export type ImagePromptsAffordability =
  | { ok: true }
  | { ok: false; reason: 'insufficient'; requiredCredits: number; balanceCredits: number }
  | { ok: false; reason: 'error' }

// Advisory only: nothing is charged off it and the route recomputes its own quantity from
// the shot ids it validates. Uses the same gate as the route, so a payload that would
// replay for free is never refused here either.
export async function checkImagePromptsAffordabilityForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  shotIds: string[],
  getBalanceFn: typeof getBalance = getBalance
): Promise<ImagePromptsAffordability> {
  const { data: shots, error } = await supabase
    .from('shots')
    .select('id, shot_key, projects!inner(user_id)')
    .eq('project_id', projectId)
    .eq('projects.user_id', userId)
    .in('id', shotIds)
  if (error || !shots || shots.length !== new Set(shotIds).size) return { ok: false, reason: 'error' }

  const gate = await gateImagePromptsBalance({
    supabase,
    projectId,
    userId,
    shotKeys: shots.map((s) => s.shot_key),
    getBalance: getBalanceFn,
  })
  if (gate.ok) return { ok: true }
  if (gate.kind === 'insufficient') {
    return { ok: false, reason: 'insufficient', requiredCredits: gate.requiredCredits, balanceCredits: gate.balanceCredits }
  }
  return { ok: false, reason: 'error' }
}

export async function checkImagePromptsAffordability(
  projectId: string,
  shotIds: string[]
): Promise<ImagePromptsAffordability> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, reason: 'error' }

  return checkImagePromptsAffordabilityForUser(supabase, user.id, projectId, shotIds)
}
