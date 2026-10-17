import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

// The names behind a per-project spend figure (/credits, /usage). credit_ledger and usage
// keep a deleted project's id, so each id resolves against projects and deleted_projects,
// read in parallel. A live projects row always wins - a delete that failed after its
// deleted_projects row was written leaves the project live, never "Deleted".

export type ProjectMeta = {
  id: string
  title: string | null
  source_text: string | null
  video_type: string | null
  duration_target: string | null
  /** True only for a project with no live row and a deleted_projects row. */
  deleted?: boolean
}

export async function readProjectMetas(
  supabase: SupabaseClient<Database>,
  userId: string,
  ids: readonly string[]
): Promise<ProjectMeta[]> {
  if (ids.length === 0) return []
  const [live, deleted] = await Promise.all([
    supabase.from('projects').select('id, title, source_text, video_type, duration_target').in('id', [...ids]).eq('user_id', userId),
    supabase.from('deleted_projects').select('id, title, duration_tier').in('id', [...ids]).eq('user_id', userId),
  ])
  const liveRows: ProjectMeta[] = live.data ?? []
  const liveIds = new Set(liveRows.map((p) => p.id))
  const deletedRows: ProjectMeta[] = (deleted.data ?? [])
    .filter((d) => !liveIds.has(d.id))
    .map((d) => ({ id: d.id, title: d.title, source_text: null, video_type: null, duration_target: d.duration_tier, deleted: true }))
  return [...liveRows, ...deletedRows]
}
