import type { createClient } from '@/lib/supabase/server'
import type { Json, Tables } from '@/lib/database.types'
import type { Step, Operation } from '@/lib/config/pipeline'
import { isUniqueViolation } from '@/lib/shot-key'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type GenerationRow = Tables<'generations'>

// Tied to the real gateway's 600s SDK timeout plus margin (src/lib/claude.ts) - long
// enough to cover any real Claude call; short enough that a crashed or
// platform-killed request (no `finally` runs) self-heals instead of wedging a claim
// forever. This is the one locking mechanism in the codebase - both /shots and
// /prompts claim through claimGeneration.
export const STALE_AFTER_MS = 15 * 60 * 1000

export type GenerationIdentity = {
  projectId: string
  step: Step
  operation: Operation
  shotId: string | null
}

export type BlockedReason = 'already_ready' | 'already_generating' | 'retry_required'

export type ClaimResult =
  | { outcome: 'claimed'; generation: GenerationRow }
  | { outcome: 'blocked'; reason: BlockedReason }
  | { outcome: 'error'; message: string }

/**
 * Reclaims an existing row via a CONDITIONAL UPDATE filtered on the state it expects
 * (plus a staleness bound for a 'generating' reclaim). Zero rows affected means
 * another caller reclaimed first - faithful to the old single-statement-atomic claim,
 * where any race loser's informational re-read would by then see 'generating' (the
 * winner's write) regardless of which state it raced from, so every zero-rows case
 * here collapses to the same 'already_generating' reason. `payload` is deliberately
 * left untouched: a stale/failed row may already carry a payload Claude was paid for,
 * and RECOVER must still see it.
 */
async function reclaim(
  supabase: SupabaseServerClient,
  existing: GenerationRow,
  opts: { expectedState: string; staleBefore?: string }
): Promise<ClaimResult> {
  const now = new Date().toISOString()
  const base = supabase
    .from('generations')
    .update({ state: 'generating', started_at: now, updated_at: now })
    .eq('id', existing.id)
    .eq('state', opts.expectedState)

  const { data, error } = await (opts.staleBefore ? base.lt('started_at', opts.staleBefore) : base).select('*')

  if (error) {
    return { outcome: 'error', message: error.message }
  }
  if (!data || data.length === 0) {
    return { outcome: 'blocked', reason: 'already_generating' }
  }
  return { outcome: 'claimed', generation: data[0] }
}

/**
 * Insert-to-claim: a row's mere existence at (project_id, step, operation, shot_id)
 * IS the lock. A plain INSERT claims an identity with no prior attempt outright; a
 * 23505 unique violation (detected by Postgres error code, never by string-matching
 * the message - see isUniqueViolation) means a row already exists, and the branch
 * below reproduces the old atomic-UPDATE's exact state-machine semantics against it.
 */
export async function claimGeneration(params: {
  supabase: SupabaseServerClient
  identity: GenerationIdentity
  retry: boolean
}): Promise<ClaimResult> {
  const { supabase, identity, retry } = params
  const { projectId, step, operation, shotId } = identity
  const now = new Date().toISOString()

  const { data: inserted, error: insertError } = await supabase
    .from('generations')
    .insert({
      project_id: projectId,
      step,
      operation,
      shot_id: shotId,
      state: 'generating',
      payload: null,
      started_at: now,
      updated_at: now,
    })
    .select('*')
    .single()

  if (!insertError) {
    return { outcome: 'claimed', generation: inserted }
  }

  if (!isUniqueViolation(insertError)) {
    return { outcome: 'error', message: insertError.message }
  }

  const identityQuery = supabase
    .from('generations')
    .select('*')
    .eq('project_id', projectId)
    .eq('step', step)
    .eq('operation', operation)

  const { data: existing, error: selectError } = await (
    shotId === null ? identityQuery.is('shot_id', null) : identityQuery.eq('shot_id', shotId)
  ).maybeSingle()

  if (selectError || !existing) {
    return { outcome: 'error', message: selectError?.message ?? 'Generation row not found after unique violation' }
  }

  // 'succeeded' is the one place the old ready -> succeeded rename is decided (the
  // mirror write happens in settleGeneration's success branch below).
  if (existing.state === 'succeeded') {
    return { outcome: 'blocked', reason: 'already_ready' }
  }

  if (existing.state === 'failed' && !retry) {
    return { outcome: 'blocked', reason: 'retry_required' }
  }

  if (existing.state === 'generating') {
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString()
    if (existing.started_at === null || existing.started_at >= staleBefore) {
      return { outcome: 'blocked', reason: 'already_generating' }
    }
    return reclaim(supabase, existing, { expectedState: 'generating', staleBefore })
  }

  if (existing.state === 'failed') {
    // retry === true here (the !retry case returned above).
    return reclaim(supabase, existing, { expectedState: 'failed' })
  }

  // 'pending' - only reachable via a historical backfilled row for a project that was
  // never attempted. Always reclaimable, no staleness check (nothing was ever
  // claimed), matching the old shots_generation.eq.pending OR-branch.
  return reclaim(supabase, existing, { expectedState: 'pending' })
}

export async function persistGenerationPayload(
  supabase: SupabaseServerClient,
  generationId: string,
  payload: Json
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('generations')
    .update({ payload, updated_at: new Date().toISOString() })
    .eq('id', generationId)

  return { error: error?.message ?? null }
}

export async function settleGeneration(
  supabase: SupabaseServerClient,
  generationId: string,
  params: { success: boolean; error?: string | null; clearPayload?: boolean }
): Promise<{ error: string | null }> {
  const update: {
    state: string
    error: string | null
    updated_at: string
    payload?: null
  } = {
    state: params.success ? 'succeeded' : 'failed',
    error: params.success ? null : (params.error ?? null),
    updated_at: new Date().toISOString(),
  }
  // Success always clears the payload unconditionally - it was only ever a recovery
  // aid for an in-flight or failed attempt. A failure only clears it when the caller
  // says so (the max_tokens truncation case): otherwise it must survive for RECOVER.
  if (params.success || params.clearPayload) update.payload = null

  const { error } = await supabase.from('generations').update(update).eq('id', generationId)
  return { error: error?.message ?? null }
}
