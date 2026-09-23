import sharp from 'sharp'
import type { createClient } from '@/lib/supabase/server'
import type { Json, Tables } from '@/lib/database.types'
// Type-only, for the same reason as every other paid route's logic.ts: the route injects
// the real functions, so this file adds no service-role import to a plain-Node test.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import type { mintAttemptId as mintAttemptIdType, recordFixedSpend as recordFixedSpendType } from '@/lib/credits/ledger'
import type { ImageGateway } from '@/lib/images/gateway'
import { creditsFor } from '@/lib/config/credits'
import { ASPECT_RATIOS, type AspectRatio } from '@/lib/config/enums'
import { modelsConfig } from '@/lib/config/models'
import {
  CONTINUATION_CHAIN_LIMIT,
  IMAGE_CONCURRENCY,
  IMAGE_STALE_AFTER_MS,
  RUN_TIME_BUDGET_MS,
  STORYBOARD_IMAGE_SIZES,
  STORYBOARD_WEBP_QUALITY,
} from '@/lib/config/storyboard'
import {
  claimGeneration,
  isLiveClaim,
  listQueuedGenerations,
  markGenerationStarted,
  peekGenerationPayload,
  persistGenerationPayload,
  settleGeneration,
} from '@/lib/generations/claim'
import { assertWithinAllowance, reserveUsage, settleUsage } from '@/lib/usage'
import { estimateInputTokens, quoteOpenAiImageCall } from '@/lib/usage/quote'
import type { UsageBreakdown } from '@/lib/config/pricing'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type GenerationRow = Tables<'generations'>

const STEP = 'storyboard' as const
const OPERATION = 'generate_image' as const

// ---------------------------------------------------------------------------------------
// Request: validate -> gate -> claim. Runs with the user's own (cookie) client, before
// anything is scheduled. Nothing here calls a provider.
// ---------------------------------------------------------------------------------------

export type ImagesRequestResult =
  | {
      ok: true
      status: 202
      data: {
        /** Generation ids the background run will work through, in request order. */
        generationIds: string[]
        claimed: string[]
        notGenerated: string[]
        inFlight: string[]
      }
    }
  | { ok: false; status: 400 | 404 | 422 | 500; error: string; shotIds?: string[] }
  | { ok: false; status: 402; error: string; requiredCredits: number; balanceCredits: number }

function hasPrompt(value: string | null): boolean {
  return value !== null && value.trim() !== ''
}

/**
 * The user's live storyboard-image claims across every project - the credits already
 * committed to images that haven't settled yet. Counting them is what stops one batch
 * (or a second tab) spending the same balance twice.
 */
async function countLiveImageClaims(supabase: SupabaseServerClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('generations')
    .select('state, started_at, queued_at, projects!inner(user_id)')
    .eq('projects.user_id', userId)
    .eq('step', STEP)
    .eq('operation', OPERATION)
    .eq('state', 'generating')
  if (error) throw new Error(`countLiveImageClaims failed: ${error.message}`)
  const now = Date.now()
  return (data ?? []).filter((row) => isLiveClaim(row, OPERATION, now)).length
}

export async function runImagesRequest(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  shotIds: string[]
  getBalance: typeof getBalanceType
  ensureSignupGrant: typeof ensureSignupGrantType
}): Promise<ImagesRequestResult> {
  const { supabase, projectId, userId, shotIds, getBalance, ensureSignupGrant } = params

  // fal is selectable in config but has no image gateway yet - refuse before anything is
  // written, rather than claiming shots that can only fail.
  if (modelsConfig.storyboardImages.provider !== 'openai') {
    return { ok: false, status: 500, error: 'Storyboard image provider is not implemented.' }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!project) return { ok: false, status: 404, error: 'Project not found' }

  const { data: shots, error: shotsError } = await supabase
    .from('shots')
    .select('id, image_prompt')
    .eq('project_id', projectId)
    .in('id', shotIds)
  if (shotsError) return { ok: false, status: 500, error: shotsError.message }
  if ((shots ?? []).length !== shotIds.length) {
    return { ok: false, status: 400, error: 'Unknown shot for this project' }
  }

  // A shot with no image prompt can't be drawn - that is a bug upstream, refused here as
  // the last of three layers (Continue is disabled, the advance route refuses).
  const withoutPrompt = (shots ?? []).filter((s) => !hasPrompt(s.image_prompt)).map((s) => s.id)
  if (withoutPrompt.length > 0) {
    return { ok: false, status: 422, error: 'Some shots have no image prompt', shotIds: withoutPrompt }
  }

  // Shots already held by a live run are reported, never re-claimed or re-charged.
  const inFlight: string[] = []
  const candidates: string[] = []
  for (const shotId of shotIds) {
    const peek = await peekGenerationPayload(supabase, {
      projectId,
      step: STEP,
      operation: OPERATION,
      shotId,
      elementId: null,
    })
    if (peek.error) return { ok: false, status: 500, error: peek.error }
    if (peek.heldByLiveRun) inFlight.push(shotId)
    else candidates.push(shotId)
  }

  if (candidates.length === 0) {
    return { ok: true, status: 202, data: { generationIds: [], claimed: [], notGenerated: [], inFlight } }
  }

  // THE GATE - before any claim. Effective balance = ledger balance minus everything this
  // user already has committed to in-flight images.
  const price = creditsFor({ step: STEP, operation: OPERATION, quantity: 1 })
  await ensureSignupGrant(userId)
  const balance = await getBalance(userId)
  const committed = (await countLiveImageClaims(supabase, userId)) * price
  const effective = balance - committed
  const affordable = Math.max(0, Math.floor(effective / price))

  if (affordable === 0) {
    return {
      ok: false,
      status: 402,
      error: `Not enough credits: each image costs ${price}, available balance is ${Math.max(0, effective)}.`,
      requiredCredits: price * candidates.length,
      balanceCredits: Math.max(0, effective),
    }
  }

  // Claim in request order until the affordable count is reached; the rest stay
  // unclaimed and read as "not generated". A claim lost to a concurrent run doesn't use
  // up budget - it's reported as in flight.
  const claimed: string[] = []
  const generationIds: string[] = []
  const notGenerated: string[] = []
  for (const shotId of candidates) {
    if (claimed.length >= affordable) {
      notGenerated.push(shotId)
      continue
    }
    const claim = await claimGeneration({
      supabase,
      identity: { projectId, step: STEP, operation: OPERATION, shotId, elementId: null },
      retry: true,
      queued: true,
    })
    if (claim.outcome === 'claimed') {
      claimed.push(shotId)
      generationIds.push(claim.generation.id)
    } else if (claim.outcome === 'blocked') {
      inFlight.push(shotId)
    } else {
      console.error(`[images] claim failed for shot ${shotId}:`, claim.message)
      notGenerated.push(shotId)
    }
  }

  return { ok: true, status: 202, data: { generationIds, claimed, notGenerated, inFlight } }
}

// ---------------------------------------------------------------------------------------
// Continuation: a background run handing its unreached claims to a fresh run. Resumes
// existing claims only - no gate, no claim - scoped to the user and project the original
// request already verified.
// ---------------------------------------------------------------------------------------

export type ContinuationPayload = {
  userId: string
  projectId: string
  generationIds: string[]
  chainDepth: number
}

export function parseContinuationPayload(raw: unknown, projectId: string): ContinuationPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  if (typeof v.userId !== 'string' || v.userId === '') return null
  if (v.projectId !== projectId) return null
  if (typeof v.chainDepth !== 'number' || !Number.isInteger(v.chainDepth) || v.chainDepth < 1) return null
  if (!Array.isArray(v.generationIds) || !v.generationIds.every((id) => typeof id === 'string' && id !== '')) {
    return null
  }
  return {
    userId: v.userId,
    projectId,
    generationIds: v.generationIds as string[],
    chainDepth: v.chainDepth,
  }
}

export async function runImagesContinuation(params: {
  supabase: SupabaseServerClient // service role
  payload: ContinuationPayload
}): Promise<{ ok: true; generationIds: string[] } | { ok: false; status: 404 | 500; error: string }> {
  const { supabase, payload } = params

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', payload.projectId)
    .eq('user_id', payload.userId)
    .maybeSingle()
  if (!project) return { ok: false, status: 404, error: 'Project not found' }

  const { generations, error } = await listQueuedGenerations(supabase, {
    projectId: payload.projectId,
    step: STEP,
    operation: OPERATION,
    generationIds: payload.generationIds,
  })
  if (error) return { ok: false, status: 500, error }

  // Keep the hand-off's order; anything no longer queued (settled, started, reclaimed) is
  // simply dropped - it's owned elsewhere now.
  const queued = new Set(generations.map((g) => g.id))
  return { ok: true, generationIds: payload.generationIds.filter((id) => queued.has(id)) }
}

// ---------------------------------------------------------------------------------------
// Worker: the background run. Service-role client, so every read and write below is
// scoped explicitly by project (and the project by user, at load).
// ---------------------------------------------------------------------------------------

export type ImageWorkerDeps = {
  supabase: SupabaseServerClient // service role
  gateway: ImageGateway
  mintAttemptId: typeof mintAttemptIdType
  recordFixedSpend: typeof recordFixedSpendType
  /** Hands unreached claims to a fresh run. Resolves true only when that run accepted them. */
  continueRun: (payload: ContinuationPayload) => Promise<boolean>
  /** Test seams - production always uses the storyboard.ts values. */
  runTimeBudgetMs?: number
  chainLimit?: number
  concurrency?: number
}

type ShotOutcome = 'succeeded' | 'failed' | 'skipped'

export type ImageWorkerResult = {
  outcomes: Record<string, ShotOutcome>
  /** Generation ids handed to a continuation run. */
  continued: string[]
  /** Generation ids never reached and settled failed (chain limit, or hand-off refused). */
  abandoned: string[]
}

type StoredImagePayload = { path: string; attemptId: string }

function readStoredPayload(payload: Json | null): StoredImagePayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  return typeof p.path === 'string' && typeof p.attemptId === 'string' ? { path: p.path, attemptId: p.attemptId } : null
}

export function storyboardImagePath(userId: string, projectId: string, shotId: string, attemptId: string): string {
  return `${userId}/${projectId}/images/${shotId}/${attemptId}.webp`
}

/**
 * The bound elements' reference images, as input to the edit endpoint. Style is never
 * shot-bound, so it's never here. A reference whose object can't be downloaded is left
 * out with a warning rather than failing the shot - a permanently missing object would
 * otherwise make the shot impossible to generate.
 */
async function loadReferenceImages(supabase: SupabaseServerClient, shotId: string): Promise<Buffer[]> {
  const { data, error } = await supabase
    .from('shot_elements')
    .select('elements(reference_image_path, deleted_at)')
    .eq('shot_id', shotId)
  if (error) throw new Error(`Failed to load bound elements: ${error.message}`)

  type BoundElement = { reference_image_path: string | null; deleted_at: string | null }
  const paths = (data ?? [])
    .flatMap((row) => {
      const el = row.elements as BoundElement | BoundElement[] | null
      return el === null ? [] : Array.isArray(el) ? el : [el]
    })
    .filter((el) => el.deleted_at === null && el.reference_image_path !== null)
    .map((el) => el.reference_image_path as string)

  const buffers: Buffer[] = []
  for (const path of paths) {
    const { data: blob, error: downloadError } = await supabase.storage.from('artifacts').download(path)
    if (downloadError || !blob) {
      console.warn(`[images] reference ${path} could not be downloaded; generating without it`)
      continue
    }
    buffers.push(Buffer.from(await blob.arrayBuffer()))
  }
  return buffers
}

// The one write that stores a new image - and the only place image_stale is cleared.
async function linkShotImage(
  supabase: SupabaseServerClient,
  projectId: string,
  shotId: string,
  path: string
): Promise<string | null> {
  const { error } = await supabase
    .from('shots')
    .update({ image_path: path, image_stale: false, updated_at: new Date().toISOString() })
    .eq('id', shotId)
    .eq('project_id', projectId)
  return error?.message ?? null
}

async function processShot(
  deps: ImageWorkerDeps,
  ctx: { userId: string; projectId: string; size: string },
  generationId: string
): Promise<ShotOutcome> {
  const { supabase, gateway } = deps
  const { userId, projectId, size } = ctx

  const { data: queuedRow } = await supabase
    .from('generations')
    .select('*')
    .eq('id', generationId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (!queuedRow || queuedRow.state !== 'generating' || queuedRow.queued_at === null || queuedRow.shot_id === null) {
    return 'skipped'
  }

  // Take the claim from queued to started. Losing this means another run owns it now.
  const start = await markGenerationStarted(supabase, generationId, queuedRow.queued_at)
  if (!start.started || !start.generation) return 'skipped'
  const generation: GenerationRow = start.generation
  const shotId = queuedRow.shot_id
  const startedAt = Date.now()

  const { model, quality } = modelsConfig.storyboardImages
  let outcome: { ok: boolean; error: string | null } = { ok: false, error: 'Unexpected error' }
  let usageId: string | null = null
  let measured: UsageBreakdown | null = null
  let caughtError: unknown = null
  let chargeAttemptId: string | null = null
  let shotKey: string | null = null

  try {
    const { data: shot } = await supabase
      .from('shots')
      .select('id, shot_key, image_prompt')
      .eq('id', shotId)
      .eq('project_id', projectId)
      .maybeSingle()
    if (!shot) {
      outcome = { ok: false, error: 'Shot not found' }
      return 'failed'
    }
    shotKey = shot.shot_key

    // RECOVER. A stored payload means the provider was already paid and the image is
    // already in storage: relink it, never call again. Charged under the attempt id it
    // was generated with, so a crash between PERSIST and the ledger write can neither
    // double-charge nor leave a delivered image uncharged.
    const stored = readStoredPayload(generation.payload)
    if (stored) {
      const linkError = await linkShotImage(supabase, projectId, shotId, stored.path)
      if (linkError) {
        outcome = { ok: false, error: linkError }
        return 'failed'
      }
      chargeAttemptId = stored.attemptId
      outcome = { ok: true, error: null }
      return 'succeeded'
    }

    if (!hasPrompt(shot.image_prompt)) {
      outcome = { ok: false, error: 'Shot has no image prompt' }
      return 'failed'
    }
    const prompt = shot.image_prompt!.trim()
    const attemptId = deps.mintAttemptId()

    const references = await loadReferenceImages(supabase, shotId)
    const { estimatedCost, quotedBreakdown } = quoteOpenAiImageCall({
      model,
      size,
      quality,
      estimatedInputTokens: estimateInputTokens({ texts: [prompt], tools: [] }),
      referenceCount: references.length,
    })

    await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })
    const reserved = await reserveUsage({
      supabase,
      userId,
      projectId,
      generationId: generation.id,
      shotId,
      step: STEP,
      operation: OPERATION,
      provider: 'openai',
      model,
      quotedCost: estimatedCost,
      quotedBreakdown,
    })
    usageId = reserved.usageId

    // ONE call, no retry.
    const { imageBuffer, usage } = await gateway.generateStoryboardImage({ prompt, model, quality, size, references })
    measured = {
      input_tokens: usage.input_tokens,
      image_input_tokens: usage.image_input_tokens,
      output_tokens: usage.output_tokens,
    }

    const webp = await sharp(imageBuffer).webp({ quality: STORYBOARD_WEBP_QUALITY }).toBuffer()
    // Every attempt gets its own object; nothing is ever overwritten or removed.
    const path = storyboardImagePath(userId, projectId, shotId, attemptId)
    const { error: uploadError } = await supabase.storage
      .from('artifacts')
      .upload(path, webp, { contentType: 'image/webp', upsert: false })
    if (uploadError) {
      outcome = { ok: false, error: uploadError.message }
      return 'failed'
    }

    // PERSIST before the derived write, so a crash from here on is recovered for free.
    const { error: persistError } = await persistGenerationPayload(supabase, generation.id, {
      path,
      attemptId,
    } as Json)
    if (persistError) {
      outcome = { ok: false, error: `Image generated but could not be saved safely (${persistError})` }
      return 'failed'
    }

    // Past the stale window this claim already reads as failed (and uncharged) to the
    // user, and may have been reclaimed. Don't contradict that: leave the image for a
    // later RECOVER, which relinks and charges it then.
    if (Date.now() - startedAt > IMAGE_STALE_AFTER_MS) {
      outcome = { ok: false, error: 'Finished after the stale window' }
      return 'failed'
    }

    const linkError = await linkShotImage(supabase, projectId, shotId, path)
    if (linkError) {
      outcome = { ok: false, error: linkError }
      return 'failed'
    }

    chargeAttemptId = attemptId
    outcome = { ok: true, error: null }
    return 'succeeded'
  } catch (err) {
    caughtError = err
    console.error(`[images] shot ${shotId} failed`, err)
    outcome = { ok: false, error: err instanceof Error ? err.message : 'Unexpected error' }
    return 'failed'
  } finally {
    // SETTLE. Failure keeps any payload for RECOVER; success clears it.
    const { error: settleError } = await settleGeneration(supabase, generation.id, {
      success: outcome.ok,
      error: outcome.ok ? null : outcome.error,
    })
    if (settleError) console.error(`[images] SETTLE failed for generation ${generation.id}`, settleError)

    if (usageId) {
      await settleUsage({
        supabase,
        usageId,
        provider: 'openai',
        model,
        status: measured !== null ? 'succeeded' : 'failed',
        breakdown: measured,
        error: outcome.ok ? null : caughtError,
      })
    }

    // Ledger: success only - a failed image is absorbed. Never throws to the run.
    if (outcome.ok && chargeAttemptId) {
      try {
        await deps.recordFixedSpend({
          userId,
          step: STEP,
          operation: OPERATION,
          quantity: 1,
          attemptId: chargeAttemptId,
          projectId,
          messageId: null,
          shotKey,
        })
      } catch (ledgerError) {
        console.error(`[images] ledger write failed for generation ${generation.id}`, ledgerError)
      }
    }
  }
}

export async function runImageWorker(
  deps: ImageWorkerDeps,
  params: { userId: string; projectId: string; generationIds: string[]; chainDepth: number }
): Promise<ImageWorkerResult> {
  const { supabase } = deps
  const { userId, projectId, generationIds, chainDepth } = params
  const budget = deps.runTimeBudgetMs ?? RUN_TIME_BUDGET_MS
  const chainLimit = deps.chainLimit ?? CONTINUATION_CHAIN_LIMIT
  const concurrency = deps.concurrency ?? IMAGE_CONCURRENCY
  const runStart = Date.now()

  const result: ImageWorkerResult = { outcomes: {}, continued: [], abandoned: [] }

  const { data: project } = await supabase
    .from('projects')
    .select('aspect_ratio')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  const aspectRatio = project?.aspect_ratio
  if (!aspectRatio || !(ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    // Nothing can be generated without a size - release every claim, uncharged.
    await abandon(supabase, generationIds, 'Project not found or has no valid aspect ratio')
    result.abandoned = [...generationIds]
    return result
  }
  const size = STORYBOARD_IMAGE_SIZES[aspectRatio as AspectRatio]

  // A small pool: each lane takes the next id until the list is exhausted or the run's
  // time budget is spent. What's left is handed on.
  let next = 0
  const lanes = Array.from({ length: Math.min(concurrency, generationIds.length) }, async () => {
    while (next < generationIds.length && Date.now() - runStart < budget) {
      const id = generationIds[next++]
      result.outcomes[id] = await processShot(deps, { userId, projectId, size }, id)
    }
  })
  await Promise.all(lanes)

  const remaining = generationIds.slice(next)
  if (remaining.length === 0) return result

  if (chainDepth < chainLimit) {
    let accepted = false
    try {
      accepted = await deps.continueRun({ userId, projectId, generationIds: remaining, chainDepth: chainDepth + 1 })
    } catch (err) {
      console.error('[images] continuation hand-off failed', err)
    }
    if (accepted) {
      result.continued = remaining
      return result
    }
  }

  await abandon(supabase, remaining, 'Not reached before the run ended')
  result.abandoned = remaining
  return result
}

// Settles never-started claims as failed. Nothing was reserved or charged for them.
async function abandon(supabase: SupabaseServerClient, generationIds: string[], reason: string): Promise<void> {
  for (const id of generationIds) {
    const { error } = await settleGeneration(supabase, id, { success: false, error: reason })
    if (error) console.error(`[images] failed to release claim ${id}`, error)
  }
}
