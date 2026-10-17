import 'server-only'
import { notFound, redirect } from 'next/navigation'
import type { createClient } from '@/lib/supabase/server'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * A project page whose project row is missing: a project the user deleted redirects to the
 * dashboard; anything else is a 404. Only ever called on the miss path, so a normal page
 * load makes no extra query.
 */
export async function missingProject(supabase: SupabaseServerClient, projectId: string): Promise<never> {
  const { data } = await supabase.from('deleted_projects').select('id').eq('id', projectId).maybeSingle()
  if (data) redirect('/dashboard')
  notFound()
}
