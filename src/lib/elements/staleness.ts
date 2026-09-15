import type { createClient } from '@/lib/supabase/server'
import type { ElementType } from '@/lib/config/enums'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// The style element is structurally barred from ever getting a shot_elements row
// (src/app/api/projects/[id]/shots/logic.ts guards against it, src/lib/elements/write.ts's
// CREATABLE_ELEMENT_TYPES excludes it from user creation) and no pipeline applies its
// reference image per-shot - it's project-wide by construction, so every shot in the
// project counts as affected rather than none.
async function findAffectedShotIds(
  supabase: SupabaseServerClient,
  projectId: string,
  elementId: string,
  elementType: ElementType
): Promise<string[]> {
  if (elementType === 'style') {
    const { data } = await supabase.from('shots').select('id').eq('project_id', projectId)
    return (data ?? []).map((row) => row.id)
  }

  const [{ data: viaElements }, { data: viaDialogue }] = await Promise.all([
    supabase.from('shot_elements').select('shot_id').eq('element_id', elementId),
    supabase.from('shot_dialogue').select('shot_id').eq('element_id', elementId),
  ])

  return Array.from(new Set([...(viaElements ?? []), ...(viaDialogue ?? [])].map((row) => row.shot_id)))
}

// Never discard the compiled prompt to signal staleness - only flag it. Called from the
// same request that changes an element's reference image (add, replace, or remove), never
// from a name/description edit, which is a separate concern left untouched.
export async function markImagePromptsStaleForElementReference(
  supabase: SupabaseServerClient,
  projectId: string,
  elementId: string,
  elementType: ElementType
): Promise<void> {
  const shotIds = await findAffectedShotIds(supabase, projectId, elementId, elementType)
  if (shotIds.length === 0) return

  const { error } = await supabase.from('shots').update({ image_prompt_stale: true }).in('id', shotIds)
  if (error) {
    console.error(
      `[elements] Failed to mark image prompts stale for element ${elementId}:`,
      error.message
    )
  }
}
