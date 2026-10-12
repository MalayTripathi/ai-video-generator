import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
// Type-only, for the same reason as every other paid route's logic.ts: credits/* import the
// service-role client (server-only); the route injects the real functions.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import { InsufficientCreditsError, remainingShotQuoteCredits, shotGenerationCredits } from '@/lib/config/credits'
import { isRegisteredVideoModel } from '@/lib/config/models'
import { claimGeneration, settleGeneration, type BlockedReason } from '@/lib/generations/claim'
import { sceneProgress, type SceneProgress } from '@/app/(app)/projects/[id]/workbench/_components/shot-run-view'
import { anyDeadShotRun, isLiveShotRun, readOpenShotRuns, settleDeadShotRuns, type ShotRunLedger } from '@/lib/shots/runs'

type Client = SupabaseClient<Database>

// Passed as `recordFixedSpend` by a caller whose nested call is already billed inside an
// enclosing agent turn's dynamic agent_turn charge (the Step 3 regeneration tools).
// attemptId/recordFixedSpend are required (not optional) so a caller can never simply
// forget to wire billing and have it silently no-op; this sentinel is an explicit,
// greppable opt-out.
export const BILLED_BY_TURN = Symbol('generate_shots:billed_by_turn')

// ---------------------------------------------------------------------------------------
// Request: gate -> claim -> run record. Runs with the caller's own client before anything
// is scheduled; nothing here calls a provider. The chain itself is worker.ts.
// ---------------------------------------------------------------------------------------

export type ShotsRequestMode =
  /** Generate shots: an outline, then every scene. Replaces the project's shots. */
  | 'generate'
  /** Generate remaining shots: only the scenes a stopped run left unwritten. */
  | 'remaining'

export type ShotsRequestResult =
  | { ok: true; status: 202; runId: string }
  | { ok: false; status: 404 | 422 | 500; error: string }
  | { ok: false; status: 409; error: string; reason: BlockedReason | 'nothing_remaining' }
  | { ok: false; status: 402; error: string; requiredCredits: number; balanceCredits: number }

const BLOCKED_REASON_MESSAGES: Record<BlockedReason, string> = {
  already_ready: 'Shots have already been generated for this project.',
  already_generating: 'A generation is already in progress for this project.',
  retry_required: 'The last generation failed. Retry to try again.',
}

/** Scenes no run has finished - what "Generate remaining shots" writes, and their seconds. */
async function unwrittenScenes(supabase: Client, projectId: string): Promise<{ total: number; unwritten: SceneProgress[]; error: string | null }> {
  const { data, error } = await supabase
    .from('scenes')
    .select('target_seconds, shot_run_chunks(scene_complete), shots(duration_sec)')
    .eq('project_id', projectId)
  if (error) return { total: 0, unwritten: [], error: error.message }
  const scenes = (data ?? []).map((row) => sceneProgress(row as unknown as Parameters<typeof sceneProgress>[0]))
  return { total: scenes.length, unwritten: scenes.filter((s) => !s.complete), error: null }
}

export async function runShotsRequest(params: {
  supabase: Client
  projectId: string
  userId: string
  mode: ShotsRequestMode
  /** Reclaim a settled or failed claim (a retry, or regenerate). Ignored for 'remaining'. */
  retry: boolean
  attemptId: string
  /** The agent turn's message and its agent_turn claim, when the agent starts the run. */
  messageId?: string | null
  agentGenerationId?: string | null
  getBalance: typeof getBalanceType
  ensureSignupGrant: typeof ensureSignupGrantType
  ledger: ShotRunLedger
}): Promise<ShotsRequestResult> {
  const { supabase, projectId, userId, mode, attemptId, getBalance, ensureSignupGrant, ledger } = params

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, duration_target, video_model')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  // A failed read is a server error, never a 404 - only a missing row is.
  if (projectError) return { ok: false, status: 500, error: 'Could not load project' }
  if (!project) return { ok: false, status: 404, error: 'Project not found' }
  if (!isRegisteredVideoModel(project.video_model)) {
    return { ok: false, status: 422, error: "This project's video model isn't available, so shot lengths can't be set." }
  }

  // One read of the project's open runs: whether one is live (409), and whether a dead one
  // needs settling first - only then is anything more done.
  const open = await readOpenShotRuns(supabase, projectId)
  if (open.error) return { ok: false, status: 500, error: 'Could not check for a running generation' }
  if (anyDeadShotRun(open.runs)) await settleDeadShotRuns(supabase, ledger, projectId, open.runs)
  if (open.runs.some((run) => isLiveShotRun(run))) {
    return { ok: false, status: 409, error: BLOCKED_REASON_MESSAGES.already_generating, reason: 'already_generating' }
  }

  let totalScenes: number | null = null
  let requiredCredits = shotGenerationCredits(project.duration_target)
  if (mode === 'remaining') {
    const scenes = await unwrittenScenes(supabase, projectId)
    if (scenes.error) return { ok: false, status: 500, error: scenes.error }
    if (scenes.unwritten.length === 0) {
      return { ok: false, status: 409, error: 'Every scene already has its shots.', reason: 'nothing_remaining' }
    }
    totalScenes = scenes.total
    requiredCredits = remainingShotQuoteCredits(project.duration_target, scenes.unwritten)
  }

  // The quote is held before any claim or provider call. A cheap check first, so a plain
  // shortfall writes nothing; then the hold itself, atomic with its own balance check
  // (placeHold), which also refuses a start that lost a race for the same credits. The
  // balance read releases any dead run's hold first (getBalance), for any of the user's
  // projects.
  let balanceCredits: number
  try {
    await ensureSignupGrant(userId)
    balanceCredits = await getBalance(userId)
  } catch (err) {
    console.error('[shots] balance read failed', err)
    return { ok: false, status: 500, error: 'Could not check your credit balance' }
  }
  if (balanceCredits < requiredCredits) {
    return { ok: false, status: 402, error: 'Not enough credits to write the shot list.', requiredCredits, balanceCredits }
  }
  const agent = params.agentGenerationId != null
  const holdTarget = {
    userId,
    attemptId,
    step: 'workbench' as const,
    operation: agent ? ('agent_turn' as const) : ('generate_shots' as const),
    pricingMode: agent ? ('dynamic' as const) : ('fixed' as const),
    projectId,
    messageId: params.messageId ?? null,
  }
  try {
    await ledger.placeHold({ ...holdTarget, credits: requiredCredits })
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, status: 402, error: 'Not enough credits to write the shot list.', requiredCredits, balanceCredits: err.balanceCredits }
    }
    // Nothing has been spent yet: the run does not start.
    console.error('[shots] hold write failed', err)
    return { ok: false, status: 500, error: 'Could not hold the credits for this shot list' }
  }
  // Past this point the hold exists: every refusal below releases it in full.
  const releaseHold = () => ledger.settleHold({ ...holdTarget, actualCredits: 0 })

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: 'workbench', operation: 'generate_shots', shotId: null, elementId: null },
    retry: mode === 'remaining' ? true : params.retry,
    queued: false,
  })
  if (claim.outcome === 'error') {
    await releaseHold()
    return { ok: false, status: 500, error: claim.message }
  }
  if (claim.outcome === 'blocked') {
    await releaseHold()
    return { ok: false, status: 409, error: BLOCKED_REASON_MESSAGES[claim.reason], reason: claim.reason }
  }

  const now = new Date().toISOString()
  const { data: run, error: runError } = await supabase
    .from('shot_runs')
    .insert({
      project_id: projectId,
      attempt_id: attemptId,
      kind: mode,
      status: 'running',
      stop_reason: null,
      generation_id: claim.generation.id,
      message_id: params.messageId ?? null,
      agent_generation_id: params.agentGenerationId ?? null,
      total_scenes: totalScenes,
      heartbeat_at: now,
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single()
  if (runError || !run) {
    await settleGeneration(supabase, claim.generation.id, { success: false, error: 'Could not start the run' })
    await releaseHold()
    return { ok: false, status: 500, error: runError?.message ?? 'Could not start the run' }
  }
  return { ok: true, status: 202, runId: run.id }
}
