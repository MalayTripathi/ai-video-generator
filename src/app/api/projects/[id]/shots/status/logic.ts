import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { needsDeadRunSettlement, settleDeadShotRuns, type ShotRunLedger } from '@/lib/shots/runs'
import { shotRunView, type ShotRunView } from '@/app/(app)/projects/[id]/workbench/_components/shot-run-view'

type Client = SupabaseClient<Database>

// The Workbench's poll while shots are being written: the claim's state, the latest run's
// progress and how many shots exist - one PostgREST read (project, its generate_shots claim,
// latest run, scenes' completion and a shot count, embedded). Never a page render. A dead
// chain is settled here only once it is past its stale window (needsDeadRunSettlement),
// never while its worker may still be writing.

export type ShotsStatus = {
  generationState: string | null
  shotCount: number
  run: ShotRunView
}

type StatusRow = {
  id: string
  generations: { state: string }[]
  shot_runs: { status: string; stop_reason: string | null; total_scenes: number | null; heartbeat_at: string; finished_at: string | null; charged_at: string | null }[]
  scenes: { shot_run_chunks: { scene_complete: boolean }[] }[]
  shots: { count: number }[]
}

async function readStatusRow(supabase: Client, projectId: string, userId: string) {
  return supabase
    .from('projects')
    .select(
      'id, generations(state), shot_runs(status, stop_reason, total_scenes, heartbeat_at, finished_at, charged_at), scenes(shot_run_chunks(scene_complete)), shots(count)'
    )
    .eq('id', projectId)
    .eq('user_id', userId)
    .eq('generations.step', 'workbench')
    .eq('generations.operation', 'generate_shots')
    .is('generations.shot_id', null)
    .order('created_at', { referencedTable: 'shot_runs', ascending: false })
    .limit(1, { referencedTable: 'shot_runs' })
    .maybeSingle()
}

export async function loadShotsStatus(params: {
  supabase: Client
  projectId: string
  userId: string
  ledger: ShotRunLedger
}): Promise<{ ok: true; data: ShotsStatus } | { ok: false; status: 404 | 500; error: string }> {
  const { supabase, projectId, userId } = params
  const first = await readStatusRow(supabase, projectId, userId)
  if (first.error) return { ok: false, status: 500, error: 'Could not read the shot list status' }
  if (!first.data) return { ok: false, status: 404, error: 'Project not found' }
  let data = first.data

  const latest = (data as unknown as StatusRow).shot_runs[0]
  if (latest && needsDeadRunSettlement(latest)) {
    const { changed } = await settleDeadShotRuns(supabase, params.ledger, projectId)
    if (changed) {
      const fresh = await readStatusRow(supabase, projectId, userId)
      if (fresh.error || !fresh.data) return { ok: false, status: 500, error: 'Could not read the shot list status' }
      data = fresh.data
    }
  }

  const row = data as unknown as StatusRow
  return {
    ok: true,
    data: {
      generationState: row.generations[0]?.state ?? null,
      shotCount: row.shots[0]?.count ?? 0,
      run: shotRunView(row.shot_runs[0] ?? null, row.scenes),
    },
  }
}
