import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { WorkbenchShell } from '@/components/workbench-shell'
import { ShotsProvider } from './_components/shots-context'
import { AssetsProvider } from './_components/assets-context'
import { WorkbenchHeader } from './_components/workbench-header'
import { WorkbenchTabs, type WorkbenchTab } from './_components/workbench-tabs'
import { ShotsTab } from './_components/shots-tab'
import { AssetsTab } from './_components/assets-tab'
import { ScriptTab } from './_components/script-tab'
import { WorkbenchFooter } from './_components/workbench-footer'
import { buildAgentMessages } from './_components/build-agent-messages'
import { getElementGenerateAffordability } from './actions'
import { getProjectElementsForUser, type ElementGroup } from '@/lib/elements/read'
import type { DisplayDialogueLine, DisplayShot } from './_components/types'
import type { Tables } from '@/lib/database.types'
import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import type { CameraOrigin } from '@/lib/config/enums'

type ElementRow = Pick<Tables<'elements'>, 'id' | 'name' | 'type' | 'status' | 'reference_image_path'>
type ShotRow = Tables<'shots'> & { shot_elements: { elements: ElementRow | null }[] }
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
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: project } = await supabase
    .from('projects')
    .select(
      'id, title, source_text, current_step, furthest_step, video_type, aspect_ratio, language, video_model, duration_target'
    )
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) {
    notFound()
  }

  const [
    { data: shotsRows },
    elementsResult,
    affordability,
    { data: dialogueRows },
    { data: messageRows },
    { data: generation },
    { data: usageRows },
    { data: creditLedgerRows },
  ] = await Promise.all([
    supabase
      .from('shots')
      .select('*, shot_elements(elements(id, name, type, status, reference_image_path))')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    // Same grouped-and-signed read the Assets tab's client-driven refresh reuses (see
    // workbench/actions.ts's getProjectElements comment) - one call serves both the
    // shots/dialogue join below and the Assets tab's initial render, so there is no
    // second raw `elements` query.
    getProjectElementsForUser(supabase, projectId, user.id),
    getElementGenerateAffordability(),
    supabase
      .from('shot_dialogue')
      .select('id, shot_id, element_id, line, order_index')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    supabase
      .from('messages')
      .select('*')
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
    // dollar figure (Credits Task 8). Scoped to agent_turn spend rows only; this cost
    // line has never shown anything but the agent turn's own charge.
    supabase
      .from('credit_ledger')
      .select('message_id, delta')
      .eq('project_id', projectId)
      .eq('kind', 'spend')
      .eq('operation', 'agent_turn'),
  ])

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
  const typedShotsRows = (shotsRows ?? []) as unknown as ShotRow[]

  const shots: DisplayShot[] = typedShotsRows.map((row) => ({
    id: row.id,
    order_index: row.order_index,
    shot_key: row.shot_key,
    section_label: row.section_label,
    voice_over: row.voice_over,
    visual_description: row.visual_description,
    duration_sec: row.duration_sec,
    duration_locked: row.duration_locked,
    shot_size: row.shot_size,
    shot_size_origin: row.shot_size_origin as CameraOrigin,
    camera_angle: row.camera_angle,
    camera_angle_origin: row.camera_angle_origin as CameraOrigin,
    camera_movement: row.camera_movement,
    camera_movement_origin: row.camera_movement_origin as CameraOrigin,
    elements: (row.shot_elements ?? [])
      .map((se) => se.elements)
      .filter((el): el is ElementRow => el !== null)
      .map((el) => ({
        id: el.id,
        name: el.name,
        type: el.type,
        status: el.status,
        reference_image_path: el.reference_image_path,
      })),
    dialogue: dialogueByShot.get(row.id) ?? [],
  }))

  const shotNumberByKey = new Map(shots.map((s) => [s.shot_key, s.order_index + 1]))
  const costByMessageId = new Map<string, number>()
  for (const u of usageRows ?? []) {
    if (!u.message_id) continue
    costByMessageId.set(u.message_id, (costByMessageId.get(u.message_id) ?? 0) + (u.estimated_cost ?? 0))
  }
  const creditsByMessageId = new Map<string, number>()
  for (const r of creditLedgerRows ?? []) {
    if (!r.message_id) continue
    creditsByMessageId.set(r.message_id, (creditsByMessageId.get(r.message_id) ?? 0) + -r.delta)
  }
  const agentMessages = buildAgentMessages(messageRows ?? [], shotNumberByKey, costByMessageId, creditsByMessageId)

  const hasPendingPayload = generation?.payload != null
  const estimatedCredits =
    project.duration_target && project.duration_target in durationConfig
      ? durationConfig[project.duration_target as DurationTarget].estimatedCredits
      : durationConfig['1-2min'].estimatedCredits

  return (
    <ShotsProvider
      projectId={projectId}
      initialShots={shots}
      initialVideoType={project.video_type}
      initialVideoModel={project.video_model}
      initialGenerationState={generation?.state ?? null}
      initialHasPendingPayload={hasPendingPayload}
      initialFurthestStep={project.furthest_step}
      estimatedCredits={estimatedCredits}
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
          agentMessages={agentMessages}
          header={<WorkbenchHeader project={project} />}
          footer={<WorkbenchFooter />}
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
