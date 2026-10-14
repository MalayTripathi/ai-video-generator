import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { WorkbenchShell } from '@/components/workbench-shell'
import { ShotsProvider } from './_components/shots-context'
import { AssetsProvider } from './_components/assets-context'
import { WorkbenchHeader } from './_components/workbench-header'
import { WorkbenchTabs, type WorkbenchTab } from './_components/workbench-tabs'
import { ShotsTab } from './_components/shots-tab'
import { AssetsTab } from './_components/assets-tab'
import { ScriptTab } from './_components/script-tab'
import { WorkbenchFooter } from './_components/workbench-footer'
import { AGENT_MESSAGE_COLUMNS, buildAgentMessages } from '@/lib/build-agent-messages'
import { getElementGenerateAffordability } from './affordability'
import { getProjectElementsForUser, type ElementGroup } from '@/lib/elements/read'
import type { DisplayDialogueLine, DisplayShot } from './_components/types'
import type { Tables } from '@/lib/database.types'
import { remainingShotQuoteCredits, shotGenerationCredits } from '@/lib/config/credits'
import { holdAndSettle } from '@/lib/credits/balance'
import { placeHold, settleHold } from '@/lib/credits/ledger'
import { needsDeadRunSettlement, settleDeadShotRuns } from '@/lib/shots/runs'
import { sceneProgress, shotRunView, type ShotRunView } from './_components/shot-run-view'
import { WORKBENCH_SHOT_COLUMNS, toDisplayShot, type DisplayElementRow, type WorkbenchShotRow } from './_components/display-shots'

type ElementRow = DisplayElementRow
type ShotDialogueRow = Pick<
  Tables<'shot_dialogue'>,
  'id' | 'shot_id' | 'element_id' | 'line' | 'order_index'
>

function groupDialogueByShot(
  rows: ShotDialogueRow[],
  elementsById: Map<string, ElementRow>
): Map<string, DisplayDialogueLine[]> {
  const byShot = new Map<string, DisplayDialogueLine[]>()
  for (const row of rows) {
    const element = elementsById.get(row.element_id)
    const lines = byShot.get(row.shot_id) ?? []
    lines.push({
      id: row.id,
      order_index: row.order_index,
      element_id: row.element_id,
      element_name: element?.name ?? '',
      line: row.line,
    })
    byShot.set(row.shot_id, lines)
  }
  return byShot
}

export default async function WorkbenchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { id: projectId } = await params
  const { tab } = await searchParams
  const activeTab: WorkbenchTab = tab === 'assets' || tab === 'script' ? tab : 'shots'

  const supabase = await createClient()
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  // The project row gates the page (404 / redirect), but no read below needs its data -
  // they key on projectId and are RLS-scoped to the owner - so all of them run in one
  // wave with it, and the gate is applied once they land.
  // A real Promise (not the query builder), so the Assets price can wait on its image
  // quality without a second read.
  const projectPromise = Promise.resolve(
    supabase
      .from('projects')
      .select(
        'id, title, source_text, current_step, furthest_step, video_type, aspect_ratio, language, video_model, video_resolution, image_model, image_quality, quality_preset, duration_target'
      )
      .eq('id', projectId)
      .eq('user_id', user.id)
      .maybeSingle()
  )
  const readShots = () =>
    supabase
      .from('shots')
      .select(WORKBENCH_SHOT_COLUMNS)
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
  const [
    { data: project, error: projectError },
    { data: firstShotsRows },
    elementsResult,
    affordability,
    { data: dialogueRows },
    { data: messageRows },
    { data: generation },
    { data: usageRows },
    { data: creditLedgerRows },
    { data: latestRun },
    { data: sceneRows },
  ] = await Promise.all([
    projectPromise,
    readShots(),
    // Same grouped-and-signed read the Assets tab's client-driven refresh reuses (see
    // workbench/actions.ts's getProjectElements comment) - one call serves both the
    // shots/dialogue join below and the Assets tab's initial render, so there is no
    // second raw `elements` query.
    getProjectElementsForUser(supabase, projectId, user.id),
    getElementGenerateAffordability(projectPromise.then(({ data }) => data ?? null)),
    supabase
      .from('shot_dialogue')
      .select('id, shot_id, element_id, line, order_index')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    supabase
      .from('messages')
      .select(AGENT_MESSAGE_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    supabase
      .from('generations')
      .select('state, payload')
      .eq('project_id', projectId)
      .eq('step', 'workbench')
      .eq('operation', 'generate_shots')
      .is('shot_id', null)
      .maybeSingle(),
    // Real, settled per-turn spend (never from the model's own prose) - grouped by
    // message_id below. Excludes 'pending' rows: a genuinely abandoned turn's
    // reservations are never confirmed spent, and build-agent-messages.ts omits their
    // cost line unconditionally regardless of what this map holds for that turn anyway.
    supabase.from('usage').select('message_id, estimated_cost').eq('project_id', projectId).neq('status', 'pending'),
    // The turn's real, settled credit spend - never usage, never recomputed from the
    // dollar figure (Credits Task 8). Scoped to agent_turn rows, spend net of the refund
    // that settles a hold (a regenerate-all turn holds until its chain ends).
    supabase
      .from('credit_ledger')
      .select('message_id, delta, kind, operation, attempt_id, dedupe_key')
      .eq('project_id', projectId)
      .in('kind', ['spend', 'refund'])
      .in('operation', ['agent_turn', 'generate_shots']),
    // The latest shot run: the generating state's progress line, why a run stopped, and
    // whether a dead chain needs settling on this load.
    supabase
      .from('shot_runs')
      .select('id, attempt_id, status, stop_reason, total_scenes, heartbeat_at, finished_at, charged_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Which scenes are written - progress, and whether "Generate remaining shots" applies.
    supabase.from('scenes').select('id, target_seconds, shot_run_chunks(scene_complete), shots(duration_sec)').eq('project_id', projectId),
  ])

  // A failed read is an error (the error boundary), never a 404 - only a missing row is.
  if (projectError) {
    throw new Error(`Could not load project ${projectId}: ${projectError.message}`)
  }
  if (!project) {
    notFound()
  }

  // A dead chain is settled on the first load after its stale window (and a terminal run
  // whose charge never landed is completed), then the page renders from a fresh read - so a
  // run that died never leaves the generating state spinning. Never sooner: a load while
  // the worker is still writing must not settle or charge it.
  let generationState = generation?.state ?? null
  let run = latestRun
  let shotsRows = firstShotsRows
  if (run && needsDeadRunSettlement(run)) {
    const { changed } = await settleDeadShotRuns(supabase, { placeHold, settleHold }, projectId)
    if (changed) {
      // Settling re-sequences the shots (and drops a dead chunk's half-written ones).
      const [{ data: freshGeneration }, { data: freshRun }, { data: freshShots }] = await Promise.all([
        supabase
          .from('generations')
          .select('state')
          .eq('project_id', projectId)
          .eq('step', 'workbench')
          .eq('operation', 'generate_shots')
          .is('shot_id', null)
          .maybeSingle(),
        supabase
          .from('shot_runs')
          .select('id, attempt_id, status, stop_reason, total_scenes, heartbeat_at, finished_at, charged_at')
          .eq('project_id', projectId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        readShots(),
      ])
      generationState = freshGeneration?.state ?? generationState
      run = freshRun
      shotsRows = freshShots
    }
  }
  // The ledger rows read above carry the latest run's hold and settle too (by attempt id).
  const runCharge = holdAndSettle(run ? (creditLedgerRows ?? []).filter((r) => r.attempt_id === run.attempt_id) : [])
  const scenes = (sceneRows ?? []) as unknown as Parameters<typeof sceneProgress>[0][]
  const runView: ShotRunView = shotRunView(run, scenes, runCharge)
  const remainingCredits = remainingShotQuoteCredits(
    project.duration_target,
    scenes.map(sceneProgress).filter((scene) => !scene.complete)
  )



  const elementGroups: ElementGroup[] = elementsResult.success ? elementsResult.groups : []
  const elementsExpiresAt = elementsResult.success ? elementsResult.expires_at : new Date().toISOString()
  if (!elementsResult.success) {
    console.error(`[workbench] Failed to load elements for project ${projectId}:`, elementsResult.error)
  }
  const elementsById = new Map<string, ElementRow>(
    elementGroups
      .flatMap((group) => group.elements)
      .map((el) => [
        el.id,
        { id: el.id, name: el.name, type: el.type, status: el.status, reference_image_path: el.reference_image_path },
      ])
  )
  const dialogueByShot = groupDialogueByShot(dialogueRows ?? [], elementsById)
  const typedShotsRows = (shotsRows ?? []) as unknown as WorkbenchShotRow[]
  const shots: DisplayShot[] = typedShotsRows.map((row) => toDisplayShot(row, dialogueByShot.get(row.id) ?? []))

  const shotNumberByKey = new Map(shots.map((s) => [s.shot_key, s.order_index + 1]))
  const costByMessageId = new Map<string, number>()
  for (const u of usageRows ?? []) {
    if (!u.message_id) continue
    costByMessageId.set(u.message_id, (costByMessageId.get(u.message_id) ?? 0) + (u.estimated_cost ?? 0))
  }
  const creditsByMessageId = new Map<string, number>()
  for (const r of creditLedgerRows ?? []) {
    if (!r.message_id || r.operation !== 'agent_turn') continue
    creditsByMessageId.set(r.message_id, (creditsByMessageId.get(r.message_id) ?? 0) + -r.delta)
  }
  const agentMessages = buildAgentMessages(messageRows ?? [], shotNumberByKey, costByMessageId, creditsByMessageId)

  const hasPendingPayload = generation?.payload != null
  const shotListCredits = shotGenerationCredits(project.duration_target)

  return (
    <ShotsProvider
      projectId={projectId}
      initialShots={shots}
      initialVideoType={project.video_type}
      initialVideoModel={project.video_model}
      initialGenerationState={generationState}
      initialRun={runView}
      initialHasPendingPayload={hasPendingPayload}
      initialFurthestStep={project.furthest_step}
      shotListCredits={shotListCredits}
      remainingCredits={remainingCredits}
    >
      <AssetsProvider
        projectId={projectId}
        initialGroups={elementGroups}
        initialExpiresAt={elementsExpiresAt}
        generateCredits={affordability.generateCredits}
        hasInsufficientBalance={affordability.hasInsufficientBalance}
      >
        <WorkbenchShell
          project={project}
          agentStep="workbench"
          agentMessages={agentMessages}
          header={<WorkbenchHeader project={project} />}
          footer={<WorkbenchFooter projectId={projectId} furthestStep={project.furthest_step} activeTab={activeTab} />}
        >
          <WorkbenchTabs projectId={projectId} activeTab={activeTab}>
            {activeTab === 'shots' && <ShotsTab />}
            {activeTab === 'assets' && <AssetsTab />}
            {activeTab === 'script' && <ScriptTab />}
          </WorkbenchTabs>
        </WorkbenchShell>
      </AssetsProvider>
    </ShotsProvider>
  )
}
