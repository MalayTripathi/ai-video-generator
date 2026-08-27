import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { WorkbenchShell } from '@/components/workbench-shell'
import type { AgentMessage } from '@/components/workbench/agent-message'
import { ShotsProvider } from './_components/shots-context'
import { WorkbenchHeader } from './_components/workbench-header'
import { WorkbenchTabs, type WorkbenchTab } from './_components/workbench-tabs'
import { ShotsTab } from './_components/shots-tab'
import { AssetsTab } from './_components/assets-tab'
import { ScriptTab } from './_components/script-tab'
import { WorkbenchFooter } from './_components/workbench-footer'
import type { DisplayDialogueLine, DisplayShot } from './_components/types'
import type { Json, Tables } from '@/lib/database.types'

type ElementRow = Tables<'elements'>
type ShotRow = Tables<'shots'> & { shot_elements: { elements: ElementRow | null }[] }

function resolveDialogue(
  dialogue: Json,
  elementsById: Map<string, ElementRow>
): DisplayDialogueLine[] {
  if (!Array.isArray(dialogue)) return []
  return dialogue.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const v = entry as Record<string, unknown>
    if (typeof v.element_id !== 'string' || typeof v.line !== 'string') return []
    const element = elementsById.get(v.element_id)
    if (!element) return []
    return [{ element_id: v.element_id, element_name: element.name, line: v.line }]
  })
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
      'id, title, source_text, status, current_step, video_type, aspect_ratio, language, video_model, duration_target'
    )
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) {
    notFound()
  }

  const [{ data: shotsRows }, { data: elementsRows }, { data: messageRows }] = await Promise.all([
    supabase
      .from('shots')
      .select('*, shot_elements(elements(id, name, type, status, reference_image_path))')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    supabase.from('elements').select('*').eq('project_id', projectId),
    supabase
      .from('messages')
      .select('*')
      .eq('project_id', projectId)
      .eq('role', 'assistant')
      .order('created_at', { ascending: true }),
  ])

  const elementsById = new Map((elementsRows ?? []).map((el) => [el.id, el]))
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
    dialogue: resolveDialogue(row.dialogue, elementsById),
  }))

  const agentMessages: AgentMessage[] = (messageRows ?? []).map((message) => ({
    id: message.id,
    kind: 'assistant',
    content: message.content,
    createdAt: message.created_at,
  }))

  return (
    <ShotsProvider projectId={projectId} initialShots={shots} initialVideoType={project.video_type}>
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
    </ShotsProvider>
  )
}
