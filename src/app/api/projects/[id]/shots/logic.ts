import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
// Type-only, for the same reason as every other paid route's logic.ts: credits/* import the
// service-role client (server-only); the route injects the real functions.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import { creditsFor } from '@/lib/config/credits'
import { durationConfig, parseDurationTarget } from '@/lib/config/duration'
import { isRegisteredVideoModel, VIDEO_MODELS, videoModelBounds } from '@/lib/config/models'
import { claimGeneration, settleGeneration, type BlockedReason } from '@/lib/generations/claim'
import { shotCeiling } from '@/lib/shots/limits'
import { hasLiveShotRun, settleDeadShotRuns, type ShotRunLedger } from '@/lib/shots/runs'

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

/** The credits shot generation holds back before it starts - 2 per shot, at `shots`. */
export function shotCredits(shots: number): number {
  return creditsFor({ step: 'workbench', operation: 'generate_shots', quantity: shots })
}

/** Scenes no run has finished - what "Generate remaining shots" writes. */
async function unwrittenSceneCount(supabase: Client, projectId: string): Promise<{ total: number; unwritten: number; error: string | null }> {
  const { data, error } = await supabase
    .from('scenes')
    .select('id, shot_run_chunks(scene_complete)')
    .eq('project_id', projectId)
  if (error) return { total: 0, unwritten: 0, error: error.message }
  const scenes = (data ?? []) as { id: string; shot_run_chunks: { scene_complete: boolean }[] }[]
  const unwritten = scenes.filter((s) => !s.shot_run_chunks.some((c) => c.scene_complete)).length
  return { total: scenes.length, unwritten, error: null }
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

  // A dead chain is settled on the first touch after its stale window, before this request
  // is judged against it.
  await settleDeadShotRuns(supabase, ledger, projectId)
  try {
    if (await hasLiveShotRun(supabase, projectId)) {
      return { ok: false, status: 409, error: BLOCKED_REASON_MESSAGES.already_generating, reason: 'already_generating' }
    }
  } catch {
    return { ok: false, status: 500, error: 'Could not check for a running generation' }
  }

  const tier = durationConfig[parseDurationTarget(project.duration_target)]
  let totalScenes: number | null = null
  let heldShots = tier.targetShots
  if (mode === 'remaining') {
    const scenes = await unwrittenSceneCount(supabase, projectId)
    if (scenes.error) return { ok: false, status: 500, error: scenes.error }
    if (scenes.unwritten === 0) {
      return { ok: false, status: 409, error: 'Every scene already has its shots.', reason: 'nothing_remaining' }
    }
    totalScenes = scenes.total
    const ceiling = shotCeiling(tier.targetSecondsMax, videoModelBounds(VIDEO_MODELS[project.video_model]).min)
    heldShots = Math.min(tier.targetShots, ceiling)
  }

  // Pre-flight: before any claim or provider call, so a refusal writes nothing. Charging is
  // on shots actually saved; this only holds back the tier's target.
  const requiredCredits = shotCredits(heldShots)
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

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: 'workbench', operation: 'generate_shots', shotId: null, elementId: null },
    retry: mode === 'remaining' ? true : params.retry,
    queued: false,
  })
  if (claim.outcome === 'error') return { ok: false, status: 500, error: claim.message }
  if (claim.outcome === 'blocked') {
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
    return { ok: false, status: 500, error: runError?.message ?? 'Could not start the run' }
  }
  return { ok: true, status: 202, runId: run.id }
}
