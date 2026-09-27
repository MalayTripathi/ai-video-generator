import { EXPORT_STUCK_TIMEOUT_MS } from '@/lib/config/export'
import type { Database } from '@/lib/database.types'
import type { WorkerDb } from './config'

export type ExportRow = Database['public']['Tables']['exports']['Row']

export const STUCK_ERROR = 'The export took too long and was stopped. Your settings and the mix are saved.'

/**
 * Claims one export: a conditional update from queued to rendering that returns the row
 * only to the caller whose update matched. Two workers racing for the same row cannot both
 * win - the loser's update matches nothing and gets null.
 */
export async function claimExport(db: WorkerDb, id: string, now: Date = new Date()): Promise<ExportRow | null> {
  const { data, error } = await db
    .from('exports')
    .update({ status: 'rendering', started_at: now.toISOString(), progress: 0 })
    .eq('id', id)
    .eq('status', 'queued')
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data
}

/** Claims the oldest queued export. A lost race tries the next one. */
export async function claimNext(db: WorkerDb, now: Date = new Date()): Promise<ExportRow | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: candidates, error } = await db
      .from('exports')
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
    if (error) throw error
    const candidate = candidates?.[0]
    if (!candidate) return null
    const claimed = await claimExport(db, candidate.id, now)
    if (claimed) return claimed
  }
  return null
}

/** Marks every export rendering past the stuck timeout as failed. Returns their ids. */
export async function failStuck(
  db: WorkerDb,
  now: Date = new Date(),
  timeoutMs: number = EXPORT_STUCK_TIMEOUT_MS
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString()
  const { data, error } = await db
    .from('exports')
    .update({ status: 'failed', error: STUCK_ERROR, finished_at: now.toISOString() })
    .eq('status', 'rendering')
    .lt('started_at', cutoff)
    .select('id')
  if (error) throw error
  return (data ?? []).map((r) => r.id)
}
