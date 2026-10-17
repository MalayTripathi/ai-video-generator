import 'server-only'
import type { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { removeElement } from '@/lib/elements/cleanup'
import { findBoundShots, loadOwnedElement, REFERENCE_GENERATING_MESSAGE, type ElementDeleteResult } from '@/lib/elements/write'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// A person's own element delete - a hard delete. Ownership and the refusals (the style
// element, any shot binding) are checked on the caller's session client; only then is the
// service-role client built, because removing the element's generations rows needs it
// (generations has no client DELETE policy, on purpose: a claim row is the only lock). This
// module is the one place that client is built for an element delete, so no server action
// file needs it. A live reference claim refuses with 409 copy; bindings were refused above,
// so no shot_elements or shot_dialogue row is cascaded away.
export async function deleteElementForUser(
  supabase: SupabaseServerClient,
  elementId: string,
  userId: string
): Promise<ElementDeleteResult> {
  const element = await loadOwnedElement(supabase, elementId, userId)
  if (!element) return { success: false, error: 'Element not found' }

  if (element.type === 'style') {
    return { success: false, error: 'The style element cannot be deleted', reason: 'style' }
  }

  const boundShots = await findBoundShots(supabase, elementId)
  if (boundShots.length > 0) {
    return {
      success: false,
      error: 'This element is used in one or more shots and cannot be deleted',
      reason: 'bound',
      boundShots,
    }
  }

  // Paid output included - the person chose this.
  const outcome = await removeElement(createServiceRoleClient(), {
    userId,
    projectId: element.project_id,
    elementId,
    keepPaidOutput: false,
    protect: false,
  })
  if (outcome === 'live_claim') return { success: false, error: REFERENCE_GENERATING_MESSAGE, reason: 'in_flight' }
  if (outcome !== 'removed') return { success: false, error: 'Could not delete this element. Try again.' }
  return { success: true }
}
