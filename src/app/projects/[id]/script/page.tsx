import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Rail } from '@/app/dashboard/rail'
import type { Message, Project, Scene } from '../types'
import { ScriptShell } from './_components/script-shell'

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
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
    .select('id, title, status, current_step, created_at')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) {
    notFound()
  }

  const [{ data: scenes }, { data: messages }] = await Promise.all([
    supabase
      .from('scenes')
      .select('id, position, scene_key, voice_over, image_prompt, video_prompt')
      .eq('project_id', projectId)
      .order('position', { ascending: true }),
    supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
  ])

  return (
    <div className="flex h-screen">
      <Rail />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScriptShell
          user={user}
          projectId={project.id}
          initialTitle={(project as Project).title}
          status={(project as Project).status}
          currentStep={(project as Project).current_step}
          initialMessages={(messages ?? []) as Message[]}
          initialScenes={(scenes ?? []) as Scene[]}
        />
      </div>
    </div>
  )
}
