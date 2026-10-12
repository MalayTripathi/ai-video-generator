import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Tables } from '@/lib/database.types'
// Type-only: credits/ledger.ts imports the service-role client (server-only). The real
// writers are injected by each caller (route, page, agent turn), the same way every paid
// route's logic.ts takes them.
import type { placeHold, settleHold } from '@/lib/credits/ledger'
import { creditsFor, usdToCredits } from '@/lib/config/credits'
import { refreshGenerationHeartbeat, settleGeneration } from '@/lib/generations/claim'
import { SHOT_RUN_STALE_AFTER_MS, SHOTS_PER_CHUNK } from '@/lib/config/shots'
import { chunkShotOrderIndex, resequence } from './positions'

// The shot-run record: one row per shot-generation user action (Generate shots, Generate
// remaining shots, the agent's regenerate_all_shots) plus one row per chunk. Bookkeeping
// for the self-continuing chain - never the ledger. This module owns the run's terminal
// transitions and its hold's settle (the run's hold is placed at its start, by the shots
// request). Works with either the user's client (RLS) or the service-role client (the
// chain); every query is scoped by project or run id.

type Client = SupabaseClient<Database>
export type ShotRunRow = Tables<'shot_runs'>
export type ShotRunChunkRow = Tables<'shot_run_chunks'>
export type ShotRunStatus = 'running' | 'completed' | 'stopped' | 'failed'
// 'chain_limit' is only on runs from before the progress guard replaced the chain limit.
export type ShotRunStopReason = 'balance' | 'error' | 'chain_limit' | 'stale' | 'ceiling' | 'refused' | 'no_progress' | 'incomplete'

/** The ledger writers a run needs: its hold at start, and that hold's one settle at its end. */
export type ShotRunLedger = {
  placeHold: typeof placeHold
  settleHold: typeof settleHold
}

/**
 * Every column ending a run needs - its claim, its hold's settle and an agent run's lock -
 * read once and passed down, never re-read along the way.
 */
export const SETTLE_RUN_COLUMNS =
  'id, project_id, attempt_id, status, generation_id, total_scenes, created_at, heartbeat_at, finished_at, message_id, agent_generation_id, outline_cost_usd, turn_cost_usd, turn_settled_at, charged_at, projects!inner(user_id), shot_run_chunks(shots_saved, cost_usd)'

export type SettleRunRow = Pick<
  ShotRunRow,
  | 'id'
  | 'project_id'
  | 'attempt_id'
  | 'status'
  | 'generation_id'
  | 'total_scenes'
  | 'created_at'
  | 'heartbeat_at'
  | 'finished_at'
  | 'message_id'
  | 'agent_generation_id'
  | 'outline_cost_usd'
  | 'turn_cost_usd'
  | 'turn_settled_at'
  | 'charged_at'
> & { projects: { user_id: string }; shot_run_chunks: { shots_saved: number; cost_usd: number }[] }

/** A project's runs that are still running or still unsettled - one read, for every gate. */
export async function readOpenShotRuns(supabase: Client, projectId: string): Promise<{ runs: SettleRunRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('shot_runs')
    .select(SETTLE_RUN_COLUMNS)
    .eq('project_id', projectId)
    .or('status.eq.running,charged_at.is.null')
  return { runs: (data ?? []) as unknown as SettleRunRow[], error: error?.message ?? null }
}

/** Whether a run is still going: 'running' and heartbeat younger than the stale window. */
export function isLiveShotRun(run: Pick<ShotRunRow, 'status' | 'heartbeat_at'>, now: number = Date.now()): boolean {
  return run.status === 'running' && new Date(run.heartbeat_at).getTime() > now - SHOT_RUN_STALE_AFTER_MS
}

/**
 * Whether a read of this run should hand it to settleDeadShotRuns: a 'running' run whose
 * heartbeat has aged out, or a terminal run still uncharged whose finish is older than the
 * stale window. Never a run whose worker may still be writing - a page view or a poll must
 * not settle or charge a live run.
 */
export function needsDeadRunSettlement(
  run: Pick<ShotRunRow, 'status' | 'heartbeat_at' | 'finished_at' | 'charged_at'>,
  now: number = Date.now()
): boolean {
  if (run.status === 'running') return !isLiveShotRun(run, now)
  if (run.charged_at !== null) return false
  return run.finished_at !== null && new Date(run.finished_at).getTime() <= now - SHOT_RUN_STALE_AFTER_MS
}

/** An agent run: billed as the turn's single dynamic agent_turn row, after the turn ends. */
export function isAgentShotRun(run: Pick<ShotRunRow, 'agent_generation_id'>): boolean {
  return run.agent_generation_id !== null
}

/** Re-stamps the run's heartbeat and its generate_shots claim, so both read as live. */
export async function heartbeatShotRun(supabase: Client, run: Pick<ShotRunRow, 'id' | 'generation_id'>): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('shot_runs')
    .update({ heartbeat_at: now, updated_at: now })
    .eq('id', run.id)
    .eq('status', 'running')
  if (error) console.error(`[shots] heartbeat failed for run ${run.id}`, error.message)
  if (run.generation_id) {
    const { error: genError } = await refreshGenerationHeartbeat(supabase, run.generation_id)
    if (genError) console.error(`[shots] claim heartbeat failed for run ${run.id}`, genError)
  }
}

/**
 * Re-sequences a project's shots to 0..n-1 in scene order (see positions.ts) as one write:
 * a single upsert keyed on id, so it lands whole or not at all. The order index's unique
 * constraint is deferred to the end of the statement, so the permutation never collides
 * with itself mid-write. Each row carries only its identity columns and order_index -
 * never a field a person may be editing. Re-running it is a no-op once the order is right.
 */
export async function resequenceProjectShots(supabase: Client, projectId: string): Promise<{ error: string | null }> {
  const { data, error } = await supabase
    .from('shots')
    .select('id, order_index, shot_key, scenes(position)')
    .eq('project_id', projectId)
  if (error) return { error: error.message }
  type Row = { id: string; order_index: number; shot_key: string; scenes: { position: number } | null }
  const rows = (data ?? []) as unknown as Row[]
  const moves = resequence(rows.map((r) => ({ id: r.id, order_index: r.order_index, scenePosition: r.scenes?.position ?? null })))
  if (moves.length === 0) return { error: null }
  const keys = new Map(rows.map((r) => [r.id, r.shot_key]))
  const updatedAt = new Date().toISOString()
  const { error: writeError } = await supabase.from('shots').upsert(
    moves.map((move) => ({
      id: move.id,
      project_id: projectId,
      shot_key: keys.get(move.id)!,
      order_index: move.order_index,
      updated_at: updatedAt,
    })),
    { onConflict: 'id', defaultToNull: false }
  )
  return { error: writeError?.message ?? null }
}

/**
 * Deletes the shots a chunk wrote under its provisional positions. A chunk that died
 * mid-write may have left some; its stored payload is replayed later, so they would
 * otherwise appear twice.
 */
export async function deleteChunkProvisionalShots(
  supabase: Client,
  projectId: string,
  scenePosition: number,
  chunkIndex: number
): Promise<{ error: string | null }> {
  const from = chunkShotOrderIndex(scenePosition, chunkIndex, 0)
  const { error } = await supabase
    .from('shots')
    .delete()
    .eq('project_id', projectId)
    .gte('order_index', from)
    .lte('order_index', from + SHOTS_PER_CHUNK - 1)
  return { error: error?.message ?? null }
}

const GENERATION_ERRORS: Record<Exclude<ShotRunStatus, 'running' | 'completed'>, string> = {
  stopped: 'Shot generation stopped: not enough credits to write the remaining scenes.',
  failed: 'Shot generation stopped before every scene was written.',
}

async function readSettleRun(supabase: Client, runId: string): Promise<SettleRunRow | null> {
  const { data, error } = await supabase.from('shot_runs').select(SETTLE_RUN_COLUMNS).eq('id', runId).maybeSingle()
  if (error) console.error(`[shots] could not read run ${runId}`, error.message)
  return (data as unknown as SettleRunRow | null) ?? null
}

/**
 * Ends a run, in an order that makes "terminal" mean every write is done:
 *   1. re-sequence the shots - while the run still reads as running, so nothing settles it
 *      meanwhile (a page view or poll never touches a live run);
 *   2. mark it terminal - the commit point, only if still 'running' (a second finisher is a
 *      no-op);
 *   3. settle the generate_shots claim, then 4. settle its hold (completeFinishedShotRun).
 * A kill before 2 leaves the run 'running' until its stale window, when settleDeadShotRuns
 * finishes it again (the re-sequence is idempotent); a kill after 2 leaves 3-4 for
 * settleDeadShotRuns to redo once the stale window has passed. `afterDeath` is that dead-
 * chain path: it marks the run terminal even if the re-sequence fails, so a run never stays
 * 'running' forever. A caller that already read the run passes it (`run`) - it is never
 * read twice.
 */
export async function finishShotRun(
  supabase: Client,
  ledger: ShotRunLedger,
  runId: string,
  outcome: { status: Exclude<ShotRunStatus, 'running'>; stopReason: ShotRunStopReason | null },
  options: { afterDeath?: boolean; run?: SettleRunRow } = {}
): Promise<{ finished: boolean }> {
  const current = options.run ?? (await readSettleRun(supabase, runId))
  if (!current) return { finished: false }
  if (current.status !== 'running') return { finished: false }

  const { error: seqError } = await resequenceProjectShots(supabase, current.project_id)
  if (seqError) {
    console.error(`[shots] re-sequence failed for run ${runId}`, seqError)
    // Left running: the dead-chain settlement finishes it after the stale window.
    if (!options.afterDeath) return { finished: false }
  }

  const now = new Date().toISOString()
  const { data: rows, error } = await supabase
    .from('shot_runs')
    .update({ status: outcome.status, stop_reason: outcome.stopReason, finished_at: now, updated_at: now })
    .eq('id', runId)
    .eq('status', 'running')
    .select('id, outline_cost_usd, turn_cost_usd, turn_settled_at, shot_run_chunks(shots_saved, cost_usd)')
  if (error) {
    console.error(`[shots] could not finish run ${runId}`, error.message)
    return { finished: false }
  }
  const updated = (rows ?? [])[0] as unknown as Pick<SettleRunRow, 'outline_cost_usd' | 'turn_cost_usd' | 'turn_settled_at' | 'shot_run_chunks'> | undefined
  if (!updated) return { finished: false }

  // The terminal write returns the run's spend as it stands now - every chunk is settled
  // by then - so the settle below needs no further read.
  await completeFinishedShotRun(supabase, ledger, {
    ...current,
    ...updated,
    status: outcome.status,
    stop_reason: outcome.stopReason,
    finished_at: now,
  } as SettleRunRow)
  return { finished: true }
}

/**
 * Steps 3-4 of a run's end, for a terminal run: settles its generate_shots claim (unless a
 * newer run has since taken the claim) and its hold. Both are safe to repeat. The outline
 * is durable in `scenes` once written, so the claim's payload is cleared then.
 */
async function completeFinishedShotRun(supabase: Client, ledger: ShotRunLedger, run: SettleRunRow): Promise<void> {
  if (run.status === 'running') return
  if (run.generation_id) {
    // The claim row is the project's one generate_shots lock: a run started after this one
    // reclaimed it, and its state is that run's now.
    const { data: newer } = await supabase
      .from('shot_runs')
      .select('id')
      .eq('project_id', run.project_id)
      .gt('created_at', run.created_at)
      .limit(1)
    if ((newer ?? []).length === 0) {
      const status = run.status as Exclude<ShotRunStatus, 'running'>
      const { error: settleError } = await settleGeneration(supabase, run.generation_id, {
        success: status === 'completed',
        error: status === 'completed' ? null : GENERATION_ERRORS[status],
        clearPayload: run.total_scenes !== null,
      })
      if (settleError) console.error(`[shots] claim settle failed for run ${run.id}`, settleError)
    }
  }
  await settleShotRun(supabase, ledger, run)
}

/** Credits a run's actual output comes to: its saved shots at the fixed price, or an agent
 * run's summed USD - its turn, outline and every chunk - converted once. */
export function shotRunActualCredits(run: Pick<SettleRunRow, 'agent_generation_id' | 'turn_cost_usd' | 'outline_cost_usd' | 'shot_run_chunks'>): number {
  const chunks = run.shot_run_chunks ?? []
  if (isAgentShotRun(run)) {
    const usd = Number(run.turn_cost_usd ?? 0) + Number(run.outline_cost_usd) + chunks.reduce((sum, c) => sum + Number(c.cost_usd), 0)
    return usdToCredits(usd)
  }
  const saved = chunks.reduce((sum, c) => sum + c.shots_saved, 0)
  return saved > 0 ? creditsFor({ step: 'workbench', operation: 'generate_shots', quantity: saved }) : 0
}

/**
 * Settles the run's hold at its actual charge, once the run is terminal - and, for an agent
 * run, once the turn has handed over its own cost too (whichever happens second settles).
 * The sums come from the run record, never from `usage`. The settle's dedupe key (the
 * hold's id) makes a repeat a no-op; charged_at marks the run settled. A settle that could
 * not be written leaves charged_at null for the next touch to retry. An agent run also
 * releases the turn's lock here.
 */
export async function settleShotRun(supabase: Client, ledger: ShotRunLedger, run: SettleRunRow): Promise<{ charged: boolean }> {
  if (run.status === 'running' || run.charged_at !== null) return { charged: false }
  const agent = isAgentShotRun(run)
  if (agent && run.turn_settled_at === null) return { charged: false }

  const outcome = await ledger.settleHold({
    userId: run.projects.user_id,
    attemptId: run.attempt_id,
    step: 'workbench',
    operation: agent ? 'agent_turn' : 'generate_shots',
    pricingMode: agent ? 'dynamic' : 'fixed',
    projectId: run.project_id,
    messageId: run.message_id,
    actualCredits: shotRunActualCredits(run),
  })
  if (outcome === 'failed') return { charged: false }

  const now = new Date().toISOString()
  const { data: marked } = await supabase
    .from('shot_runs')
    .update({ charged_at: now, updated_at: now })
    .eq('id', run.id)
    .is('charged_at', null)
    .select('id')
  if (agent && run.agent_generation_id && (marked ?? []).length > 0) {
    const { error: lockError } = await settleGeneration(supabase, run.agent_generation_id, { success: true, clearPayload: true })
    if (lockError) console.error(`[shots] could not release the agent lock for run ${run.id}`, lockError)
  }
  return { charged: true }
}

/**
 * The agent turn that started a run has ended: hands over the turn's own settled cost and
 * settles the run if its chain has already finished.
 */
export async function settleShotRunTurn(supabase: Client, ledger: ShotRunLedger, runId: string, turnCostUsd: number): Promise<void> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('shot_runs')
    .update({ turn_cost_usd: turnCostUsd, turn_settled_at: now, updated_at: now })
    .eq('id', runId)
    .is('turn_settled_at', null)
    .select(SETTLE_RUN_COLUMNS)
  if (error) console.error(`[shots] could not hand the turn's cost to run ${runId}`, error.message)
  const run = ((data ?? [])[0] as unknown as SettleRunRow | undefined) ?? (await readSettleRun(supabase, runId))
  if (run) await settleShotRun(supabase, ledger, run)
}

/** Whether any of these runs needs settleDeadShotRuns now. */
export function anyDeadShotRun(runs: readonly SettleRunRow[], now: number = Date.now()): boolean {
  return runs.some((run) => needsDeadRunSettlement(run, now))
}

/**
 * Settles whatever a dead chain left behind - never sooner than its stale window, so a page
 * view or a poll can never settle a run whose worker is still writing:
 *   - a 'running' run whose heartbeat has aged out is finished 'failed/stale' (its half-
 *     written chunks' shots are removed, their payloads kept for a replay);
 *   - a terminal run still unsettled whose finish is older than the stale window has its
 *     claim and hold settled (the worker died between the two);
 *   - an agent run whose turn never handed over its cost is settled without it.
 * Callers gate it on anyDeadShotRun over runs they already read and pass those (`runs`), so
 * the normal path costs nothing. Returns whether anything changed, so a caller that already
 * read the run can re-read it.
 */
export async function settleDeadShotRuns(
  supabase: Client,
  ledger: ShotRunLedger,
  projectId: string,
  runs?: readonly SettleRunRow[]
): Promise<{ changed: boolean }> {
  let open = runs
  if (!open) {
    const read = await readOpenShotRuns(supabase, projectId)
    if (read.error) {
      console.error(`[shots] could not read runs for project ${projectId}`, read.error)
      return { changed: false }
    }
    open = read.runs
  }
  const now = Date.now()
  let changed = false
  for (const run of open) {
    if (run.status === 'running') {
      if (isLiveShotRun(run, now)) continue
      await abandonRunningChunks(supabase, projectId, run.id)
      // A chain that died after its last scene (mid re-sequence, say) wrote everything: it
      // ends 'completed', not 'failed' with nothing left to generate.
      const outcome = (await everySceneWritten(supabase, projectId))
        ? ({ status: 'completed', stopReason: null } as const)
        : ({ status: 'failed', stopReason: 'stale' } as const)
      // Abandoning chunks changed their counts: the finish reads the run afresh.
      const { finished } = await finishShotRun(supabase, ledger, run.id, outcome, { afterDeath: true })
      changed ||= finished
      continue
    }
    if (run.charged_at !== null) continue
    const finishedAt = run.finished_at ? new Date(run.finished_at).getTime() : 0
    if (finishedAt > now - SHOT_RUN_STALE_AFTER_MS) continue
    if (isAgentShotRun(run) && run.turn_settled_at === null) {
      console.warn(`[shots] agent run ${run.id} settled without its turn's own cost - the turn never handed it over`)
      await settleShotRunTurn(supabase, ledger, run.id, 0)
      changed = true
      continue
    }
    console.warn(`[shots] run ${run.id} finished but was never settled - completing it`)
    await completeFinishedShotRun(supabase, ledger, run)
    changed = true
  }
  return { changed }
}

/** Whether the project has a scene plan and every scene in it has a chunk that finished it. */
async function everySceneWritten(supabase: Client, projectId: string): Promise<boolean> {
  const { data, error } = await supabase.from('scenes').select('id, shot_run_chunks(scene_complete)').eq('project_id', projectId)
  if (error) return false
  const scenes = (data ?? []) as { shot_run_chunks: { scene_complete: boolean }[] }[]
  return scenes.length > 0 && scenes.every((sc) => sc.shot_run_chunks.some((c) => c.scene_complete))
}

async function abandonRunningChunks(supabase: Client, projectId: string, runId: string): Promise<void> {
  const { data: chunks } = await supabase
    .from('shot_run_chunks')
    .select('id, chunk_index, scenes(position)')
    .eq('run_id', runId)
    .eq('status', 'running')
  for (const chunk of (chunks ?? []) as unknown as { id: string; chunk_index: number; scenes: { position: number } | null }[]) {
    if (chunk.scenes) await deleteChunkProvisionalShots(supabase, projectId, chunk.scenes.position, chunk.chunk_index)
    await supabase
      .from('shot_run_chunks')
      .update({ status: 'failed', error: 'The run ended before this chunk finished', shots_saved: 0, updated_at: new Date().toISOString() })
      .eq('id', chunk.id)
      .eq('status', 'running')
  }
}

/**
 * Whether a project has a live shot run - the agent's lock while a chain it started (or
 * any other) is still writing.
 */
export async function hasLiveShotRun(supabase: Client, projectId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('shot_runs')
    .select('status, heartbeat_at')
    .eq('project_id', projectId)
    .eq('status', 'running')
  if (error) throw new Error(`hasLiveShotRun failed: ${error.message}`)
  return (data ?? []).some((run) => isLiveShotRun(run))
}
