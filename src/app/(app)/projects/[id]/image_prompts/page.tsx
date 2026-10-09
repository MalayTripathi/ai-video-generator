import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { storyboardImagePriceKey } from '@/lib/images/price-key'
import { WorkbenchShell } from '@/components/workbench-shell'
import { ProjectHeader } from '@/components/workbench/project-header'
import { ImagePromptsFooter } from './_components/image-prompts-footer'
import { ImagePromptsProvider } from './_components/image-prompts-context'
import { PromptList } from './_components/prompt-list'
import type { PromptShot } from './_components/types'
import { shouldAutoGenerate } from './_components/derive-image-prompts-phase'
import { AssetsProvider } from '../workbench/_components/assets-context'
import { getElementGenerateAffordability } from '../workbench/affordability'
import { getProjectElementsForUser, type ElementGroup } from '@/lib/elements/read'
import { AGENT_MESSAGE_COLUMNS, buildAgentMessages } from '@/lib/build-agent-messages'
import { stepIndex } from '@/lib/config/pipeline'
import { creditsFor } from '@/lib/config/credits'
import { getBalance } from '@/lib/credits/balance'
import { ASPECT_RATIOS, type AspectRatio } from '@/lib/config/enums'
import type { Tables } from '@/lib/database.types'
import { signStoryboardImages, storyboardThumbUrl } from '@/app/api/projects/[id]/images/status/logic'

type ElementRow = Pick<Tables<'elements'>, 'id' | 'name' | 'type' | 'status' | 'reference_image_path'>
// Only the columns Step 3 renders, plus what the header (durations) and the agent panel
// (shot_key, order_index) read - these rows are also serialized to the client shell.
const IMAGE_PROMPTS_SHOT_COLUMNS =
  'id, order_index, shot_key, image_prompt, image_prompt_stale, image_prompt_edited, image_path, image_stale, duration_sec, duration_locked'
type ShotRow = Pick<
  Tables<'shots'>,
  | 'id'
  | 'order_index'
  | 'shot_key'
  | 'image_prompt'
  | 'image_prompt_stale'
  | 'image_prompt_edited'
  | 'image_path'
  | 'image_stale'
  | 'duration_sec'
  | 'duration_locked'
> & { shot_elements: { elements: ElementRow | null }[] }

export default async function ImagePromptsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  const shotsPromise = Promise.resolve(
    supabase
      .from('shots')
      .select(`${IMAGE_PROMPTS_SHOT_COLUMNS}, shot_elements(elements(id, name, type, status, reference_image_path))`)
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
  ).then(({ data }) => (data ?? []) as unknown as ShotRow[])
  const frameUrlsPromise = shotsPromise.then((rows) =>
    signStoryboardImages(
      supabase,
      projectId,
      rows.map((row) => row.image_path)
    )
  )
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
  const [
    { data: project, error: projectError },
    shotRows,
    frameUrls,
    elementsResult,
    affordability,
    { data: generation },
    { data: messageRows },
    { data: usageRows },
    { data: creditLedgerRows },
  ] = await Promise.all([
    projectPromise,
    shotsPromise,
    // Each card shows its Storyboard frame: one batched signing call, started as soon as the
    // shots land rather than after every other read.
    frameUrlsPromise,
    // The same grouped-and-signed read the Workbench uses: signed reference thumbnails
    // for the tiles, and the element list behind the picker.
    getProjectElementsForUser(supabase, projectId, user.id),
    getElementGenerateAffordability(projectPromise.then(({ data }) => data ?? null)),
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
      .select(AGENT_MESSAGE_COLUMNS)
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

  // A failed read is an error (the error boundary), never a 404 - only a missing row is.
  if (projectError) {
    throw new Error(`Could not load project ${projectId}: ${projectError.message}`)
  }
  if (!project) {
    notFound()
  }

  // View-gate only: a user whose furthest_step hasn't reached this page yet must not see
  // it. Nothing here locks editing once the project has moved on - Step 3 stays live.
  if (project.furthest_step < stepIndex('image_prompts')) {
    redirect(`/projects/${projectId}/${project.current_step}`)
  }


  const elementGroups: ElementGroup[] = elementsResult.success ? elementsResult.groups : []
  const elementsExpiresAt = elementsResult.success ? elementsResult.expires_at : new Date().toISOString()
  if (!elementsResult.success) {
    console.error(`[image-prompts] Failed to load elements for project ${projectId}:`, elementsResult.error)
  }

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
    frame: (() => {
      const url = storyboardThumbUrl(frameUrls, row.image_path)
      return url ? { url, stale: row.image_stale } : null
    })(),
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

  // A frame's price for each possible reference count (up to every element in the project),
  // so the Continue modal stays exact as bindings change on this page.
  const elementCount = elementGroups.reduce((n, group) => n + group.elements.length, 0)
  const frameCreditsByReferenceCount = Array.from({ length: elementCount + 1 }, (_, referenceCount) =>
    creditsFor({
      step: 'storyboard',
      operation: 'generate_image',
      quantity: 1,
      image: storyboardImagePriceKey({ aspectRatio, imageModel: project.image_model, imageQuality: project.image_quality, referenceCount }),
    })
  )

  // First arrival with nothing ever attempted generates once - but only if the balance
  // covers it. Decided here, on the server, so the page never renders a "writing" state
  // for a run that would be refused; a short balance shows the banner instead.
  const generationState = generation?.state ?? null
  let autoGenerate = shouldAutoGenerate({ generationState, shots: promptShots })
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
      frameCreditsByReferenceCount={frameCreditsByReferenceCount}
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
          agentStep="image_prompts"
          agentMessages={agentMessages}
          shots={shots}
          header={<ProjectHeader project={project} shots={shots} />}
          footer={<ImagePromptsFooter furthestStep={project.furthest_step} />}
        >
          <PromptList />
        </WorkbenchShell>
      </AssetsProvider>
    </ImagePromptsProvider>
  )
}
