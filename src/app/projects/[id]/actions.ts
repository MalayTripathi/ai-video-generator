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
