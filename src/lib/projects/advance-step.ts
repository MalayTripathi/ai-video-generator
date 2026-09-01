import type { createClient } from '@/lib/supabase/server'
import { stepIndex, type Step } from '@/lib/config/pipeline'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * The one permitted write site for `projects.current_step` and
 * `projects.furthest_step` outside project creation.
 *
 * current_step = the step the user is on right now. It moves backward when
 * the user navigates back via the step indicator, forward via Continue.
 * furthest_step = how far the user has unlocked. It never decreases.
 *
 * Call this ONLY on an explicit step transition (Continue button, step
 * indicator navigation) - never on a save. Saving an edit on a revisited
 * step must not move current_step, or it starts tracking edits instead of
 * navigation.
 */
export async function advanceStep(
  supabase: SupabaseServerClient,
  projectId: string,
  step: Step
): Promise<void> {
  await supabase.from('projects').update({ current_step: step }).eq('id', projectId)

  const idx = stepIndex(step)
  await supabase
    .from('projects')
    .update({ furthest_step: idx })
    .eq('id', projectId)
    .lt('furthest_step', idx)
}
