import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { WorkbenchShell } from '@/components/workbench-shell'
import { ProjectHeader } from '@/components/workbench/project-header'
import { buildAgentMessages } from '@/lib/build-agent-messages'
import { stepIndex } from '@/lib/config/pipeline'

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

  const [{ data: shotsRows }, { data: messageRows }, { data: usageRows }, { data: creditLedgerRows }] =
    await Promise.all([
      supabase
        .from('shots')
        .select('shot_key, order_index, duration_sec, duration_locked')
        .eq('project_id', projectId)
        .order('order_index', { ascending: true }),
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

  const shots = shotsRows ?? []
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
  const readOnly = project.furthest_step >= stepIndex('storyboard')

  return (
    <WorkbenchShell
      project={project}
      agentMessages={agentMessages}
      readOnly={readOnly}
      shots={shots}
      header={<ProjectHeader project={project} shots={shots} />}
    >
      <div className="flex flex-1 items-center justify-center">
        <span className="text-body text-text-tertiary">Image prompts — design pending</span>
      </div>
    </WorkbenchShell>
  )
}
