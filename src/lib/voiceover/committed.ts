import type { createClient } from '@/lib/supabase/server'
import { isLiveClaim } from '@/lib/generations/claim'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

const AUDIO_OPERATIONS = ['voiceover', 'align_voiceover', 'background_music'] as const

/**
 * Credits the user has already committed to audio that hasn't settled, across every
 * project: each live voiceover / alignment / music claim's price, which its request stored
 * in the claim's payload. Subtracted from the balance by every storyboard spend gate, so a
 * voiceover, a music run and an image batch (or two tabs) can't spend the same credits twice.
 */
export async function liveAudioCommittedCredits(supabase: SupabaseServerClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('generations')
    .select('operation, state, started_at, queued_at, payload, projects!inner(user_id)')
    .eq('projects.user_id', userId)
    .eq('step', 'storyboard')
    .in('operation', AUDIO_OPERATIONS)
    .eq('state', 'generating')
  if (error) throw new Error(`liveAudioCommittedCredits failed: ${error.message}`)
  const now = Date.now()
  return (data ?? []).reduce((sum, row) => {
    const operation = row.operation as (typeof AUDIO_OPERATIONS)[number]
    if (!isLiveClaim(row, operation, now)) return sum
    const credits = (row.payload as { credits?: unknown } | null)?.credits
    return sum + (typeof credits === 'number' && credits > 0 ? credits : 0)
  }, 0)
}
