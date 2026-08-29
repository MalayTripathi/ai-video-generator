import type { createClient } from '@/lib/supabase/server'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// Tied to the real gateway's 600s SDK timeout plus margin
// (src/lib/claude.ts) - long enough to cover any real Claude call; short
// enough that a crashed or platform-killed request (no `finally` runs)
// self-heals instead of wedging the project's script/prompts step forever.
// Keep the two numbers in sync if either changes.
const STALE_AFTER_MS = 15 * 60 * 1000

export async function acquireGenerationLock(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString()

  const { data, error } = await supabase
    .from('projects')
    .update({ generating_at: new Date().toISOString() })
    .eq('id', projectId)
    .eq('user_id', userId)
    .or(`generating_at.is.null,generating_at.lt.${staleBefore}`)
    .select('id')

  if (error) throw new Error(error.message)
  return (data?.length ?? 0) > 0
}

export async function releaseGenerationLock(supabase: SupabaseServerClient, projectId: string) {
  await supabase.from('projects').update({ generating_at: null }).eq('id', projectId)
}
