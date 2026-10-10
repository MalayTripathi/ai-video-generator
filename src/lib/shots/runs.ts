import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Tables } from '@/lib/database.types'
// Type-only: credits/ledger.ts imports the service-role client (server-only). The real
// writers are injected by each caller (route, page, agent turn), the same way every paid
// route's logic.ts takes them.
import type { recordDynamicSpend, recordFixedSpend } from '@/lib/credits/ledger'
import { refreshGenerationHeartbeat, settleGeneration } from '@/lib/generations/claim'
import { SHOT_RUN_STALE_AFTER_MS, SHOTS_PER_CHUNK } from '@/lib/config/shots'
import { chunkShotOrderIndex, resequence } from './positions'

// The shot-run record: one row per shot-generation user action (Generate shots, Generate
// remaining shots, the agent's regenerate_all_shots) plus one row per chunk. Bookkeeping
// for the self-continuing chain - never the ledger. This module owns the run's terminal
// transitions and its single ledger write. Works with either the user's client (RLS) or
// the service-role client (the chain); every query is scoped by project or run id.

type Client = SupabaseClient<Database>
export type ShotRunRow = Tables<'shot_runs'>
export type ShotRunChunkRow = Tables<'shot_run_chunks'>
export type ShotRunStatus = 'running' | 'completed' | 'stopped' | 'failed'
export type ShotRunStopReason = 'balance' | 'error' | 'chain_limit' | 'stale' | 'ceiling'

/** The ledger writers a charge may need - fixed for a button run, dynamic for an agent run. */
export type ShotRunLedger = {
  recordFixedSpend: typeof recordFixedSpend | null
  recordDynamicSpend: typeof recordDynamicSpend | null
}

/** Whether a run is still going: 'running' and heartbeat younger than the stale window. */
export function isLiveShotRun(run: Pick<ShotRunRow, 'status' | 'heartbeat_at'>, now: number = Date.now()): boolean {
  return run.status === 'running' && new Date(run.heartbeat_at).getTime() > now - SHOT_RUN_STALE_AFTER_MS
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
 * Re-sequences a project's shots to 0..n-1 in scene order (see positions.ts). Two passes
 * through negative values, because the (project_id, order_index) unique index would
 * otherwise reject a shot moving onto an index another still holds.
 */
export async function resequenceProjectShots(supabase: Client, projectId: string): Promise<{ error: string | null }> {
  const { data, error } = await supabase
    .from('shots')
    .select('id, order_index, scenes(position)')
    .eq('project_id', projectId)
  if (error) return { error: error.message }
  type Row = { id: string; order_index: number; scenes: { position: number } | null }
  const moves = resequence(
    ((data ?? []) as unknown as Row[]).map((r) => ({ id: r.id, order_index: r.order_index, scenePosition: r.scenes?.position ?? null }))
  )
  const updatedAt = new Date().toISOString()
  for (const pass of [(i: number) => -(i + 1), (i: number) => i]) {
    for (const move of moves) {
      const { error: moveError } = await supabase
        .from('shots')
        .update({ order_index: pass(move.order_index), updated_at: updatedAt })
        .eq('id', move.id)
        .eq('project_id', projectId)
      if (moveError) return { error: moveError.message }
    }
  }
  return { error: null }
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

/**
 * Ends a run: marks it terminal (only if still 'running' - a second finisher is a no-op),
 * re-sequences the project's shots, settles the generate_shots claim and charges the run.
 * The outline is durable in `scenes` once written, so the claim's payload is cleared then.
 */
export async function finishShotRun(
  supabase: Client,
  ledger: ShotRunLedger,
  runId: string,
  outcome: { status: Exclude<ShotRunStatus, 'running'>; stopReason: ShotRunStopReason | null }
): Promise<{ finished: boolean }> {
  const now = new Date().toISOString()
  const { data: rows, error } = await supabase
    .from('shot_runs')
    .update({ status: outcome.status, stop_reason: outcome.stopReason, finished_at: now, updated_at: now })
    .eq('id', runId)
    .eq('status', 'running')
    .select('id, project_id, generation_id, total_scenes')
  if (error) {
    console.error(`[shots] could not finish run ${runId}`, error.message)
    return { finished: false }
  }
  const run = rows?.[0]
  if (!run) return { finished: false }

  const { error: seqError } = await resequenceProjectShots(supabase, run.project_id)
  if (seqError) console.error(`[shots] re-sequence failed for run ${runId}`, seqError)

  if (run.generation_id) {
    const { error: settleError } = await settleGeneration(supabase, run.generation_id, {
      success: outcome.status === 'completed',
      error: outcome.status === 'completed' ? null : GENERATION_ERRORS[outcome.status],
      clearPayload: run.total_scenes !== null,
    })
    if (settleError) console.error(`[shots] claim settle failed for run ${runId}`, settleError)
  }

  await chargeShotRun(supabase, ledger, runId)
  return { finished: true }
}

/**
 * The run's single ledger row, written once the run is terminal - and, for an agent run,
 * once the turn has handed over its own cost too (whichever happens second charges).
 * A button run is 2 credits per saved shot (fixed price); an agent run is the summed USD
 * of every provider call in the action - the turn's own calls, the outline and every
 * chunk - converted once. The sums come from the run record, never from `usage`. The
 * ledger's dedupe key (the attempt id) makes a repeated charge a no-op; charged_at marks
 * the run done. An agent run also releases the turn's lock here.
 */
export async function chargeShotRun(supabase: Client, ledger: ShotRunLedger, runId: string): Promise<{ charged: boolean }> {
  const { data: run, error } = await supabase
    .from('shot_runs')
    .select(
      'id, project_id, attempt_id, status, message_id, agent_generation_id, outline_cost_usd, turn_cost_usd, turn_settled_at, charged_at, projects!inner(user_id), shot_run_chunks(shots_saved, cost_usd)'
    )
    .eq('id', runId)
    .maybeSingle()
  if (error || !run) {
    if (error) console.error(`[shots] could not read run ${runId} to charge`, error.message)
    return { charged: false }
  }
  if (run.status === 'running' || run.charged_at !== null) return { charged: false }
  const agent = isAgentShotRun(run)
  if (agent && run.turn_settled_at === null) return { charged: false }

  const userId = (run.projects as unknown as { user_id: string }).user_id
  const chunks = (run.shot_run_chunks ?? []) as { shots_saved: number; cost_usd: number }[]
  try {
    if (agent) {
      const usd = Number(run.turn_cost_usd ?? 0) + Number(run.outline_cost_usd) + chunks.reduce((sum, c) => sum + Number(c.cost_usd), 0)
      if (!ledger.recordDynamicSpend) throw new Error('an agent shot run needs recordDynamicSpend to charge')
      await ledger.recordDynamicSpend({
        userId,
        usd,
        step: 'workbench',
        operation: 'agent_turn',
        attemptId: run.attempt_id,
        projectId: run.project_id,
        messageId: run.message_id,
      })
    } else {
      const saved = chunks.reduce((sum, c) => sum + c.shots_saved, 0)
      if (saved > 0) {
        if (!ledger.recordFixedSpend) throw new Error('a shot run needs recordFixedSpend to charge')
        await ledger.recordFixedSpend({
          userId,
          step: 'workbench',
          operation: 'generate_shots',
          quantity: saved,
          attemptId: run.attempt_id,
          projectId: run.project_id,
          messageId: null,
          shotKey: null,
        })
      }
    }
  } catch (err) {
    // Left uncharged (charged_at stays null): the next touch of the project retries it,
    // and the attempt-id dedupe makes that retry safe.
    console.error(`[shots] ledger write failed for run ${runId}`, err)
    return { charged: false }
  }

  const now = new Date().toISOString()
  const { data: marked } = await supabase
    .from('shot_runs')
    .update({ charged_at: now, updated_at: now })
    .eq('id', runId)
    .is('charged_at', null)
    .select('id')
  if (agent && run.agent_generation_id && (marked ?? []).length > 0) {
    const { error: lockError } = await settleGeneration(supabase, run.agent_generation_id, { success: true, clearPayload: true })
    if (lockError) console.error(`[shots] could not release the agent lock for run ${runId}`, lockError)
  }
  return { charged: true }
}

/**
 * The agent turn that started a run has ended: hands over the turn's own settled cost and
 * charges the run if its chain has already finished.
 */
export async function settleShotRunTurn(supabase: Client, ledger: ShotRunLedger, runId: string, turnCostUsd: number): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('shot_runs')
    .update({ turn_cost_usd: turnCostUsd, turn_settled_at: now, updated_at: now })
    .eq('id', runId)
    .is('turn_settled_at', null)
  if (error) console.error(`[shots] could not hand the turn's cost to run ${runId}`, error.message)
  await chargeShotRun(supabase, ledger, runId)
}

/**
 * Settles whatever a dead chain left behind, on the first request that touches the
 * project after its stale window: a 'running' run whose heartbeat has aged out is failed
 * (its half-written chunks' shots are removed, their payloads kept for a replay), and any
 * terminal run still uncharged is charged. An agent run whose turn never handed over its
 * cost is charged without it once the run itself is past the stale window. Returns
 * whether anything changed, so a caller that already read the run can re-read it.
 */
export async function settleDeadShotRuns(supabase: Client, ledger: ShotRunLedger, projectId: string): Promise<{ changed: boolean }> {
  const { data: runs, error } = await supabase
    .from('shot_runs')
    .select('id, status, heartbeat_at, finished_at, charged_at, agent_generation_id, turn_settled_at')
    .eq('project_id', projectId)
    .or('status.eq.running,charged_at.is.null')
  if (error) {
    console.error(`[shots] could not read runs for project ${projectId}`, error.message)
    return { changed: false }
  }
  const now = Date.now()
  let changed = false
  for (const run of runs ?? []) {
    if (run.status === 'running') {
      if (isLiveShotRun(run, now)) continue
      await abandonRunningChunks(supabase, projectId, run.id)
      const { finished } = await finishShotRun(supabase, ledger, run.id, { status: 'failed', stopReason: 'stale' })
      changed ||= finished
      continue
    }
    if (isAgentShotRun(run) && run.turn_settled_at === null) {
      const finishedAt = run.finished_at ? new Date(run.finished_at).getTime() : 0
      if (finishedAt > now - SHOT_RUN_STALE_AFTER_MS) continue
      console.warn(`[shots] agent run ${run.id} charged without its turn's own cost - the turn never handed it over`)
      await settleShotRunTurn(supabase, ledger, run.id, 0)
      changed = true
      continue
    }
    const { charged } = await chargeShotRun(supabase, ledger, run.id)
    changed ||= charged
  }
  return { changed }
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
