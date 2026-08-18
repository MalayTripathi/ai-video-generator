'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

export async function createProject() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: project, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      title: 'Untitled project',
      status: 'draft',
      current_step: 'script',
    })
    .select('id')
    .single()

  if (error || !project) {
    throw new Error(error?.message ?? 'Failed to create project')
  }

  redirect(`/projects/${project.id}/script`)
}
