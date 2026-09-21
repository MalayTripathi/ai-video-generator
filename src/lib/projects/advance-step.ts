import type { createClient } from '@/lib/supabase/server'
import { stepIndex, type Step } from '@/lib/config/pipeline'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * The one permitted write site for `projects.current_step` and
 * `projects.furthest_step` outside project creation.
 *
 * current_step = the step the user is on right now. It moves only when this
 * is called (Continue); the step indicator changes the route, not this column.
 * furthest_step = how far the user has unlocked. It never decreases.
 *
 * Call this ONLY on an explicit step transition (a Continue button) - never
 * on a save. Saving an edit on a revisited step must not move current_step,
 * or it starts tracking edits instead of navigation.
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

  // Leaving the workbench is what makes a project "in progress". Conditional at the
  // database on status = 'draft' - like the furthest_step guard above - so repeat
  // calls are no-ops and a later status is never overwritten.
  if (idx > stepIndex('workbench')) {
    await supabase
      .from('projects')
      .update({ status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .eq('status', 'draft')
  }
}
