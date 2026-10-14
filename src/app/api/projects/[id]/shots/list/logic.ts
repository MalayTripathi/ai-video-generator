import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { remainingShotQuoteCredits } from '@/lib/config/credits'
import { holdAndSettle } from '@/lib/credits/balance'
import type { DisplayShot } from '@/app/(app)/projects/[id]/workbench/_components/types'
import {
  WORKBENCH_SHOT_COLUMNS,
  toDisplayShot,
  type WorkbenchShotRow,
} from '@/app/(app)/projects/[id]/workbench/_components/display-shots'
import { sceneProgress, shotRunView, type ShotRunView } from '@/app/(app)/projects/[id]/workbench/_components/shot-run-view'

type Client = SupabaseClient<Database>

// What the Workbench refreshes when a shot run ends - the shot list and the run's end state,
// never a page render, so no other panel re-renders. Three reads in one wave: the shots
// (elements and dialogue embedded), the project (its claim, latest run and scenes embedded)
// and the run's hold and settle rows.

export type ShotList = {
  shots: DisplayShot[]
  videoType: string | null
  generationState: string | null
  hasPendingPayload: boolean
  run: ShotRunView
  remainingCredits: number
}

type ProjectRow = {
  video_type: string | null
  duration_target: string | null
  generations: { state: string; payload: unknown }[]
  shot_runs: { id: string; attempt_id: string; status: string; stop_reason: string | null; total_scenes: number | null; charged_at: string | null }[]
  scenes: Parameters<typeof sceneProgress>[0][]
}

type DialogueEmbed = { id: string; element_id: string; line: string; order_index: number; elements: { name: string } | null }

export async function loadShotList(params: {
  supabase: Client
  projectId: string
  userId: string
}): Promise<{ ok: true; data: ShotList } | { ok: false; status: 404 | 500; error: string }> {
  const { supabase, projectId, userId } = params
  const [projectResult, shotsResult, ledgerResult] = await Promise.all([
    supabase
      .from('projects')
      .select(
        'video_type, duration_target, generations(state, payload), shot_runs(id, attempt_id, status, stop_reason, total_scenes, charged_at), scenes(target_seconds, shot_run_chunks(scene_complete), shots(duration_sec))'
      )
      .eq('id', projectId)
      .eq('user_id', userId)
      .eq('generations.step', 'workbench')
      .eq('generations.operation', 'generate_shots')
      .is('generations.shot_id', null)
      .order('created_at', { referencedTable: 'shot_runs', ascending: false })
      .limit(1, { referencedTable: 'shot_runs' })
      .maybeSingle(),
    supabase
      .from('shots')
      .select(`${WORKBENCH_SHOT_COLUMNS}, shot_dialogue(id, element_id, line, order_index, elements(name))`)
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    supabase
      .from('credit_ledger')
      .select('kind, delta, dedupe_key, attempt_id')
      .eq('project_id', projectId)
      .in('kind', ['spend', 'refund'])
      .in('operation', ['agent_turn', 'generate_shots']),
  ])
  if (projectResult.error || shotsResult.error || ledgerResult.error) {
    return { ok: false, status: 500, error: 'Could not read the shot list' }
  }
  if (!projectResult.data) return { ok: false, status: 404, error: 'Project not found' }

  const project = projectResult.data as unknown as ProjectRow
  const run = project.shot_runs[0] ?? null
  const charge = holdAndSettle(run ? (ledgerResult.data ?? []).filter((r) => r.attempt_id === run.attempt_id) : [])
  const rows = (shotsResult.data ?? []) as unknown as (WorkbenchShotRow & { shot_dialogue: DialogueEmbed[] })[]
  const shots = rows.map((row) =>
    toDisplayShot(
      row,
      [...(row.shot_dialogue ?? [])]
        .sort((a, b) => a.order_index - b.order_index)
        .map((d) => ({ id: d.id, order_index: d.order_index, element_id: d.element_id, element_name: d.elements?.name ?? '', line: d.line }))
    )
  )
  const generation = project.generations[0] ?? null
  return {
    ok: true,
    data: {
      shots,
      videoType: project.video_type,
      generationState: generation?.state ?? null,
      hasPendingPayload: generation?.payload != null,
      run: shotRunView(run, project.scenes, charge),
      remainingCredits: remainingShotQuoteCredits(
        project.duration_target,
        project.scenes.map(sceneProgress).filter((scene) => !scene.complete)
      ),
    },
  }
}
