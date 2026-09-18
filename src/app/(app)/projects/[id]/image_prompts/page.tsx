import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { WorkbenchShell } from '@/components/workbench-shell'
import { ProjectHeader } from '@/components/workbench/project-header'
import { ImagePromptsFooter } from './_components/image-prompts-footer'
import { ImagePromptsProvider } from './_components/image-prompts-context'
import { PromptList } from './_components/prompt-list'
import type { PromptShot } from './_components/types'
import { shouldAutoGenerate } from './_components/derive-image-prompts-phase'
import { AssetsProvider } from '../workbench/_components/assets-context'
import { getElementGenerateAffordability } from '../workbench/actions'
import { getProjectElementsForUser, type ElementGroup } from '@/lib/elements/read'
import { buildAgentMessages } from '@/lib/build-agent-messages'
import { stepIndex } from '@/lib/config/pipeline'
import { creditsFor } from '@/lib/config/credits'
import { getBalance } from '@/lib/credits/balance'
import { ASPECT_RATIOS, type AspectRatio } from '@/lib/config/enums'
import type { Tables } from '@/lib/database.types'

type ElementRow = Pick<Tables<'elements'>, 'id' | 'name' | 'type' | 'status' | 'reference_image_path'>
type ShotRow = Tables<'shots'> & { shot_elements: { elements: ElementRow | null }[] }

export default async function ImagePromptsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

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

  // View-gate, not an edit-lock: a user whose furthest_step hasn't reached this page
  // yet must not see it. This is the opposite direction of the three existing
  // furthest_step >= stepIndex('storyboard') checks elsewhere (those lock editing on
  // a step already passed) - deliberately not unified with them.
  if (project.furthest_step < stepIndex('image_prompts')) {
    redirect(`/projects/${projectId}/${project.current_step}`)
  }

  const [
    { data: shotsRows },
    elementsResult,
    affordability,
    { data: generation },
    { data: messageRows },
    { data: usageRows },
    { data: creditLedgerRows },
  ] = await Promise.all([
    supabase
      .from('shots')
      .select('*, shot_elements(elements(id, name, type, status, reference_image_path))')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    // The same grouped-and-signed read the Workbench uses: signed reference thumbnails
    // for the tiles, and the element list behind the picker.
    getProjectElementsForUser(supabase, projectId, user.id),
    getElementGenerateAffordability(),
    supabase
      .from('generations')
      .select('state')
      .eq('project_id', projectId)
      .eq('step', 'image_prompts')
      .eq('operation', 'write_image_prompts')
      .is('shot_id', null)
      .maybeSingle(),
    supabase
      .from('messages')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    supabase.from('usage').select('message_id, estimated_cost').eq('project_id', projectId).neq('status', 'pending'),
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
    console.error(`[image-prompts] Failed to load elements for project ${projectId}:`, elementsResult.error)
  }

  const shotRows = (shotsRows ?? []) as unknown as ShotRow[]
  // ProjectHeader and the shell read the raw rows; the client provider gets only what
  // Step 3 renders.
  const shots = shotRows
  const promptShots: PromptShot[] = shotRows.map((row) => ({
    id: row.id,
    order_index: row.order_index,
    shot_key: row.shot_key,
    image_prompt: row.image_prompt,
    image_prompt_stale: row.image_prompt_stale,
    image_prompt_edited: row.image_prompt_edited,
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
  }))
  const aspectRatio: AspectRatio = (ASPECT_RATIOS as readonly string[]).includes(project.aspect_ratio ?? '')
    ? (project.aspect_ratio as AspectRatio)
    : '9:16'

  const readOnly = project.furthest_step >= stepIndex('storyboard')

  // First arrival with nothing ever attempted generates once - but only if the balance
  // covers it. Decided here, on the server, so the page never renders a "writing" state
  // for a run that would be refused; a short balance shows the banner instead.
  const generationState = generation?.state ?? null
  let autoGenerate = shouldAutoGenerate({ generationState, shots: promptShots, readOnly })
  let initialInsufficient: { required: number; balance: number } | null = null
  if (autoGenerate) {
    const required = creditsFor({
      step: 'image_prompts',
      operation: 'write_image_prompts',
      quantity: promptShots.length,
    })
    const balance = await getBalance(user.id)
    if (balance < required) {
      autoGenerate = false
      initialInsufficient = { required, balance }
    }
  }

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

  return (
    <ImagePromptsProvider
      projectId={projectId}
      initialShots={promptShots}
      initialGenerationState={generationState}
      autoGenerate={autoGenerate}
      initialInsufficient={initialInsufficient}
      aspectRatio={aspectRatio}
      readOnly={readOnly}
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
          readOnly={readOnly}
          shots={shots}
          header={<ProjectHeader project={project} shots={shots} />}
          footer={<ImagePromptsFooter />}
        >
          <PromptList />
        </WorkbenchShell>
      </AssetsProvider>
    </ImagePromptsProvider>
  )
}
