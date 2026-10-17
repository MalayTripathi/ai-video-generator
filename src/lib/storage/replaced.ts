import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { listObjectsUnder, removeObjects } from './sweep'

// Removing storage files a newer one replaced, in a project that is kept. Called right after
// the DB write that commits the new path. Two rules hold every time:
//   - a path held in any of the project's generations payloads is never removed - a resume
//     may relink it, and it may be paid output;
//   - while the project has an export queued or rendering, nothing is removed (the worker
//     downloads its inputs at render start): the paths go to pending_storage_deletions, and
//     the worker removes them when that export ends (processPendingDeletions).
// Every call is best-effort and never throws: by now the new file is committed, and a file
// left behind costs storage, not correctness. The discard helpers build the service-role
// client themselves (pending_storage_deletions has no client policies), so callers import
// nothing; they pass paths under the project's own prefix, and anything else is ignored. The
// export worker, which has its own service-role client, passes it to processPendingDeletions.

type Client = SupabaseClient<Database>

const ACTIVE_EXPORT_STATUSES = ['queued', 'rendering']

export function projectPrefix(userId: string, projectId: string): string {
  return `${userId}/${projectId}/`
}

/** The paths no payload of the project mentions. Null when the read failed (remove nothing). */
async function withoutPayloadPaths(client: Client, projectId: string, paths: readonly string[]): Promise<string[] | null> {
  const { data, error } = await client
    .from('generations')
    .select('payload')
    .eq('project_id', projectId)
    .not('payload', 'is', null)
  if (error) {
    console.error(`[storage] could not read payloads for project ${projectId}`, error.message)
    return null
  }
  const held = (data ?? []).map((row) => JSON.stringify(row.payload)).join('\n')
  return paths.filter((path) => !held.includes(path))
}

async function hasActiveExport(client: Client, projectId: string): Promise<boolean | null> {
  const { data, error } = await client
    .from('exports')
    .select('id')
    .eq('project_id', projectId)
    .in('status', ACTIVE_EXPORT_STATUSES)
    .limit(1)
  if (error) {
    console.error(`[storage] could not read exports for project ${projectId}`, error.message)
    return null
  }
  return (data ?? []).length > 0
}

/** Removes (or queues, during an export) files a committed write replaced. Never throws. */
export async function discardReplacedFiles(params: {
  userId: string
  projectId: string
  paths: readonly (string | null | undefined)[]
  keep?: readonly string[]
}): Promise<void> {
  try {
    const client = createServiceRoleClient()
    const prefix = projectPrefix(params.userId, params.projectId)
    const keep = new Set(params.keep ?? [])
    const candidates = [...new Set(params.paths)].filter(
      (p): p is string => typeof p === 'string' && p.startsWith(prefix) && !keep.has(p)
    )
    if (candidates.length === 0) return

    const [unheld, exporting] = await Promise.all([
      withoutPayloadPaths(client, params.projectId, candidates),
      hasActiveExport(client, params.projectId),
    ])
    if (unheld === null || exporting === null || unheld.length === 0) return

    if (exporting) {
      const { error } = await client.from('pending_storage_deletions').upsert(
        unheld.map((path) => ({ project_id: params.projectId, user_id: params.userId, path })),
        { onConflict: 'path', ignoreDuplicates: true }
      )
      if (error) console.error(`[storage] could not queue replaced files for project ${params.projectId}`, error.message)
      return
    }
    await removeObjects(client, unheld)
  } catch (err) {
    console.error(`[storage] removing replaced files failed for project ${params.projectId}`, err)
  }
}

/**
 * Removes every file under `folder` except `keep` - a folder whose files all belong to one
 * thing (a shot's images), once the write naming the one to keep has committed. Same rules
 * as discardReplacedFiles. Never throws.
 */
export async function discardFolderExcept(params: {
  userId: string
  projectId: string
  folder: string
  keep: readonly string[]
}): Promise<void> {
  try {
    const paths = await listObjectsUnder(createServiceRoleClient(), params.folder)
    await discardReplacedFiles({ ...params, paths })
  } catch (err) {
    console.error(`[storage] listing ${params.folder} failed`, err)
  }
}

/**
 * The export worker's half: once a project's export has ended (succeeded or failed) and no
 * other export of it is active, removes the files queued while it rendered, then their rows.
 * A path a payload has since come to hold stays queued. Never throws.
 */
export async function processPendingDeletions(client: Client, projectId: string): Promise<number> {
  try {
    const exporting = await hasActiveExport(client, projectId)
    if (exporting !== false) return 0
    const { data, error } = await client
      .from('pending_storage_deletions')
      .select('id, path')
      .eq('project_id', projectId)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    if (rows.length === 0) return 0
    const unheld = await withoutPayloadPaths(
      client,
      projectId,
      rows.map((r) => r.path)
    )
    if (unheld === null) return 0
    const removable = rows.filter((r) => unheld.includes(r.path))
    if (removable.length === 0) return 0
    await removeObjects(
      client,
      removable.map((r) => r.path)
    )
    const { error: deleteError } = await client
      .from('pending_storage_deletions')
      .delete()
      .in(
        'id',
        removable.map((r) => r.id)
      )
    if (deleteError) throw new Error(deleteError.message)
    return removable.length
  } catch (err) {
    console.error(`[storage] pending deletions failed for project ${projectId}`, err)
    return 0
  }
}
