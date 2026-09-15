import type { createClient } from '@/lib/supabase/server'
import type { Json } from '@/lib/database.types'
import type { ElementType } from '@/lib/config/enums'
import { ImageLiveCallsBlockedError, type ImageGateway } from '@/lib/images/gateway'
import { modelsConfig } from '@/lib/config/models'
import type { UsageBreakdown } from '@/lib/config/pricing'
import { estimateInputTokens, quoteOpenAiImageCall, reserveUsage, settleUsage } from '@/lib/usage'
import { creditsFor, InsufficientCreditsError } from '@/lib/config/credits'
// Type-only: credits/ledger.ts and credits/signup-grant.ts both transitively import
// the service-role Supabase client module, which imports 'server-only' - a VALUE
// import here would crash any test that imports this module directly, same reason
// runShotGeneration/runCameraDerivation's logic.ts files do this for
// recordFixedSpend. ensureSignupGrant is DI'd for the identical reason. getBalance's
// own module (credits/balance.ts) is service-role-free, so it could be a value
// import, but stays type-only here too - this file never calls it directly, only via
// the injected param, same as the other two.
import type { recordFixedSpend } from '@/lib/credits/ledger'
import type { getBalance } from '@/lib/credits/balance'
import type { ensureSignupGrant } from '@/lib/credits/signup-grant'
import {
  claimGeneration,
  persistGenerationPayload,
  settleGeneration,
  type BlockedReason,
} from '@/lib/generations/claim'
import { loadOwnedElement } from '@/lib/elements/write'
import { uploadNormalizedReferenceObject } from '@/lib/elements/reference'
import { markImagePromptsStaleForElementReference } from '@/lib/elements/staleness'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

const SIGNED_URL_EXPIRES_IN_SECONDS = 3600

// error is always the raw diagnostic text (err.message, a Postgres/storage error, etc.)
// - this is what settleGeneration/settleUsage persist, the same way usage.error always
// has. It is never the user-facing copy; a classified 500 additionally carries `code`,
// and mapping code -> safe copy happens only in route.ts, at the boundary where the
// HTTP response is built - never here, and never written to either table.
export type ElementReferenceGenerationResult =
  | { ok: true; status: 200; data: { path: string; url: string } }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; error: string }
  | { ok: false; status: 402; error: string }
  | { ok: false; status: 500; error: string; code?: GenerationFailureCode }

const BLOCKED_REASON_MESSAGES: Partial<Record<BlockedReason, string>> = {
  already_generating: 'A reference image is already generating for this element.',
}

// Classification only - never a message. Anything provider/SDK-shaped (including
// ImageLiveCallsBlockedError, whose message names an env var) must never reach the
// client, but the raw text is exactly what generations.error/usage.error need to keep
// as the diagnostic record - see route.ts's GENERATION_FAILURE_MESSAGES for the copy
// this code maps to on the way out.
export type GenerationFailureCode = 'blocked' | 'provider_error'

export function classifyGenerationFailure(err: unknown): GenerationFailureCode {
  if (err instanceof ImageLiveCallsBlockedError) return 'blocked'
  return 'provider_error'
}

/**
 * Built from the element's own name/description plus the project's style keywords, if
 * a style element exists and isn't the one being generated (generating the style
 * element's own reference would otherwise fold its description into itself twice).
 */
function buildReferencePrompt(
  element: { name: string; description: string | null; type: ElementType },
  styleDescription: string | null
): string {
  const parts = [`Reference image for a ${element.type} named "${element.name}".`]
  if (element.description) parts.push(element.description)
  if (styleDescription) parts.push(`Overall visual style: ${styleDescription}`)
  parts.push('Plain, neutral background. Single clear subject, no text, no watermark.')
  return parts.join(' ')
}

async function loadStyleDescription(
  supabase: SupabaseServerClient,
  projectId: string,
  elementId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('elements')
    .select('id, description')
    .eq('project_id', projectId)
    .eq('type', 'style')
    .is('deleted_at', null)
    .maybeSingle()

  if (!data || data.id === elementId) return null
  return data.description
}

/**
 * Best-effort - the caller's outcome is already decided by the time this runs, so a
 * failure here is logged, never thrown.
 */
async function setElementStatus(supabase: SupabaseServerClient, elementId: string, status: string): Promise<void> {
  const { error } = await supabase.from('elements').update({ status }).eq('id', elementId)
  if (error) {
    console.error(`[elements] Failed to set status=${status} for element ${elementId}:`, error.message)
  }
}

export async function runElementReferenceGeneration(params: {
  gateway: ImageGateway
  supabase: SupabaseServerClient
  projectId: string
  elementId: string
  userId: string
  attemptId: string
  recordFixedSpend: typeof recordFixedSpend
  getBalance: typeof getBalance
  ensureSignupGrant: typeof ensureSignupGrant
}): Promise<ElementReferenceGenerationResult> {
  const { gateway, supabase, projectId, elementId, userId, attemptId, recordFixedSpend, getBalance, ensureSignupGrant } =
    params

  const element = await loadOwnedElement(supabase, elementId, userId)
  if (!element || element.project_id !== projectId) {
    return { ok: false, status: 404, error: 'Element not found' }
  }

  // retry is inert for this operation - OPERATION_POLICY['generate_element_reference']
  // is claimableFrom: {succeeded: 'always', failed: 'always'}, so the flag never
  // actually gates anything here. Passed as `true` for readability only.
  const claim = await claimGeneration({
    supabase,
    identity: {
      projectId,
      step: 'workbench',
      operation: 'generate_element_reference',
      shotId: null,
      elementId,
    },
    retry: true,
  })

  if (claim.outcome === 'error') {
    return { ok: false, status: 500, error: claim.message }
  }
  if (claim.outcome === 'blocked') {
    return { ok: false, status: 409, error: BLOCKED_REASON_MESSAGES[claim.reason] ?? 'This element is busy.' }
  }

  const { generation } = claim

  // RECOVER. A stored payload ({ path }) means OpenAI has already been paid for -
  // relink the element to the already-uploaded object and never call the gateway
  // again. No balance check, no reserveUsage, no ledger write: nothing new is being
  // spent, so a recoverable payload must stay recoverable even if the user's balance
  // has since dropped to zero.
  if (generation.payload !== null) {
    const path = (generation.payload as { path: string }).path
    const oldPath = element.reference_image_path

    const { error: relinkError } = await supabase
      .from('elements')
      .update({ reference_image_path: path, status: 'ready' })
      .eq('id', elementId)

    if (relinkError) {
      await settleGeneration(supabase, generation.id, { success: false, error: relinkError.message })
      return { ok: false, status: 500, error: relinkError.message }
    }

    await markImagePromptsStaleForElementReference(supabase, projectId, elementId, element.type)

    if (oldPath && oldPath !== path) {
      const { error: removeError } = await supabase.storage.from('artifacts').remove([oldPath])
      if (removeError) {
        console.error(`[elements] Failed to remove old reference image ${oldPath}:`, removeError.message)
      }
    }

    const { data: signed, error: signError } = await supabase.storage
      .from('artifacts')
      .createSignedUrl(path, SIGNED_URL_EXPIRES_IN_SECONDS)

    await settleGeneration(supabase, generation.id, { success: true })

    if (signError || !signed) {
      return { ok: false, status: 500, error: signError?.message ?? 'Failed to sign recovered image' }
    }
    return { ok: true, status: 200, data: { path, url: signed.signedUrl } }
  }

  let outcome: ElementReferenceGenerationResult = { ok: false, status: 500, error: 'Generation did not complete' }
  let usageId: string | null = null
  let measuredBreakdown: UsageBreakdown | null = null
  let caughtError: unknown = null
  // Tracks whether the element was ever flipped into 'generating' - only then does a
  // failure need to flip it back to 'failed' in the finally block below. A 402 from
  // the balance gate above never reaches this, so it never shows a spinner for a
  // request that was refused before spending anything.
  let enteredGeneratingState = false

  try {
    const required = creditsFor({ step: 'workbench', operation: 'generate_element_reference', quantity: 1 })
    // Defensive: AppLayout already ensures this on every page load, but a client
    // whose first contact is this API call (not a page render) needs it here too -
    // idempotent, costs one existence check when the row already exists.
    await ensureSignupGrant(userId)
    const balance = await getBalance(userId)
    if (balance < required) {
      throw new InsufficientCreditsError(required, balance)
    }

    enteredGeneratingState = true
    await setElementStatus(supabase, elementId, 'generating')

    const styleDescription = await loadStyleDescription(supabase, projectId, elementId)
    const prompt = buildReferencePrompt(element, styleDescription)

    const { model, quality, size } = modelsConfig.elements

    const { estimatedCost, quotedBreakdown } = quoteOpenAiImageCall({
      model,
      size,
      quality,
      estimatedInputTokens: estimateInputTokens({ texts: [prompt], tools: [] }),
    })

    const reserved = await reserveUsage({
      supabase,
      userId,
      projectId,
      generationId: generation.id,
      shotId: null,
      step: 'workbench',
      operation: 'generate_element_reference',
      provider: 'openai',
      model,
      quotedCost: estimatedCost,
      quotedBreakdown,
    })
    usageId = reserved.usageId

    // ONE call. No retry, no fallback model/provider - a throw here is caught once,
    // below, and surfaced as a single failure.
    const { imageBuffer, usage } = await gateway.generateReferenceImage({ prompt, model, quality, size })
    measuredBreakdown = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }

    const uploaded = await uploadNormalizedReferenceObject(supabase, userId, projectId, elementId, imageBuffer)
    if (!uploaded.success) {
      outcome = { ok: false, status: 500, error: uploaded.error }
      return outcome
    }

    // PERSIST BEFORE RELINKING. If the process dies between here and SETTLE, the next
    // claim's RECOVER branch finds this path and relinks without a second provider call.
    const { error: persistError } = await persistGenerationPayload(supabase, generation.id, {
      path: uploaded.path,
    } as Json)
    if (persistError) {
      outcome = {
        ok: false,
        status: 500,
        error: `Image generated but could not be saved safely (${persistError}). Retry to finish.`,
      }
      return outcome
    }

    const { error: relinkError } = await supabase
      .from('elements')
      .update({ reference_image_path: uploaded.path, status: 'ready' })
      .eq('id', elementId)
    if (relinkError) {
      // Recoverable: the payload above already persisted, so the next attempt's
      // RECOVER branch relinks from it without calling OpenAI again.
      outcome = { ok: false, status: 500, error: relinkError.message }
      return outcome
    }

    await markImagePromptsStaleForElementReference(supabase, projectId, elementId, element.type)

    const oldPath = element.reference_image_path
    if (oldPath && oldPath !== uploaded.path) {
      const { error: removeError } = await supabase.storage.from('artifacts').remove([oldPath])
      if (removeError) {
        console.error(`[elements] Failed to remove old reference image ${oldPath}:`, removeError.message)
      }
    }

    const { data: signed, error: signError } = await supabase.storage
      .from('artifacts')
      .createSignedUrl(uploaded.path, SIGNED_URL_EXPIRES_IN_SECONDS)
    if (signError || !signed) {
      outcome = { ok: false, status: 500, error: signError?.message ?? 'Failed to sign generated image' }
      return outcome
    }

    outcome = { ok: true, status: 200, data: { path: uploaded.path, url: signed.signedUrl } }
    return outcome
  } catch (err) {
    caughtError = err
    console.error('[elements] reference generation failed', err)
    outcome =
      err instanceof InsufficientCreditsError
        ? { ok: false, status: 402, error: err.message }
        : {
            ok: false,
            status: 500,
            error: err instanceof Error ? err.message : 'Unexpected error during reference generation',
            code: classifyGenerationFailure(err),
          }
    return outcome
  } finally {
    // SETTLE. Never clearPayload here - unlike a Claude max_tokens truncation, there is
    // no partial/unusable-but-persisted image case: a payload only ever exists once a
    // real object has been written to storage, so it must always survive for RECOVER.
    const { error: settleError } = await settleGeneration(supabase, generation.id, {
      success: outcome.ok,
      error: outcome.ok ? null : outcome.error,
    })
    if (settleError) {
      console.error('[elements] SETTLE update failed', settleError)
    }

    if (usageId) {
      const { model } = modelsConfig.elements
      const settledStatus = measuredBreakdown !== null ? 'succeeded' : 'failed'
      await settleUsage({
        supabase,
        usageId,
        provider: 'openai',
        model,
        status: settledStatus,
        breakdown: measuredBreakdown,
        error: outcome.ok ? null : caughtError,
      })

      // Ledger. Gated on usageId (never reached by RECOVER, which returns before
      // usageId is assigned - no money spent there, nothing charged) and on
      // outcome.ok (failure absorbs: a failed fresh attempt writes no ledger row even
      // though usage may already record a real provider charge - the two tables stay
      // independent). Never throws to the caller.
      if (outcome.ok) {
        try {
          await recordFixedSpend({
            userId,
            step: 'workbench',
            operation: 'generate_element_reference',
            quantity: 1,
            attemptId,
            projectId,
            messageId: null,
            shotKey: null,
          })
        } catch (err) {
          console.error('[elements] ledger write failed', err)
        }
      }
    }

    if (!outcome.ok && enteredGeneratingState) {
      await setElementStatus(supabase, elementId, 'failed')
    }
  }
}
