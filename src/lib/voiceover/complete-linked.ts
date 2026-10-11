import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
// Type-only: credits/ledger.ts imports the service-role client (server-only); every caller
// injects the real writer.
import type { recordFixedSpend as recordFixedSpendType } from '@/lib/credits/ledger'
import { isLiveClaim, settleGeneration } from '@/lib/generations/claim'

// A read (generated or uploaded) is linked to the project before its claim is settled and
// charged. An invocation killed between the two leaves linked audio under a claim still
// 'generating'. Once that claim is past its stale window, the next read of it - the
// Storyboard's status, a voiceover or upload request - completes it: settled succeeded and
// charged once (the ledger's attempt-id dedupe makes a repeat a no-op). Never sooner: a
// worker inside its window may still be settling it itself.

type Client = SupabaseClient<Database>

export type VoiceoverClaimForCompletion = {
  id: string
  operation: string
  state: string
  started_at: string | null
  queued_at: string | null
  payload: unknown
}

type Linked = { row: VoiceoverClaimForCompletion; operation: 'voiceover' | 'align_voiceover'; attemptId: string; quantity: number }

/** The claims among `rows` whose read is the project's linked audio but never settled. */
export function linkedUnsettledVoiceoverClaims(
  rows: readonly VoiceoverClaimForCompletion[],
  audioPath: string | null,
  now: number = Date.now()
): Linked[] {
  if (!audioPath) return []
  return rows.flatMap((row): Linked[] => {
    if (row.operation !== 'voiceover' && row.operation !== 'align_voiceover') return []
    if (row.state !== 'generating' || isLiveClaim(row, row.operation, now)) return []
    const p = (row.payload ?? {}) as Record<string, unknown>
    if (typeof p.attemptId !== 'string') return []
    if (row.operation === 'voiceover' && p.kind === 'generate' && typeof p.chars === 'number' && audioPath.endsWith(`/${p.attemptId}.mp3`)) {
      return [{ row, operation: 'voiceover', attemptId: p.attemptId, quantity: p.chars }]
    }
    if (row.operation === 'align_voiceover' && p.kind === 'align' && typeof p.durationSec === 'number' && p.uploadPath === audioPath) {
      return [{ row, operation: 'align_voiceover', attemptId: p.attemptId, quantity: p.durationSec }]
    }
    return []
  })
}

/** Settles and charges each linked-but-unsettled claim. Returns the ids it completed. */
export async function completeLinkedVoiceover(params: {
  supabase: Client
  userId: string
  projectId: string
  rows: readonly VoiceoverClaimForCompletion[]
  audioPath: string | null
  recordFixedSpend: typeof recordFixedSpendType
}): Promise<string[]> {
  const done: string[] = []
  for (const linked of linkedUnsettledVoiceoverClaims(params.rows, params.audioPath)) {
    console.warn(`[voiceover] completing claim ${linked.row.id}: its read is linked but it was never settled`)
    const { error } = await settleGeneration(params.supabase, linked.row.id, { success: true })
    if (error) {
      console.error(`[voiceover] could not settle claim ${linked.row.id}`, error)
      continue
    }
    try {
      await params.recordFixedSpend({
        userId: params.userId,
        step: 'storyboard',
        operation: linked.operation,
        quantity: linked.quantity,
        attemptId: linked.attemptId,
        projectId: params.projectId,
        messageId: null,
      })
    } catch (err) {
      console.error(`[voiceover] ledger write failed completing claim ${linked.row.id}`, err)
    }
    done.push(linked.row.id)
  }
  return done
}

/** Reads the project's voiceover claims and audio, then completes any linked-but-unsettled one. */
export async function completeLinkedVoiceoverForProject(params: {
  supabase: Client
  userId: string
  projectId: string
  recordFixedSpend: typeof recordFixedSpendType
}): Promise<void> {
  const [{ data: rows }, { data: project }] = await Promise.all([
    params.supabase
      .from('generations')
      .select('id, operation, state, started_at, queued_at, payload')
      .eq('project_id', params.projectId)
      .eq('step', 'storyboard')
      .in('operation', ['voiceover', 'align_voiceover']),
    params.supabase.from('projects').select('audio_path').eq('id', params.projectId).maybeSingle(),
  ])
  await completeLinkedVoiceover({ ...params, rows: rows ?? [], audioPath: project?.audio_path ?? null })
}
