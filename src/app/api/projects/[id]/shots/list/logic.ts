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
import { getElementGenerateAffordability } from '@/app/(app)/projects/[id]/workbench/affordability'
import { getProjectElementsForUser, type ElementGroup } from '@/lib/elements/read'
import { AGENT_MESSAGE_COLUMNS, buildAgentMessages } from '@/lib/build-agent-messages'
import type { AgentMessage } from '@/components/workbench/agent-message'
import { sumTurnCost } from '@/lib/usage/turn-cost'

type Client = SupabaseClient<Database>

// What the Workbench refreshes when a shot run ends - everything a run changes on the page,
// never a page render: the shot list, the run's end state, the title, the Assets elements and
// their generate gate, the run's plan note, and for an agent run its turn's settled cost line.
// One wave: the shots (dialogue embedded), the project (its claim, latest run, scenes and plan
// notes embedded), the run's hold and settle rows, the elements and the balance; then the
// elements' image signing, and for a settled agent run its turn's dollar cost. The rail's
// figures ride on the route.

/** The Assets tab's state after a run, or null when the elements could not be read. */
export type RunElements = { groups: ElementGroup[]; expiresAt: string; generateCredits: number; hasInsufficientBalance: boolean }

export type ShotList = {
  title: string | null
  shots: DisplayShot[]
  videoType: string | null
  generationState: string | null
  hasPendingPayload: boolean
  run: ShotRunView
  remainingCredits: number
  elements: RunElements | null
  /** The run's plan note (kind run_note, written since it started), oldest first. */
  runMessages: AgentMessage[]
  /** An agent run's turn, once the run is settled: its user message id and its final cost
   * line - credits net of the hold's refund, and dollars - which replaces the turn's own. */
  turn: { messageId: string; credits: number; usd: number } | null
}

type ProjectRow = {
  title: string | null
  video_type: string | null
  image_model: string
  image_quality: string
  duration_target: string | null
  generations: { state: string; payload: unknown }[]
  shot_runs: {
    id: string
    attempt_id: string
    status: string
    stop_reason: string | null
    total_scenes: number | null
    charged_at: string | null
    created_at: string
    message_id: string | null
    agent_generation_id: string | null
  }[]
  scenes: Parameters<typeof sceneProgress>[0][]
  messages: Parameters<typeof buildAgentMessages>[0]
}

type DialogueEmbed = { id: string; element_id: string; line: string; order_index: number; elements: { name: string } | null }

export async function loadShotList(params: {
  supabase: Client
  projectId: string
  userId: string
}): Promise<{ ok: true; data: ShotList } | { ok: false; status: 404 | 500; error: string }> {
  const { supabase, projectId, userId } = params
  // A real Promise, so the generate gate can price from it while its balance read runs.
  const projectPromise = Promise.resolve(
    supabase
      .from('projects')
      .select(
        `title, video_type, duration_target, image_model, image_quality, generations(state, payload), shot_runs(id, attempt_id, status, stop_reason, total_scenes, charged_at, created_at, message_id, agent_generation_id), scenes(target_seconds, shot_run_chunks(scene_complete), shots(duration_sec)), messages(${AGENT_MESSAGE_COLUMNS})`
      )
      .eq('id', projectId)
      .eq('user_id', userId)
      .eq('generations.step', 'workbench')
      .eq('generations.operation', 'generate_shots')
      .is('generations.shot_id', null)
      .order('created_at', { referencedTable: 'shot_runs', ascending: false })
      .limit(1, { referencedTable: 'shot_runs' })
      .eq('messages.kind', 'run_note')
      .order('created_at', { referencedTable: 'messages', ascending: true })
      .maybeSingle()
  )
  const [projectResult, shotsResult, ledgerResult, elementsResult, affordability] = await Promise.all([
    projectPromise,
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
    getProjectElementsForUser(supabase, projectId, userId),
    getElementGenerateAffordability(
      projectPromise.then(({ data }) => (data as unknown as ProjectRow | null) ?? null),
      userId
    ),
  ])
  if (projectResult.error || shotsResult.error || ledgerResult.error) {
    return { ok: false, status: 500, error: 'Could not read the shot list' }
  }
  if (!projectResult.data) return { ok: false, status: 404, error: 'Project not found' }

  const project = projectResult.data as unknown as ProjectRow
  const run = project.shot_runs[0] ?? null
  const runLedger = run ? (ledgerResult.data ?? []).filter((r) => r.attempt_id === run.attempt_id) : []
  const charge = holdAndSettle(runLedger)
  // A settled agent run: its turn's net credits from the rows already read; its dollars are
  // the one extra read, summed over every call the turn and its chain made.
  const turnMessageId = run?.agent_generation_id && run.message_id && run.charged_at ? run.message_id : null
  const turn = turnMessageId
    ? {
        messageId: turnMessageId,
        credits: -runLedger.reduce((sum, r) => sum + r.delta, 0),
        usd: await sumTurnCost(supabase, turnMessageId),
      }
    : null
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
  // The run's plan note: only notes are read, and only those since the run began are its own.
  const runRows = run ? project.messages.filter((m) => Date.parse(m.created_at) >= Date.parse(run.created_at)) : []
  const shotNumberByKey = new Map(shots.map((s) => [s.shot_key, s.order_index + 1]))
  if (!elementsResult.success) console.error(`[shots] list: elements unreadable for project ${projectId}:`, elementsResult.error)
  return {
    ok: true,
    data: {
      title: project.title,
      shots,
      videoType: project.video_type,
      generationState: generation?.state ?? null,
      hasPendingPayload: generation?.payload != null,
      run: shotRunView(run, project.scenes, charge),
      remainingCredits: remainingShotQuoteCredits(
        project.duration_target,
        project.scenes.map(sceneProgress).filter((scene) => !scene.complete)
      ),
      elements: elementsResult.success
        ? { groups: elementsResult.groups, expiresAt: elementsResult.expires_at, ...affordability }
        : null,
      runMessages: buildAgentMessages(runRows, shotNumberByKey, new Map(), new Map()),
      turn,
    },
  }
}
