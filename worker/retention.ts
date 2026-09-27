import { EXPORT_RETENTION } from '@/lib/config/export'
import type { WorkerDb } from './config'

/**
 * Keeps the newest EXPORT_RETENTION succeeded exports of a project and deletes the rest -
 * files first, then rows. Exports are free and re-renderable, so nothing else is kept.
 * Returns the deleted ids.
 */
export async function applyRetention(db: WorkerDb, projectId: string, keep: number = EXPORT_RETENTION): Promise<string[]> {
  const { data, error } = await db
    .from('exports')
    .select('id, mp4_path, srt_path, chapters_path')
    .eq('project_id', projectId)
    .eq('status', 'succeeded')
    .order('finished_at', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  const old = (data ?? []).slice(keep)
  if (old.length === 0) return []
  const paths = old.flatMap((r) => [r.mp4_path, r.srt_path, r.chapters_path]).filter((p): p is string => !!p)
  if (paths.length > 0) {
    const { error: removeError } = await db.storage.from('artifacts').remove(paths)
    if (removeError) console.warn('[export] retention could not remove files', removeError.message)
  }
  const ids = old.map((r) => r.id)
  const { error: deleteError } = await db.from('exports').delete().in('id', ids)
  if (deleteError) throw deleteError
  return ids
}
