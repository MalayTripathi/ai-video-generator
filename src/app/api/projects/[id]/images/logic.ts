import sharp from 'sharp'
import type { createClient } from '@/lib/supabase/server'
import type { Json, Tables } from '@/lib/database.types'
// Type-only, for the same reason as every other paid route's logic.ts: the route injects
// the real functions, so this file adds no service-role import to a plain-Node test.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import type { mintAttemptId as mintAttemptIdType, recordFixedSpend as recordFixedSpendType } from '@/lib/credits/ledger'
import type { ImageGateway } from '@/lib/images/gateway'
import { creditsFor, type ImagePriceKey } from '@/lib/config/credits'
import { ASPECT_RATIOS, type AspectRatio } from '@/lib/config/enums'
import { IMAGE_MODELS } from '@/lib/config/models'
import { pricedAspectRatio, storyboardImagePriceKey, usableReferencePaths } from '@/lib/images/price-key'
import {
  CONTINUATION_CHAIN_LIMIT,
  IMAGE_CONCURRENCY,
  IMAGE_HANDOFF_TIMEOUT_MS,
  IMAGE_STALE_AFTER_MS,
  RUN_TIME_BUDGET_MS,
  STORYBOARD_THUMB_WIDTH,
  STORYBOARD_WEBP_QUALITY,
} from '@/lib/config/storyboard'
import {
  claimGeneration,
  isLiveClaim,
  listQueuedGenerations,
  markGenerationStarted,
  peekGenerationPayload,
  persistGenerationPayload,
  releaseQueuedGenerations,
  settleGeneration,
} from '@/lib/generations/claim'
import { assertWithinAllowance, reserveUsage, settleUsage } from '@/lib/usage'
import { liveAudioCommittedCredits } from '@/lib/voiceover/committed'
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

function isAspectRatio(value: string | null): value is AspectRatio {
  return value !== null && (ASPECT_RATIOS as readonly string[]).includes(value)
}

/** One Storyboard frame's credits, priced on its project's settings and its shot's references. */
export function storyboardImageCredits(key: ImagePriceKey): number {
  return creditsFor({ step: STEP, operation: OPERATION, quantity: 1, image: key })
}

/**
 * The credits the user has already committed to storyboard images that haven't settled,
 * across every project - each live claim priced on its own project's quality and aspect
 * ratio and its shot's references. Counting them is what stops one batch (or a second
 * tab) spending the same balance twice.
 */
export async function liveImageCommittedCredits(supabase: SupabaseServerClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('generations')
    .select(
      'state, started_at, queued_at, projects!inner(user_id, aspect_ratio, image_model, image_quality), shots(shot_elements(elements(reference_image_path, deleted_at)))'
    )
    .eq('projects.user_id', userId)
    .eq('step', STEP)
    .eq('operation', OPERATION)
    .eq('state', 'generating')
  if (error) throw new Error(`liveImageCommittedCredits failed: ${error.message}`)
  const now = Date.now()
  let committed = 0
  // Both embeds are to-one (generations -> projects, generations -> shots); the typed client
  // can't infer that through the nested embed, so the row is named here.
  type LiveClaimRow = {
    state: string
    started_at: string | null
    queued_at: string | null
    projects: { aspect_ratio: string | null; image_model: string; image_quality: string }
    shots: { shot_elements: Parameters<typeof usableReferencePaths>[0] } | null
  }
  for (const row of (data ?? []) as unknown as LiveClaimRow[]) {
    if (!isLiveClaim(row, OPERATION, now)) continue
    const project = row.projects
    committed += storyboardImageCredits(
      storyboardImagePriceKey({
        aspectRatio: pricedAspectRatio(project.aspect_ratio),
        imageModel: project.image_model,
        imageQuality: project.image_quality,
        referenceCount: usableReferencePaths(row.shots?.shot_elements).length,
      })
    )
  }
  return committed
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

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, aspect_ratio, image_model, image_quality')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  // A failed read is a server error, never a 404 - only a missing row is.
  if (projectError) return { ok: false, status: 500, error: projectError.message }
  if (!project) return { ok: false, status: 404, error: 'Project not found' }
  const aspectRatio = pricedAspectRatio(project.aspect_ratio)

  const { data: shots, error: shotsError } = await supabase
    .from('shots')
    .select('id, image_prompt, shot_elements(elements(reference_image_path, deleted_at))')
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
  // user already has committed to in-flight images and voiceovers. Each frame is priced on
  // the project's quality and its own shot's references; the charge itself is settled on
  // the references the worker actually sends.
  const shotById = new Map((shots ?? []).map((s) => [s.id, s]))
  const priceOf = (shotId: string): number =>
    storyboardImageCredits(
      storyboardImagePriceKey({
        aspectRatio,
        imageModel: project.image_model,
        imageQuality: project.image_quality,
        referenceCount: usableReferencePaths(shotById.get(shotId)?.shot_elements).length,
      })
    )
  await ensureSignupGrant(userId)
  const balance = await getBalance(userId)
  const committed =
    (await liveImageCommittedCredits(supabase, userId)) + (await liveAudioCommittedCredits(supabase, userId))
  const effective = balance - committed
  const firstPrice = priceOf(candidates[0])

  if (effective < firstPrice) {
    return {
      ok: false,
      status: 402,
      error: `Not enough credits: the next image costs ${firstPrice}, available balance is ${Math.max(0, effective)}.`,
      requiredCredits: candidates.reduce((sum, shotId) => sum + priceOf(shotId), 0),
      balanceCredits: Math.max(0, effective),
    }
  }

  // Claim in request order while the budget covers the next shot; the rest stay unclaimed
  // and read as "not generated". A claim lost to a concurrent run doesn't use up budget -
  // it's reported as in flight.
  const claimed: string[] = []
  const generationIds: string[] = []
  const notGenerated: string[] = []
  let budget = effective
  for (const shotId of candidates) {
    const price = priceOf(shotId)
    if (price > budget) {
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
      budget -= price
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

// A background run calling the images route to continue itself sends this header. It
// carries no user session, so the shared secret is its only credential.
export const INTERNAL_SECRET_HEADER = 'x-images-internal-secret'

/**
 * The hand-off a run uses to pass its unreached shots to a fresh invocation of the images
 * route. Resolves true only on the continuation's 202. A missing secret is a deploy
 * misconfiguration: it is logged as an error and refused, so the worker releases the
 * shots failed and retryable rather than leaving them queued.
 */
export function createContinueRun(params: {
  origin: string
  secret: string | undefined
  /** The deployment protection bypass (continuation.ts deploymentBypassHeaders). */
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): (payload: ContinuationPayload) => Promise<boolean> {
  return async (payload) => {
    if (!params.secret) {
      console.error(
        `[images] INTERNAL_CONTINUATION_SECRET is not set - ${payload.generationIds.length} shot(s) of project ${payload.projectId} cannot continue past this run and are released for retry`
      )
      return false
    }
    const res = await (params.fetchImpl ?? fetch)(`${params.origin}/api/projects/${payload.projectId}/images`, {
      method: 'POST',
      headers: { ...params.headers, 'Content-Type': 'application/json', [INTERNAL_SECRET_HEADER]: params.secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(params.timeoutMs ?? IMAGE_HANDOFF_TIMEOUT_MS),
    })
    if (res.status !== 202) console.error(`[images] continuation refused with status ${res.status}`)
    return res.status === 202
  }
}

export async function runImagesContinuation(params: {
  supabase: SupabaseServerClient // service role
  payload: ContinuationPayload
}): Promise<{ ok: true; generationIds: string[] } | { ok: false; status: 404 | 500; error: string }> {
  const { supabase, payload } = params

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id')
    .eq('id', payload.projectId)
    .eq('user_id', payload.userId)
    .maybeSingle()
  // A failed read is a server error, never a 404 - only a missing row is.
  if (projectError) return { ok: false, status: 500, error: projectError.message }
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

// `price` is the call actually made, so a RECOVER charges what was paid for. A payload
// written before it existed has none - its RECOVER is priced on the current settings.
type StoredImagePayload = { path: string; attemptId: string; price: ImagePriceKey | null }

function readStoredPayload(payload: Json | null): StoredImagePayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (typeof p.path !== 'string' || typeof p.attemptId !== 'string') return null
  const price = p.price as ImagePriceKey | undefined
  const validPrice =
    typeof price === 'object' && price !== null && typeof price.quality === 'string' && typeof price.referenceCount === 'number'
  return { path: p.path, attemptId: p.attemptId, price: validPrice ? price : null }
}

export function storyboardImagePath(userId: string, projectId: string, shotId: string, attemptId: string): string {
  return `${userId}/${projectId}/images/${shotId}/${attemptId}.webp`
}

// The lane thumbnail sits beside its full image: `{attemptId}.webp` -> `{attemptId}_thumb.webp`.
export function storyboardThumbPath(imagePath: string): string {
  return imagePath.replace(/\.webp$/, '_thumb.webp')
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

  const paths = usableReferencePaths(data)

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
  ctx: { userId: string; projectId: string; aspectRatio: AspectRatio; imageModel: string; imageQuality: string },
  generationId: string
): Promise<ShotOutcome> {
  const { supabase, gateway } = deps
  const { userId, projectId } = ctx

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

  // The project's quality (dev-capped outside production) and the frame's native size.
  const { model, quality, size } = storyboardImagePriceKey({ ...ctx, referenceCount: 0 })
  // The provider follows from the model the registry resolved - never from env.
  const provider = IMAGE_MODELS[model as keyof typeof IMAGE_MODELS].provider
  let outcome: { ok: boolean; error: string | null } = { ok: false, error: 'Unexpected error' }
  let usageId: string | null = null
  let measured: UsageBreakdown | null = null
  let caughtError: unknown = null
  let chargeAttemptId: string | null = null
  let chargePrice: ImagePriceKey | null = null
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
      chargePrice = stored.price ?? { model, quality, size, referenceCount: 0 }
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
    const price: ImagePriceKey = { model, quality, size, referenceCount: references.length }
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
      provider,
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

    // The lane thumbnail. Best-effort: a missing thumbnail falls back to the full image on
    // the page, so its failure is logged and never fails (or un-charges) a drawn frame.
    try {
      const thumb = await sharp(imageBuffer)
        .resize({ width: STORYBOARD_THUMB_WIDTH })
        .webp({ quality: STORYBOARD_WEBP_QUALITY })
        .toBuffer()
      const { error: thumbError } = await supabase.storage
        .from('artifacts')
        .upload(storyboardThumbPath(path), thumb, { contentType: 'image/webp', upsert: false })
      if (thumbError) console.error(`[images] thumbnail upload failed for shot ${shotId}:`, thumbError.message)
    } catch (err) {
      console.error(`[images] thumbnail encode failed for shot ${shotId}:`, err)
    }

    // PERSIST before the derived write, so a crash from here on is recovered for free.
    const { error: persistError } = await persistGenerationPayload(supabase, generation.id, {
      path,
      attemptId,
      price,
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
    chargePrice = price
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
        provider,
        model,
        status: measured !== null ? 'succeeded' : 'failed',
        breakdown: measured,
        error: outcome.ok ? null : caughtError,
      })
    }

    // Ledger: success only - a failed image is absorbed. Never throws to the run.
    if (outcome.ok && chargeAttemptId && chargePrice) {
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
          image: chargePrice,
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
    .select('aspect_ratio, image_model, image_quality')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  const aspectRatio = project?.aspect_ratio ?? null
  if (!project || !isAspectRatio(aspectRatio)) {
    // Nothing can be generated without a size - release every claim, uncharged.
    result.abandoned = await release(supabase, projectId, generationIds, 'Project not found or has no valid aspect ratio')
    return result
  }
  const shotCtx = { userId, projectId, aspectRatio, imageModel: project.image_model, imageQuality: project.image_quality }

  // Passes the unreached ids to a fresh run, or - at the chain limit, or when the hand-off
  // is refused - releases them failed, uncharged and retryable.
  const handOn = async (remaining: string[]): Promise<void> => {
    if (chainDepth < chainLimit) {
      let accepted = false
      try {
        accepted = await deps.continueRun({ userId, projectId, generationIds: remaining, chainDepth: chainDepth + 1 })
      } catch (err) {
        console.error('[images] continuation hand-off failed', err)
      }
      if (accepted) {
        result.continued = remaining
        return
      }
    } else {
      console.warn(`[images] chain limit reached for project ${projectId}; releasing ${remaining.length} unreached shot(s)`)
    }
    result.abandoned = await release(supabase, projectId, remaining, 'Not reached before the run ended')
  }

  // A small pool: each lane takes the next id until the list is exhausted. At the budget
  // the untaken ids are handed on at once, while the lanes drain what's in flight - so the
  // hand-off never waits on a slow shot near the route's maxDuration.
  const state: { next: number; handoff: Promise<void> | null } = { next: 0, handoff: null }
  const takeRemaining = (): string[] => {
    const remaining = generationIds.slice(state.next)
    state.next = generationIds.length
    return remaining
  }
  const timer = setTimeout(() => {
    if (state.next < generationIds.length) state.handoff = handOn(takeRemaining())
  }, budget)

  const lanes = Array.from({ length: Math.min(concurrency, generationIds.length) }, async () => {
    while (state.next < generationIds.length && Date.now() - runStart < budget) {
      const id = generationIds[state.next++]
      result.outcomes[id] = await processShot(deps, shotCtx, id)
    }
  })
  await Promise.all(lanes)
  clearTimeout(timer)

  // The lanes stopped at the budget before the timer fired (a busy event loop).
  if (state.handoff === null && state.next < generationIds.length) state.handoff = handOn(takeRemaining())
  if (state.handoff !== null) await state.handoff
  return result
}

// Releases never-started claims, failed. Nothing was reserved or charged for them. Only
// rows still queued are touched - see releaseQueuedGenerations.
async function release(
  supabase: SupabaseServerClient,
  projectId: string,
  generationIds: string[],
  reason: string
): Promise<string[]> {
  const { released, error } = await releaseQueuedGenerations(supabase, { projectId, generationIds, error: reason })
  if (error) console.error(`[images] failed to release ${generationIds.length} queued claim(s)`, error)
  return released
}
