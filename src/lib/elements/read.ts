import type { createClient } from '@/lib/supabase/server'
import { ELEMENT_TYPES, type ElementType } from '@/lib/config/enums'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

const SIGNED_URL_EXPIRES_IN_SECONDS = 3600

export type ProjectElement = {
  id: string
  name: string
  description: string | null
  type: ElementType
  reference_image_path: string | null
  reference_image_url: string | null
}

export type ElementGroup = {
  type: ElementType
  count: number
  elements: ProjectElement[]
}

export type GetProjectElementsResult =
  | { success: true; groups: ElementGroup[]; expires_at: string }
  | { success: false; error: string }

export type ResignElementImageResult =
  | { success: true; url: string; expires_at: string }
  | { success: false; error: string }

function expiresAt(): string {
  return new Date(Date.now() + SIGNED_URL_EXPIRES_IN_SECONDS * 1000).toISOString()
}

// One query: ownership resolves through the same `projects!inner(user_id)` embedded-filter
// pattern as loadOwnedShot/deleteShotForUser in workbench/actions.ts. A wrong-owner or
// nonexistent project collapses to the same empty result as a project with zero elements -
// RLS is the backstop, this join is the app-level check, and neither case should look like
// an error to the caller.
export async function getProjectElementsForUser(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string
): Promise<GetProjectElementsResult> {
  const { data: rows, error } = await supabase
    .from('elements')
    .select('id, name, description, type, reference_image_path, projects!inner(user_id)')
    .eq('project_id', projectId)
    .eq('projects.user_id', userId)
    .is('deleted_at', null)

  if (error) return { success: false, error: error.message }

  const paths = Array.from(
    new Set((rows ?? []).map((row) => row.reference_image_path).filter((path): path is string => path !== null))
  )

  const urlByPath = new Map<string, string>()
  if (paths.length > 0) {
    const { data: signed, error: signError } = await supabase.storage
      .from('artifacts')
      .createSignedUrls(paths, SIGNED_URL_EXPIRES_IN_SECONDS)
    if (signError) {
      console.error(`[elements] Failed to batch-sign reference images for project ${projectId}:`, signError.message)
    } else {
      for (const entry of signed ?? []) {
        if (entry.error || !entry.signedUrl) {
          console.error(`[elements] Failed to sign reference image ${entry.path}:`, entry.error)
          continue
        }
        if (entry.path) urlByPath.set(entry.path, entry.signedUrl)
      }
    }
  }

  const groups: ElementGroup[] = ELEMENT_TYPES.map((type) => {
    const elements: ProjectElement[] = (rows ?? [])
      .filter((row) => row.type === type)
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        type,
        reference_image_path: row.reference_image_path,
        reference_image_url: row.reference_image_path ? (urlByPath.get(row.reference_image_path) ?? null) : null,
      }))
    return { type, count: elements.length, elements }
  })

  return { success: true, groups, expires_at: expiresAt() }
}

// Defense in depth, same reasoning as above: confirms the path actually belongs to a live,
// owned element before signing it, rather than relying solely on storage RLS's
// auth.uid()-prefixed-folder check.
export async function resignElementReferenceImageForUser(
  supabase: SupabaseServerClient,
  projectId: string,
  path: string,
  userId: string
): Promise<ResignElementImageResult> {
  const { data: element } = await supabase
    .from('elements')
    .select('id, projects!inner(user_id)')
    .eq('project_id', projectId)
    .eq('reference_image_path', path)
    .eq('projects.user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!element) return { success: false, error: 'Element not found' }

  const { data, error } = await supabase.storage.from('artifacts').createSignedUrl(path, SIGNED_URL_EXPIRES_IN_SECONDS)
  if (error || !data) return { success: false, error: error?.message ?? 'Failed to sign reference image' }

  return { success: true, url: data.signedUrl, expires_at: expiresAt() }
}
