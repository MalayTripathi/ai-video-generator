'use server'

import { createClient } from '@/lib/supabase/server'

export async function updateProjectTitle(projectId: string, title: string) {
  const trimmed = title.trim()
  if (!trimmed) return

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return

  await supabase
    .from('projects')
    .update({ title: trimmed })
    .eq('id', projectId)
    .eq('user_id', user.id)
}

export async function updateSceneVoiceOver(projectId: string, sceneId: string, voiceOver: string) {
  const trimmed = voiceOver.trim()
  if (!trimmed) throw new Error('Voice-over cannot be empty')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) throw new Error('Not authenticated')

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) throw new Error('Project not found')

  const { error } = await supabase
    .from('scenes')
    .update({ voice_over: trimmed, image_prompt: null, video_prompt: null })
    .eq('id', sceneId)
    .eq('project_id', projectId)

  if (error) throw new Error(error.message)
}
