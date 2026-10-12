import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json, Tables } from '@/lib/database.types'
import { ClaudeRefusalError, throwIfRefused, type ClaudeGateway } from '@/lib/claude'
import type { UsageBreakdown } from '@/lib/config/pricing'
import { claudeReasoningParams, videoModelBounds, type VideoModelConfig } from '@/lib/config/models'
import { effectiveVideoModel } from '@/lib/shots/effective-model'
import { modelsConfig } from '@/lib/config/models.server'
import { durationConfig, parseDurationTarget, type DurationConfig } from '@/lib/config/duration'
import { CLASSIFIABLE_VIDEO_TYPES } from '@/lib/config/enums'
import { SHOT_CHUNK_CONCURRENCY, SHOT_HANDOFF_TIMEOUT_MS, SHOTS_PER_CHUNK, shotRunBudgetMs } from '@/lib/config/shots'
import { persistGenerationPayload } from '@/lib/generations/claim'
import { assertWithinAllowance, estimateInputTokens, quoteClaudeCall, reserveUsage, settleUsage, settledStatus } from '@/lib/usage'
import { isUniqueViolation } from '@/lib/shot-key'
import {
  SHOT_OUTLINE_SYSTEM_PROMPT_V1,
  WRITE_OUTLINE_TOOL,
  buildOutlineDynamicBlock,
} from '@/lib/prompts/shot-outline'
import {
  SHOT_CHUNK_SYSTEM_PROMPT_V3,
  buildChunkProjectBlock,
  buildChunkUserMessage,
  buildChunkWriteShotsTool,
  type PreviousShotForPrompt,
} from '@/lib/prompts/shot-chunk'
import { fitOutlineSeconds, sceneMaxShots, sceneRequestLimitSec, shotCeiling } from '@/lib/shots/limits'
import { chunkWordBudget } from '@/lib/shots/durations'
import { ElementResolver, insertChunkShots, prepareChunkShots, sanitizeEnum } from '@/lib/shots/write-chunk'
import {
  deleteChunkProvisionalShots,
  finishShotRun,
  heartbeatShotRun,
  type ShotRunLedger,
  type ShotRunStatus,
  type ShotRunStopReason,
} from '@/lib/shots/runs'
import { creditsFor, usdToCredits } from '@/lib/config/credits'

// The shot-generation chain: one background run of it. Service-role client, so every read
// and write below is scoped explicitly by project (and the project by user, at load).
//
// Run 0 of a 'generate' chain writes the outline (CLAIM -> RECOVER -> PERSIST on the
// generate_shots claim's payload, then the scenes). Every run then writes chunks: one
// Claude request per chunk, up to SHOTS_PER_CHUNK shots of one scene, scenes in parallel
// and each scene's chunks in order, so a chunk continues from the shot before it. A chunk's
// payload is stored on its chunk row before its shots are written. Every complete shot a
// chunk returns is saved - code never drops one. A scene's target seconds (the outline's,
// fixed before any chunk runs) are what its requests aim at; requests for it stop at its
// share of the tier maximum (sceneRequestLimitSec), so a scene running long can never take
// the headroom a later scene needs. The project's ceiling and tier maximum likewise stop
// further requests, never a saved shot. At the time budget (derived per
// model, shot-timing.ts) a run stops starting chunks, lets its in-flight ones drain, and
// hands the rest to a fresh run - as long as it saved something (the progress guard). Runs
// never overlap, so its running totals are exact. The run spends against the hold placed at
// its start: the balance is read only when its output is about to pass that hold. The final
// run ends the run record (finishShotRun): re-sequence, mark terminal, settle the claim and
// the hold. A run ends 'completed' only when every outline scene is written.

type Client = SupabaseClient<Database>
type SceneRow = Pick<
  Tables<'scenes'>,
  'id' | 'position' | 'title' | 'summary' | 'location' | 'time_of_day' | 'target_seconds'
>
type ChunkRow = Pick<
  Tables<'shot_run_chunks'>,
  'id' | 'run_id' | 'scene_id' | 'chunk_index' | 'status' | 'scene_complete' | 'shots_saved' | 'payload' | 'cost_usd'
>

export type ShotsContinuationPayload = {
  userId: string
  projectId: string
  runId: string
  chainDepth: number
}

export function parseShotsContinuationPayload(raw: unknown, projectId: string): ShotsContinuationPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  if (typeof v.userId !== 'string' || v.userId === '') return null
  if (v.projectId !== projectId) return null
  if (typeof v.runId !== 'string' || v.runId === '') return null
  // 0 is a chain's first run started in its own invocation (the agent's regenerate_all_shots).
  if (typeof v.chainDepth !== 'number' || !Number.isInteger(v.chainDepth) || v.chainDepth < 0) return null
  return { userId: v.userId, projectId, runId: v.runId, chainDepth: v.chainDepth }
}

// A run calling the shots route to continue itself sends this header with the shared
// continuation secret (src/lib/continuation.ts).
export const SHOTS_INTERNAL_SECRET_HEADER = 'x-shots-internal-secret'

/**
 * The hand-off to a fresh invocation of the shots route - a run continuing the chain, or
 * (chainDepth 0) the agent starting one outside its own turn. Resolves true only on the
 * route's 202. A missing secret is a deploy misconfiguration: logged and refused, so the
 * run stops with its unwritten scenes left for "Generate remaining shots". `headers` carries
 * the deployment protection bypass (continuation.ts).
 */
export function createShotsContinueRun(params: {
  origin: string
  secret: string | undefined
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}): (payload: ShotsContinuationPayload) => Promise<boolean> {
  return async (payload) => {
    if (!params.secret) {
      console.error(
        `[shots] INTERNAL_CONTINUATION_SECRET is not set - run ${payload.runId} of project ${payload.projectId} cannot continue past this invocation`
      )
      return false
    }
    const res = await (params.fetchImpl ?? fetch)(`${params.origin}/api/projects/${payload.projectId}/shots`, {
      method: 'POST',
      headers: { ...params.headers, 'Content-Type': 'application/json', [SHOTS_INTERNAL_SECRET_HEADER]: params.secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SHOT_HANDOFF_TIMEOUT_MS),
    })
    if (res.status !== 202) console.error(`[shots] continuation refused with status ${res.status}`)
    return res.status === 202
  }
}

/** A continuation is accepted only for a run that is still running, in the named user's project. */
export async function acceptShotsContinuation(
  supabase: Client,
  payload: ShotsContinuationPayload
): Promise<{ ok: true } | { ok: false; status: 404 | 409 | 500; error: string }> {
  const { data, error } = await supabase
    .from('shot_runs')
    .select('id, status, projects!inner(user_id)')
    .eq('id', payload.runId)
    .eq('project_id', payload.projectId)
    .eq('projects.user_id', payload.userId)
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 404, error: 'Run not found' }
  if (data.status !== 'running') return { ok: false, status: 409, error: 'Run is no longer running' }
  return { ok: true }
}

export type ShotsWorkerDeps = {
  supabase: Client // service role
  gateway: ClaudeGateway
  ledger: ShotRunLedger
  /** The user's credit balance, read fresh - only when a chunk would take the run past its hold. */
  readBalance: (userId: string) => Promise<number>
  /** Hands the rest of the run to a fresh invocation. Resolves true only when accepted. */
  continueRun: (payload: ShotsContinuationPayload) => Promise<boolean>
  /** Test seams - production always derives the budget (shot-timing.ts) and uses config/shots.ts. */
  runBudgetMs?: number
  concurrency?: number
}

export type ShotsWorkerResult =
  | { outcome: 'skipped' }
  | { outcome: 'continued'; chunks: number }
  | { outcome: 'finished'; status: Exclude<ShotRunStatus, 'running'>; stopReason: ShotRunStopReason | null; chunks: number }

type ProjectForRun = {
  user_id: string
  source_text: string | null
  video_type: string | null
  language: string | null
  duration_target: string | null
  title: string | null
  video_model: string | null
}

type SceneState = {
  scene: SceneRow
  elementNames: string[]
  shots: number
  seconds: number
  nextChunkIndex: number
  maxShots: number
  /** The scene's target seconds - fixed by the outline; what its requests aim at. */
  targetSec: number
  /** Past these seconds the scene gets no further request (its share of the tier maximum). */
  limitSec: number
  lastShot: PreviousShotForPrompt | null
  /** A replayable payload a dead chunk of this scene left behind (paid for, never applied). */
  orphan: { chunkId: string; payload: Json } | null
}

export async function runShotsWorker(deps: ShotsWorkerDeps, payload: ShotsContinuationPayload | (Omit<ShotsContinuationPayload, 'chainDepth'> & { chainDepth: 0 })): Promise<ShotsWorkerResult> {
  const { supabase, gateway, ledger } = deps
  const { userId, projectId, runId, chainDepth } = payload
  const budget = deps.runBudgetMs ?? shotRunBudgetMs(modelsConfig.shots.model, modelsConfig.shots.maxTokens)
  const concurrency = deps.concurrency ?? SHOT_CHUNK_CONCURRENCY
  const runStart = Date.now()
  let chunksRun = 0

  const [{ data: run }, { data: project }] = await Promise.all([
    supabase
      .from('shot_runs')
      .select('id, project_id, kind, status, attempt_id, generation_id, message_id, agent_generation_id, total_scenes, outline_cost_usd')
      .eq('id', runId)
      .eq('project_id', projectId)
      .maybeSingle(),
    supabase
      .from('projects')
      .select('user_id, source_text, video_type, language, duration_target, title, video_model')
      .eq('id', projectId)
      .eq('user_id', userId)
      .maybeSingle(),
  ])
  if (!run || run.status !== 'running') return { outcome: 'skipped' }

  const finish = async (status: Exclude<ShotRunStatus, 'running'>, stopReason: ShotRunStopReason | null): Promise<ShotsWorkerResult> => {
    await finishShotRun(supabase, ledger, runId, { status, stopReason })
    return { outcome: 'finished', status, stopReason, chunks: chunksRun }
  }

  // A new shot has no model of its own yet - the project's is every new shot's.
  const model = project ? effectiveVideoModel(project) : null
  if (!project || !model) {
    console.error(`[shots] run ${runId}: project not found or its video model is unregistered`)
    return finish('failed', 'error')
  }
  await heartbeatShotRun(supabase, run)

  const tier = durationConfig[parseDurationTarget(project.duration_target)]
  const bounds = videoModelBounds(model)
  const ceiling = shotCeiling(tier.targetSecondsMax, bounds.min)
  const usageBase = {
    supabase,
    userId,
    projectId,
    generationId: run.generation_id,
    shotId: null,
    messageId: run.message_id,
    step: 'workbench' as const,
    operation: 'generate_shots' as const,
    provider: 'anthropic' as const,
  }

  // ---- Outline (run 0 of a 'generate' chain) -------------------------------------------
  let outlineElementNames: Map<number, string[]> | null = null
  // The outline's cost when this run wrote it (the run row read above predates it).
  let outlineCostUsd = 0
  if (run.total_scenes === null) {
    const outline = await writeOutline({ supabase, gateway, run, project, tier, model, usageBase })
    if (!outline.ok) return finish('failed', outline.refused ? 'refused' : 'error')
    outlineElementNames = outline.elementNames
    outlineCostUsd = outline.costUsd
  }
  // Progress, for the guard: the outline, or any shot saved by this run.
  const outlineWritten = run.total_scenes === null
  let savedThisRun = 0

  // ---- State -------------------------------------------------------------------------------
  const [scenesResult, chunksResult, shotsResult, elements, holdResult] = await Promise.all([
    supabase
      .from('scenes')
      .select('id, position, title, summary, location, time_of_day, target_seconds')
      .eq('project_id', projectId)
      .order('position', { ascending: true }),
    supabase
      .from('shot_run_chunks')
      .select('id, run_id, scene_id, chunk_index, status, scene_complete, shots_saved, payload, cost_usd')
      .eq('project_id', projectId),
    supabase
      .from('shots')
      .select('id, scene_id, order_index, voice_over, visual_description, duration_sec, shot_elements(elements(name))')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    ElementResolver.load(supabase, projectId).catch((err: unknown) => err as Error),
    // The hold this run placed at its start - what it spends against before any balance read.
    supabase
      .from('credit_ledger')
      .select('delta')
      .eq('user_id', userId)
      .eq('attempt_id', run.attempt_id)
      .eq('kind', 'spend')
      .like('dedupe_key', 'hold:%')
      .maybeSingle(),
  ])
  if (scenesResult.error || chunksResult.error || shotsResult.error || elements instanceof Error) {
    console.error(`[shots] run ${runId}: could not load its state`)
    return finish('failed', 'error')
  }
  const scenes = scenesResult.data ?? []
  const chunks = (chunksResult.data ?? []) as ChunkRow[]
  // No hold (a run from before holds, or one whose hold can't be read): every chunk then
  // checks the balance - the safe direction.
  const heldCredits = holdResult.error || !holdResult.data ? 0 : -holdResult.data.delta
  type ShotRead = {
    scene_id: string | null
    voice_over: string
    visual_description: string | null
    duration_sec: number | null
    shot_elements: { elements: { name: string } | null }[]
  }
  const shots = (shotsResult.data ?? []) as unknown as ShotRead[]
  if (outlineElementNames === null) outlineElementNames = await storedOutlineElementNames(supabase, run.generation_id)

  // Running totals - the whole project's shots against the ceiling and the tier's maximum
  // seconds (both stop further requests only), and this run's spend so far against its hold.
  const totals = { shots: shots.length, seconds: shots.reduce((sum, s) => sum + (s.duration_sec ?? 0), 0) }
  const agentRun = run.agent_generation_id !== null
  const runChunks = chunks.filter((c) => c.run_id === runId)
  // What this run has spent so far, in the unit its settle uses: saved shots (fixed price), or
  // an agent run's provider USD (the turn's own cost is added at settle).
  const spent = {
    shots: runChunks.reduce((sum, c) => sum + c.shots_saved, 0),
    usd: Number(run.outline_cost_usd ?? 0) + outlineCostUsd + runChunks.reduce((sum, c) => sum + Number(c.cost_usd ?? 0), 0),
  }
  const shotPrice = (n: number) => (n > 0 ? creditsFor({ step: 'workbench', operation: 'generate_shots', quantity: n }) : 0)
  const spentCredits = () => (agentRun ? usdToCredits(spent.usd) : shotPrice(spent.shots))
  // Shots asked for by chunks still in flight - each may come back full.
  let inFlightShots = 0

  const failedInRun = new Set(chunks.filter((c) => c.run_id === runId && c.status === 'failed').map((c) => c.scene_id))
  // Scenes already written: a chunk marked them complete. Only these let a run end
  // 'completed' - a scene with no shots never is.
  const completed = new Set(scenes.filter((sc) => chunks.some((c) => c.scene_id === sc.id && c.scene_complete)).map((sc) => sc.id))
  const tierRange = { maxSec: tier.targetSecondsMax, targetSec: tier.targetSeconds }
  const targetOf = (scene: SceneRow) => scene.target_seconds ?? tier.targetSeconds / Math.max(1, scenes.length)
  const writtenOf = (sceneId: string) =>
    shots.filter((s) => s.scene_id === sceneId).reduce((sum, s) => sum + (s.duration_sec ?? 0), 0)
  const queue: SceneState[] = []
  for (const scene of scenes) {
    if (completed.has(scene.id) || failedInRun.has(scene.id)) continue
    const sceneChunks = chunks.filter((c) => c.scene_id === scene.id)
    const sceneShots = shots.filter((s) => s.scene_id === scene.id)
    const targetSec = targetOf(scene)
    const last = sceneShots.at(-1) ?? lastShotBefore(shots, scenes, scene.position)
    const orphan = sceneChunks.find((c) => c.run_id !== runId && c.status !== 'succeeded' && c.payload !== null)
    queue.push({
      scene,
      elementNames:
        outlineElementNames.get(scene.position) ??
        [...new Set(sceneShots.flatMap((s) => s.shot_elements.map((se) => se.elements?.name).filter((n): n is string => !!n)))],
      shots: sceneShots.length,
      seconds: writtenOf(scene.id),
      nextChunkIndex: sceneChunks.reduce((max, c) => Math.max(max, c.chunk_index + 1), 0),
      maxShots: sceneMaxShots(targetSec, bounds.min),
      targetSec,
      limitSec: sceneRequestLimitSec(targetSec, tierRange),
      lastShot: last ? { voice_over: last.voice_over, visual_description: last.visual_description } : null,
      orphan: orphan ? { chunkId: orphan.id, payload: orphan.payload! } : null,
    })
  }
  const projectBlock = buildChunkProjectBlock(project, scenes)

  // ---- Chunk pool ---------------------------------------------------------------------------
  // Held in an object so the lanes' closures and the code after them see one value.
  const control: { stop: { status: Exclude<ShotRunStatus, 'running'>; reason: ShotRunStopReason } | null } = { stop: null }
  // Chunks that failed on an error (provider, refusal, write) - the run then ends 'error'
  // rather than 'incomplete'.
  let errors = 0
  // Chunks the model's safety checks declined - the run then ends 'refused', not 'error'.
  let refusals = 0

  /**
   * Whether a scene may be asked for more shots. Below its target it always may - its target
   * is its own plan. Past it, only within its share of the tier maximum (limitSec) and while
   * the project is under its maximum seconds. The shot ceiling and the scene's shot count
   * bound every request. Never a reason to drop a shot already written.
   */
  const mayRequest = (state: SceneState): boolean =>
    state.seconds < state.limitSec - 1e-9 &&
    state.shots < state.maxShots &&
    totals.shots + inFlightShots < ceiling &&
    (state.seconds < state.targetSec - 1e-9 || totals.seconds < tier.targetSecondsMax - 1e-9)

  /** Marks a scene written without a request: its limits allow no more, and it has shots. */
  const closeScene = async (state: SceneState): Promise<'done' | 'left'> => {
    if (state.shots === 0) return 'left'
    const now = new Date().toISOString()
    const { error } = await supabase.from('shot_run_chunks').insert({
      run_id: runId,
      project_id: projectId,
      scene_id: state.scene.id,
      chunk_index: state.nextChunkIndex++,
      max_shots: 0,
      status: 'succeeded',
      shots_saved: 0,
      shots_returned: 0,
      cost_usd: 0,
      payload: null,
      error: null,
      scene_complete: true,
      started_at: now,
      created_at: now,
      updated_at: now,
    })
    if (error) {
      console.error(`[shots] run ${runId}: could not close scene ${state.scene.position}`, error.message)
      return 'left'
    }
    completed.add(state.scene.id)
    return 'done'
  }

  /**
   * One chunk of one scene. 'again': the scene continues in its next chunk. 'done': the
   * scene is written. 'left': the scene stays unwritten or incomplete for this run (no
   * request allowed, or the answer was cut short before a whole shot). 'error': the chunk failed.
   */
  const runChunk = async (state: SceneState): Promise<'again' | 'done' | 'left' | 'error'> => {
    if (!state.orphan && !mayRequest(state)) {
      if (totals.shots + inFlightShots >= ceiling) console.warn(`[shots] run ${runId}: the project's shot ceiling is reached`)
      return closeScene(state)
    }
    const cap = Math.max(1, Math.min(SHOTS_PER_CHUNK, state.maxShots - state.shots, ceiling - totals.shots - inFlightShots))

    // The run spends against its hold. Only when this chunk could take it past the hold is
    // the balance read: it already reflects the hold, so it must cover the excess.
    const projected = (agentRun ? usdToCredits(spent.usd) + shotPrice(inFlightShots + cap) : shotPrice(spent.shots + inFlightShots + cap))
    if (projected > heldCredits) {
      let balance: number
      try {
        balance = await deps.readBalance(userId)
      } catch (err) {
        console.error(`[shots] run ${runId}: balance read failed`, err)
        control.stop ??= { status: 'failed', reason: 'error' }
        return 'error'
      }
      if (balance < projected - heldCredits) {
        control.stop ??= { status: 'stopped', reason: 'balance' }
        return 'left'
      }
    }

    const chunkIndex = state.nextChunkIndex++
    const startedAt = new Date().toISOString()
    const { data: chunkRow, error: chunkError } = await supabase
      .from('shot_run_chunks')
      .insert({
        run_id: runId,
        project_id: projectId,
        scene_id: state.scene.id,
        chunk_index: chunkIndex,
        max_shots: cap,
        status: 'running',
        shots_saved: 0,
        shots_returned: 0,
        cost_usd: 0,
        payload: state.orphan?.payload ?? null,
        error: null,
        scene_complete: false,
        started_at: startedAt,
        created_at: startedAt,
        updated_at: startedAt,
      })
      .select('id')
      .single()
    if (chunkError || !chunkRow) {
      console.error(`[shots] run ${runId}: could not start a chunk of scene ${state.scene.position}`, chunkError?.message)
      return isUniqueViolation(chunkError) ? 'left' : 'error'
    }
    chunksRun += 1
    inFlightShots += cap

    let costUsd = 0
    let stopReason: string | null = null
    let input: unknown = null
    let usageId: string | null = null
    let breakdown: UsageBreakdown | null = null
    let caught: unknown = null
    const settleChunk = async (patch: Partial<Tables<'shot_run_chunks'>>) => {
      await supabase
        .from('shot_run_chunks')
        .update({ ...patch, cost_usd: costUsd, updated_at: new Date().toISOString() })
        .eq('id', chunkRow.id)
    }

    try {
      if (state.orphan) {
        // RECOVER: a dead chunk's payload was paid for - replay it, never re-call. It now
        // lives on this chunk's row; the dead row lets go of it.
        console.warn(`[shots] run ${runId}: replaying a stored chunk payload for scene ${state.scene.position}`)
        input = state.orphan.payload
        await supabase.from('shot_run_chunks').update({ payload: null, updated_at: startedAt }).eq('id', state.orphan.chunkId)
        state.orphan = null
      } else {
        const tool = buildChunkWriteShotsTool(cap)
        // Past its target (a truncated answer continuing), the scene is asked to close in
        // at least one shortest shot.
        const secondsLeft = Math.max(bounds.min, state.targetSec - state.seconds)
        const userMessage = buildChunkUserMessage({
          scene: state.scene,
          elementNames: state.elementNames,
          previousShot: state.lastShot,
          secondsLeft,
          wordBudget: chunkWordBudget(secondsLeft, project.language, model, cap),
          maxShots: cap,
        })
        const { estimatedCost, quotedBreakdown } = quoteClaudeCall({
          model: modelsConfig.shots.model,
          estimatedInputTokens: estimateInputTokens({ texts: [SHOT_CHUNK_SYSTEM_PROMPT_V3, projectBlock, userMessage], tools: [tool] }),
          maxTokens: modelsConfig.shots.maxTokens,
        })
        await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })
        usageId = (await reserveUsage({ ...usageBase, model: modelsConfig.shots.model, quotedCost: estimatedCost, quotedBreakdown })).usageId
        const { message, stopReason: sr, requestId } = await gateway.createMessage({
          model: modelsConfig.shots.model,
          max_tokens: modelsConfig.shots.maxTokens,
          system: [
            { type: 'text', text: SHOT_CHUNK_SYSTEM_PROMPT_V3, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: projectBlock, cache_control: { type: 'ephemeral' } },
          ],
          tools: [tool],
          tool_choice: { type: 'tool', name: 'write_shots' },
          messages: [{ role: 'user', content: userMessage }],
          ...claudeReasoningParams(modelsConfig.shots),
        })
        breakdown = message.usage
        stopReason = sr
        console.warn(`[shots] chunk stopReason=${sr} requestId=${requestId} outputTokens=${message.usage?.output_tokens}`)
        // Before reading content: a refusal's partial write_shots must never be saved.
        throwIfRefused({ message, stopReason: sr })
        const block = message.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'write_shots'
        )
        if (!block) throw new Error('Claude did not return any shots')
        input = block.input
        // PERSIST before any shot row is written.
        const { error: persistError } = await supabase
          .from('shot_run_chunks')
          .update({ payload: input as Json, updated_at: new Date().toISOString() })
          .eq('id', chunkRow.id)
        if (persistError) throw new Error(`The shots could not be saved safely (${persistError.message})`)
      }
    } catch (err) {
      caught = err
    } finally {
      if (usageId) {
        costUsd = await settleUsage({
          supabase,
          usageId,
          provider: 'anthropic',
          model: modelsConfig.shots.model,
          status: settledStatus(breakdown, stopReason),
          breakdown,
          stopReason,
          error: caught,
        })
      }
    }
    spent.usd += costUsd

    if (caught) {
      inFlightShots -= cap
      if (caught instanceof ClaudeRefusalError) refusals += 1
      console.error(`[shots] run ${runId}: chunk of scene ${state.scene.position} failed`, caught)
      await settleChunk({ status: 'failed', error: caught instanceof Error ? caught.message : 'Chunk failed' })
      return 'error'
    }

    // Every complete shot returned is saved, with its duration computed in code - whatever
    // the scene's target, the cap asked for or the project's limits (those only stop further
    // requests). An answer cut short at max_tokens keeps its complete shots and drops only
    // the half-written one, which was never a shot. Totals move before any await, so chunks
    // finishing together see each other's shots.
    const truncated = stopReason === 'max_tokens'
    const prepared = prepareChunkShots(input, { language: project.language, model, truncated })
    const saved = prepared.shots
    const savedSeconds = saved.reduce((sum, s) => sum + s.seconds, 0)
    totals.shots += saved.length
    totals.seconds += savedSeconds
    inFlightShots -= cap

    try {
      const { error: clearError } = await deleteChunkProvisionalShots(supabase, projectId, state.scene.position, chunkIndex)
      if (clearError) throw new Error(clearError)
      await insertChunkShots(
        supabase,
        projectId,
        elements,
        { sceneId: state.scene.id, scenePosition: state.scene.position, chunkIndex },
        saved
      )
    } catch (err) {
      totals.shots -= saved.length
      totals.seconds -= savedSeconds
      console.error(`[shots] run ${runId}: writing scene ${state.scene.position}'s shots failed`, err)
      await settleChunk({ status: 'failed', shots_returned: saved.length, error: err instanceof Error ? err.message : 'Write failed' })
      return 'error'
    }

    spent.shots += saved.length
    savedThisRun += saved.length
    state.shots += saved.length
    state.seconds += savedSeconds
    const last = saved.at(-1)
    if (last) state.lastShot = { voice_over: last.voice_over, visual_description: last.visual_description }
    if (state.seconds > state.targetSec + 1e-9 || saved.length > cap) {
      console.warn(
        `[shots] scene_over_target project=${projectId} run=${runId} scene=${state.scene.position} target=${state.targetSec} written=${state.seconds} asked=${cap} returned=${saved.length}`
      )
    }

    // A scene is written only once it has shots: when the model says it is finished (never
    // on a truncated answer), when an untruncated answer reached its target, or when its
    // limits allow no further request. A truncated answer otherwise continues the scene from
    // its last complete shot.
    const sceneComplete =
      state.shots > 0 && (prepared.sceneComplete || (!truncated && state.seconds >= state.targetSec - 1e-9) || !mayRequest(state))
    const reason =
      saved.length > 0 || sceneComplete
        ? null
        : truncated
          ? 'The answer was cut short before a whole shot'
          : 'No usable shots were returned'
    // The payload is cleared once its shots are saved: nothing is left to replay.
    await settleChunk({
      status: reason ? 'failed' : 'succeeded',
      shots_saved: saved.length,
      shots_returned: saved.length,
      scene_complete: sceneComplete,
      payload: null,
      error: reason,
    })
    if (sceneComplete) {
      completed.add(state.scene.id)
      return 'done'
    }
    return reason ? 'left' : 'again'
  }

  const active = new Set<string>()
  const lane = async () => {
    while (control.stop === null && Date.now() - runStart < budget) {
      const state = queue.find((s) => !active.has(s.scene.id))
      if (!state) return
      active.add(state.scene.id)
      const result = await runChunk(state)
      await heartbeatShotRun(supabase, run)
      active.delete(state.scene.id)
      if (result !== 'again') queue.splice(queue.indexOf(state), 1)
      if (result === 'error') errors += 1
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane))

  if (control.stop) return finish(control.stop.status, control.stop.reason)
  if (queue.length === 0) {
    // Every scene was tried. 'completed' only when every outline scene is written.
    if (scenes.every((sc) => completed.has(sc.id))) return finish('completed', null)
    const unwritten = scenes.filter((sc) => !completed.has(sc.id)).length
    console.warn(`[shots] run ${runId} ends with ${unwritten} scene(s) unwritten or incomplete, left for Generate remaining shots`)
    return finish('failed', refusals > 0 ? 'refused' : errors > 0 ? 'error' : 'incomplete')
  }

  // Budget reached with scenes still to write. The progress guard: hand off only if this
  // run saved something (or wrote the outline) - a run that saved nothing would only repeat.
  if (!outlineWritten && savedThisRun === 0) {
    console.warn(`[shots] run ${runId} saved no shots in this invocation; ${queue.length} scene(s) left for Generate remaining shots`)
    return finish('failed', 'no_progress')
  }
  let accepted = false
  try {
    accepted = await deps.continueRun({ userId, projectId, runId, chainDepth: chainDepth + 1 })
  } catch (err) {
    console.error('[shots] continuation hand-off failed', err)
  }
  if (!accepted) return finish('failed', 'error')
  return { outcome: 'continued', chunks: chunksRun }
}

function lastShotBefore(
  shots: readonly { scene_id: string | null; voice_over: string; visual_description: string | null }[],
  scenes: readonly SceneRow[],
  position: number
): { voice_over: string; visual_description: string | null } | null {
  const earlier = new Set(scenes.filter((s) => s.position < position).map((s) => s.id))
  return [...shots].reverse().find((s) => s.scene_id !== null && earlier.has(s.scene_id)) ?? null
}

// ---- Outline -----------------------------------------------------------------------------

type OutlineScene = {
  title: string
  summary: string
  location: string
  time_of_day: string
  element_names: string[]
  seconds: number
}

function parseOutlineScenes(raw: unknown): OutlineScene[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      title: typeof v.title === 'string' ? v.title.trim() : '',
      summary: typeof v.summary === 'string' ? v.summary.trim() : '',
      location: typeof v.location === 'string' ? v.location.trim() : '',
      time_of_day: typeof v.time_of_day === 'string' ? v.time_of_day.trim() : '',
      element_names: Array.isArray(v.element_names)
        ? v.element_names.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim())
        : [],
      seconds: typeof v.seconds === 'number' ? v.seconds : NaN,
    }))
    .filter((s) => s.title !== '' || s.summary !== '')
}

/** The outline's element names by scene position, from the claim's stored payload. */
async function storedOutlineElementNames(supabase: Client, generationId: string | null): Promise<Map<number, string[]>> {
  const names = new Map<number, string[]>()
  if (!generationId) return names
  const { data } = await supabase.from('generations').select('payload').eq('id', generationId).maybeSingle()
  parseOutlineScenes((data?.payload as { scenes?: unknown } | null)?.scenes).forEach((s, i) => names.set(i, s.element_names))
  return names
}

async function writeOutline(params: {
  supabase: Client
  gateway: ClaudeGateway
  run: { id: string; generation_id: string | null; message_id: string | null }
  project: ProjectForRun
  tier: DurationConfig
  model: VideoModelConfig
  usageBase: Omit<Parameters<typeof reserveUsage>[0], 'model' | 'quotedCost' | 'quotedBreakdown'>
}): Promise<{ ok: true; elementNames: Map<number, string[]>; costUsd: number } | { ok: false; refused?: boolean }> {
  const { supabase, gateway, run, project, tier, model, usageBase } = params
  const projectId = usageBase.projectId
  if (!run.generation_id) return { ok: false }

  // RECOVER: a stored outline was paid for - replay it, never re-call.
  const { data: generation } = await supabase.from('generations').select('payload').eq('id', run.generation_id).maybeSingle()
  let input: unknown = generation?.payload ?? null
  let outlineCostUsd = 0
  if (input !== null) {
    console.warn(`[shots] run ${run.id}: recovering a stored outline - skipping a new Claude call`)
  } else {
    let usageId: string | null = null
    let breakdown: UsageBreakdown | null = null
    let stopReason: string | null = null
    let caught: unknown = null
    let costUsd = 0
    try {
      const dynamicBlock = buildOutlineDynamicBlock(project, tier.targetSeconds)
      const userMessage = 'Plan the scenes now.'
      const { estimatedCost, quotedBreakdown } = quoteClaudeCall({
        model: modelsConfig.shotOutline.model,
        estimatedInputTokens: estimateInputTokens({ texts: [SHOT_OUTLINE_SYSTEM_PROMPT_V1, dynamicBlock, userMessage], tools: [WRITE_OUTLINE_TOOL] }),
        maxTokens: modelsConfig.shotOutline.maxTokens,
      })
      await assertWithinAllowance({ supabase, userId: usageBase.userId, quotedCost: estimatedCost })
      usageId = (await reserveUsage({ ...usageBase, model: modelsConfig.shotOutline.model, quotedCost: estimatedCost, quotedBreakdown })).usageId
      const { message, stopReason: sr, requestId } = await gateway.createMessage({
        model: modelsConfig.shotOutline.model,
        max_tokens: modelsConfig.shotOutline.maxTokens,
        system: [
          { type: 'text', text: SHOT_OUTLINE_SYSTEM_PROMPT_V1, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: dynamicBlock },
        ],
        tools: [WRITE_OUTLINE_TOOL],
        tool_choice: { type: 'tool', name: 'write_outline' },
        messages: [{ role: 'user', content: userMessage }],
        ...claudeReasoningParams(modelsConfig.shotOutline),
      })
      breakdown = message.usage
      stopReason = sr
      console.warn(`[shots] outline stopReason=${sr} requestId=${requestId} outputTokens=${message.usage?.output_tokens}`)
      // Before reading content: a refused outline is never persisted.
      throwIfRefused({ message, stopReason: sr })
      const block = message.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'write_outline'
      )
      if (!block) throw new Error('Claude did not return an outline')
      if (sr === 'max_tokens') throw new Error('The outline was cut short')
      // PERSIST before any scene row is written.
      const { error: persistError } = await persistGenerationPayload(supabase, run.generation_id, block.input as Json)
      if (persistError) throw new Error(`The outline could not be saved safely (${persistError})`)
      input = block.input
    } catch (err) {
      caught = err
    } finally {
      if (usageId) {
        costUsd = await settleUsage({
          supabase,
          usageId,
          provider: 'anthropic',
          model: modelsConfig.shotOutline.model,
          status: settledStatus(breakdown, stopReason),
          breakdown,
          stopReason,
          error: caught,
        })
        await supabase.from('shot_runs').update({ outline_cost_usd: costUsd, updated_at: new Date().toISOString() }).eq('id', run.id)
        outlineCostUsd = costUsd
      }
    }
    if (caught) {
      console.error(`[shots] run ${run.id}: outline failed`, caught)
      return { ok: false, refused: caught instanceof ClaudeRefusalError }
    }
  }

  const outline = input as { title?: unknown; message?: unknown; video_type?: unknown; scenes?: unknown; style?: unknown }
  const parsed = parseOutlineScenes(outline.scenes)
  if (parsed.length === 0) {
    console.error(`[shots] run ${run.id}: the outline had no usable scenes`)
    await persistGenerationPayload(supabase, run.generation_id, null)
    return { ok: false }
  }
  const fitted = fitOutlineSeconds(
    parsed.map((s) => s.seconds),
    { minSec: tier.targetSecondsMin, maxSec: tier.targetSecondsMax, targetSec: tier.targetSeconds },
    videoModelBounds(model).min
  )
  if (fitted.rescaled) {
    console.warn(
      `[shots] outline rescaled project=${projectId} planned=${parsed.reduce((a, s) => a + (s.seconds || 0), 0)} fitted=${fitted.seconds.reduce((a, b) => a + b, 0)} scenes=${parsed.length}->${fitted.kept}`
    )
  }
  const kept = parsed.slice(0, fitted.kept)

  // Replace semantics, as before: the payload is durable, so the old shot list and scenes
  // go now. Elements are project-level and kept - re-matched by name, reference images and
  // all. shot_elements and dialogue cascade with their shots.
  const { error: deleteShotsError } = await supabase.from('shots').delete().eq('project_id', projectId)
  const { error: deleteScenesError } = deleteShotsError
    ? { error: deleteShotsError }
    : await supabase.from('scenes').delete().eq('project_id', projectId)
  if (deleteShotsError || deleteScenesError) {
    console.error(`[shots] run ${run.id}: could not clear the previous shot list`)
    return { ok: false }
  }
  const now = new Date().toISOString()
  const { error: scenesError } = await supabase.from('scenes').insert(
    kept.map((s, position) => ({
      project_id: projectId,
      position,
      title: s.title || `Scene ${position + 1}`,
      summary: s.summary || null,
      location: s.location || null,
      time_of_day: s.time_of_day || null,
      target_seconds: fitted.seconds[position],
      created_at: now,
      updated_at: now,
    }))
  )
  if (scenesError) {
    console.error(`[shots] run ${run.id}: could not write the scenes`, scenesError.message)
    return { ok: false }
  }
  await supabase.from('shot_runs').update({ total_scenes: kept.length, updated_at: now }).eq('id', run.id)

  // At most one style: the tool-use API can't express maxItems.
  const style = (Array.isArray(outline.style) ? outline.style : []).find(
    (v): v is { name: string; description: string } =>
      typeof v === 'object' && v !== null && typeof v.name === 'string' && v.name.trim() !== '' && typeof v.description === 'string'
  )
  if (style) {
    try {
      const resolver = await ElementResolver.load(supabase, projectId)
      await resolver.resolve(style.name, 'style', style.description)
    } catch (err) {
      console.error(`[shots] run ${run.id}: could not save the style`, err)
    }
  }
  // Guarded: only while the user hasn't set a title since creation.
  const title = typeof outline.title === 'string' ? outline.title.trim().slice(0, 60) || null : null
  if (title && project.title === null) {
    await supabase.from('projects').update({ title, updated_at: now }).eq('id', projectId).is('title', null)
  }
  // Guarded: only while the user left video_type on auto-detect.
  const videoType = sanitizeEnum(outline.video_type, CLASSIFIABLE_VIDEO_TYPES)
  if (videoType && project.video_type === 'auto') {
    await supabase.from('projects').update({ video_type: videoType, updated_at: now }).eq('id', projectId).eq('video_type', 'auto')
  }
  const message = typeof outline.message === 'string' ? outline.message.trim() : ''
  if (message) await supabase.from('messages').insert({ project_id: projectId, role: 'assistant', content: message })

  return { ok: true, elementNames: new Map(kept.map((s, i) => [i, s.element_names])), costUsd: outlineCostUsd }
}
