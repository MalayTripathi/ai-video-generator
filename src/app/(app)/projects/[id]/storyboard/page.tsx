import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { WorkbenchShell } from '@/components/workbench-shell'
import { ProjectHeader } from '@/components/workbench/project-header'
import { loadAgentMessages } from '@/lib/load-agent-messages'
import { stepIndex } from '@/lib/config/pipeline'
import { StoryboardPlaceholder } from './_components/storyboard-placeholder'
import { StoryboardFooter } from './_components/storyboard-footer'

// Step 4 placeholder: the shell, header, agent panel and footer are the real ones; the
// content area is an empty state until the storyboard itself is built. Nothing here reads
// or generates storyboard data.
export default async function StoryboardPage({ params }: { params: Promise<{ id: string }> }) {
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

  // View-gate, not an edit-lock: a project whose furthest_step hasn't reached the
  // storyboard yet must not see it - same rule as Step 3's own page.
  if (project.furthest_step < stepIndex('storyboard')) {
    redirect(`/projects/${projectId}/${project.current_step}`)
  }

  const { data: shotsRows } = await supabase
    .from('shots')
    .select('shot_key, order_index, duration_sec, duration_locked')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })
  const shots = shotsRows ?? []

  const agentMessages = await loadAgentMessages(supabase, projectId, shots)

  // Edit-lock: closes once the next step has started, mirroring how Step 3 closes at the
  // storyboard.
  const readOnly = project.furthest_step >= stepIndex('video_prompts')

  return (
    <WorkbenchShell
      project={project}
      agentStep="storyboard"
      agentMessages={agentMessages}
      readOnly={readOnly}
      shots={shots}
      header={<ProjectHeader project={project} shots={shots} />}
      footer={<StoryboardFooter />}
    >
      <StoryboardPlaceholder />
    </WorkbenchShell>
  )
}
