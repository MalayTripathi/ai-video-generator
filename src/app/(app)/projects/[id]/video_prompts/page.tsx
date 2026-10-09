import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { WorkbenchShell } from '@/components/workbench-shell'
import { ProjectHeader } from '@/components/workbench/project-header'
import { loadAgentMessages } from '@/lib/load-agent-messages'
import { stepIndex } from '@/lib/config/pipeline'
import { ASPECT_RATIOS, type AspectRatio } from '@/lib/config/enums'
import { VideoPromptsSkeleton } from './_components/video-prompts-skeleton'
import { VideoPromptsFooter } from './_components/video-prompts-footer'

// Step 5: the shared shell with a placeholder render area until video-prompt generation is
// built. Reads only what the shell needs - the project (header, step indicator, view-gate),
// the shots (header durations, agent turn numbering) and the agent history - in one wave.
export default async function VideoPromptsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  // A real Promise (not the query builder), so the header and the agent history share one
  // execution. The child reads are RLS-scoped to the owner, so they run beside the project
  // read and the gate is applied once they land.
  const shotsPromise = Promise.resolve(
    supabase
      .from('shots')
      .select('shot_key, order_index, duration_sec, duration_locked')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
  ).then(({ data }) => data ?? [])
  const [{ data: project, error: projectError }, shots, agentMessages] = await Promise.all([
    supabase
      .from('projects')
      .select('id, title, source_text, current_step, furthest_step, video_type, aspect_ratio, language, video_model, video_resolution, image_quality, quality_preset, duration_target')
      .eq('id', projectId)
      .eq('user_id', user.id)
      .maybeSingle(),
    shotsPromise,
    loadAgentMessages(supabase, projectId, shotsPromise),
  ])

  // A failed read is an error (the error boundary), never a 404 - only a missing row is.
  if (projectError) {
    throw new Error(`Could not load project ${projectId}: ${projectError.message}`)
  }
  if (!project) {
    notFound()
  }

  // View-gate only: a project that hasn't reached Video Prompts must not see it.
  if (project.furthest_step < stepIndex('video_prompts')) {
    redirect(`/projects/${projectId}/${project.current_step}`)
  }

  const aspectRatio: AspectRatio = (ASPECT_RATIOS as readonly string[]).includes(project.aspect_ratio)
    ? (project.aspect_ratio as AspectRatio)
    : '9:16'

  return (
    <WorkbenchShell
      project={project}
      agentStep="video_prompts"
      agentMessages={agentMessages}
      shots={shots}
      header={<ProjectHeader project={project} shots={shots} />}
      footer={<VideoPromptsFooter />}
    >
      <VideoPromptsSkeleton aspectRatio={aspectRatio} />
    </WorkbenchShell>
  )
}
