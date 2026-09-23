import type { createClient } from '@/lib/supabase/server'
import type { Json, Tables } from '@/lib/database.types'
import type { Step, Operation } from '@/lib/config/pipeline'
import { isUniqueViolation } from '@/lib/shot-key'
import { getOperationPolicy } from '@/lib/generations/operation-policy'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type GenerationRow = Tables<'generations'>

export type GenerationIdentity = {
  projectId: string
  step: Step
  operation: Operation
  shotId: string | null
  elementId: string | null
}

export type BlockedReason = 'already_ready' | 'already_generating' | 'retry_required'

export type ClaimResult =
  | { outcome: 'claimed'; generation: GenerationRow }
  | { outcome: 'blocked'; reason: BlockedReason }
  | { outcome: 'error'; message: string }

type ClaimTiming = Pick<GenerationRow, 'state' | 'started_at' | 'queued_at'>

/**
 * Whether a row belongs to a run that is still going: 'generating' and younger than its
 * window. A queued row (queued_at set - waiting behind a pool, not yet started) ages
 * against the policy's queuedStaleAfterMs from queued_at; a started row against
 * staleAfterMs from started_at. The one staleness rule for the claim, the peek, the
 * storyboard gate's in-flight count and the image status display.
 */
export function isLiveClaim(row: ClaimTiming, operation: Operation, now: number = Date.now()): boolean {
  if (row.state !== 'generating') return false
  const policy = getOperationPolicy(operation)
  if (row.queued_at !== null) {
    const window = policy.queuedStaleAfterMs ?? policy.staleAfterMs
    return new Date(row.queued_at).getTime() > now - window
  }
  if (row.started_at === null) return true
  return new Date(row.started_at).getTime() > now - policy.staleAfterMs
}

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
  opts: { expectedState: string; queued: boolean; staleGuard?: boolean }
): Promise<ClaimResult> {
  const now = new Date().toISOString()
  const base = supabase
    .from('generations')
    .update({ state: 'generating', started_at: now, queued_at: opts.queued ? now : null, updated_at: now })
    .eq('id', existing.id)
    .eq('state', opts.expectedState)

  // A stale 'generating' reclaim is additionally filtered on the exact timestamps it
  // judged stale, so a row that was re-stamped in the meantime (a worker starting it, or
  // another reclaim) is refused rather than stolen.
  const withStarted =
    opts.staleGuard && existing.started_at !== null ? base.eq('started_at', existing.started_at) : base
  const guarded =
    opts.staleGuard
      ? existing.queued_at === null
        ? withStarted.is('queued_at', null)
        : withStarted.eq('queued_at', existing.queued_at)
      : withStarted

  const { data, error } = await guarded.select('*')

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
  /** true only for a claim that will wait behind a pool before its work starts (storyboard
   * images) - it stamps queued_at, which markGenerationStarted clears. Required, never
   * defaulted, so a new caller has to decide. */
  queued: boolean
}): Promise<ClaimResult> {
  const { supabase, identity, retry, queued } = params
  const { projectId, step, operation, shotId, elementId } = identity
  const now = new Date().toISOString()

  const { data: inserted, error: insertError } = await supabase
    .from('generations')
    .insert({
      project_id: projectId,
      step,
      operation,
      shot_id: shotId,
      element_id: elementId,
      state: 'generating',
      payload: null,
      started_at: now,
      queued_at: queued ? now : null,
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

  const withShot = shotId === null ? identityQuery.is('shot_id', null) : identityQuery.eq('shot_id', shotId)
  const { data: existing, error: selectError } = await (
    elementId === null ? withShot.is('element_id', null) : withShot.eq('element_id', elementId)
  ).maybeSingle()

  if (selectError || !existing) {
    return { outcome: 'error', message: selectError?.message ?? 'Generation row not found after unique violation' }
  }

  const policy = getOperationPolicy(operation)

  // 'succeeded' is the one place the old ready -> succeeded rename is decided (the
  // mirror write happens in settleGeneration's success branch below). Most operations
  // never reclaim from here ('never'); generate_shots allows it behind the same retry
  // flag as 'failed' (regenerate-all); agent_turn allows it unconditionally (a mutex has
  // no "job" to protect from re-attempt).
  if (existing.state === 'succeeded') {
    if (policy.claimableFrom.succeeded === 'never') {
      return { outcome: 'blocked', reason: 'already_ready' }
    }
    if (policy.claimableFrom.succeeded === 'retry' && !retry) {
      return { outcome: 'blocked', reason: 'retry_required' }
    }
    return reclaim(supabase, existing, { expectedState: 'succeeded', queued })
  }

  if (existing.state === 'failed' && policy.claimableFrom.failed === 'retry' && !retry) {
    return { outcome: 'blocked', reason: 'retry_required' }
  }

  if (existing.state === 'generating') {
    if (isLiveClaim(existing, operation)) {
      return { outcome: 'blocked', reason: 'already_generating' }
    }
    return reclaim(supabase, existing, { expectedState: 'generating', queued, staleGuard: true })
  }

  if (existing.state === 'failed') {
    // Either retry === true, or policy.claimableFrom.failed === 'always' (the !retry
    // case for a 'retry' policy already returned above).
    return reclaim(supabase, existing, { expectedState: 'failed', queued })
  }

  // 'pending' - only reachable via a historical backfilled row for a project that was
  // never attempted. Always reclaimable, no staleness check (nothing was ever
  // claimed), matching the old shots_generation.eq.pending OR-branch.
  return reclaim(supabase, existing, { expectedState: 'pending', queued })
}

/**
 * Read-only look at an identity's stored payload, with no claim and no write. It lets a
 * caller decide BEFORE claiming whether a request would be answered by RECOVER (nothing
 * new spent) - the one fact a pre-claim balance gate needs. It is not a lock: the claim
 * still re-decides authoritatively, and a caller that acted on a stale peek must
 * re-check once it holds the claim.
 */
export async function peekGenerationPayload(
  supabase: SupabaseServerClient,
  identity: GenerationIdentity
): Promise<{ payload: Json | null; heldByLiveRun: boolean; error: string | null }> {
  const { projectId, step, operation, shotId, elementId } = identity
  const base = supabase
    .from('generations')
    .select('payload, state, started_at, queued_at')
    .eq('project_id', projectId)
    .eq('step', step)
    .eq('operation', operation)
  const withShot = shotId === null ? base.is('shot_id', null) : base.eq('shot_id', shotId)
  const { data, error } = await (
    elementId === null ? withShot.is('element_id', null) : withShot.eq('element_id', elementId)
  ).maybeSingle()

  if (error) return { payload: null, heldByLiveRun: false, error: error.message }

  // The same test the claim applies: a 'generating' row younger than the operation's stale
  // window belongs to a run that is still going (its payload is saved a moment before its
  // writes finish, so it is present but not "unapplied" - the run is about to apply it).
  // The claim will refuse a request against it; a caller acting on the payload before the
  // claim must not answer as though nobody holds the slot.
  const heldByLiveRun = data ? isLiveClaim(data, operation) : false
  return { payload: data?.payload ?? null, heldByLiveRun, error: null }
}

/**
 * A queued claim's work is starting: clears queued_at and re-stamps started_at, so from
 * here it ages against the per-call window. Conditional on the row still being exactly the
 * queued claim the caller was handed - false means someone else owns it now (a stale
 * reclaim, or an earlier run already started it) and the caller must not touch it.
 */
export async function markGenerationStarted(
  supabase: SupabaseServerClient,
  generationId: string,
  expectedQueuedAt: string
): Promise<{ started: boolean; generation: GenerationRow | null; error: string | null }> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('generations')
    .update({ queued_at: null, started_at: now, updated_at: now })
    .eq('id', generationId)
    .eq('state', 'generating')
    .eq('queued_at', expectedQueuedAt)
    .select('*')

  if (error) return { started: false, generation: null, error: error.message }
  if (!data || data.length === 0) return { started: false, generation: null, error: null }
  return { started: true, generation: data[0], error: null }
}

/**
 * The still-queued claims among `generationIds`, scoped to one project and one
 * (step, operation). Read-only - used to validate a continuation run's hand-off, which
 * resumes existing claims and never claims anything itself.
 */
export async function listQueuedGenerations(
  supabase: SupabaseServerClient,
  params: { projectId: string; step: Step; operation: Operation; generationIds: string[] }
): Promise<{ generations: GenerationRow[]; error: string | null }> {
  if (params.generationIds.length === 0) return { generations: [], error: null }
  const { data, error } = await supabase
    .from('generations')
    .select('*')
    .eq('project_id', params.projectId)
    .eq('step', params.step)
    .eq('operation', params.operation)
    .eq('state', 'generating')
    .not('queued_at', 'is', null)
    .in('id', params.generationIds)

  if (error) return { generations: [], error: error.message }
  return { generations: data ?? [], error: null }
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
    queued_at: null
    updated_at: string
    payload?: null
  } = {
    state: params.success ? 'succeeded' : 'failed',
    queued_at: null,
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
