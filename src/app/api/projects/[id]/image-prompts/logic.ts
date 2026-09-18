import type Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import type { ClaudeGateway } from '@/lib/claude'
import type { Json } from '@/lib/database.types'
import { modelsConfig } from '@/lib/config/models'
import type { UsageBreakdown } from '@/lib/config/pricing'
import { estimateInputTokens, quoteClaudeCall, assertWithinAllowance, reserveUsage, settleUsage, AllowanceExceededError } from '@/lib/usage'
import { creditsFor, InsufficientCreditsError } from '@/lib/config/credits'
// Type-only: credits/ledger.ts transitively imports the service-role Supabase client
// module, which imports 'server-only' - a VALUE import here would crash any test that
// imports this module directly (same reason shots/logic.ts and
// elements/.../generate/logic.ts do this). ensureSignupGrant/getBalance are DI'd for
// the same reason (getBalance's own module has no service-role in its import graph,
// but stays type-only here too, for consistency with the other two).
import type { recordFixedSpend } from '@/lib/credits/ledger'
import type { getBalance } from '@/lib/credits/balance'
import type { ensureSignupGrant } from '@/lib/credits/signup-grant'
import {
  claimGeneration,
  persistGenerationPayload,
  settleGeneration,
  type BlockedReason,
} from '@/lib/generations/claim'
import { hasUsablePrompt } from '@/lib/prompts/prompt-validation'
import { IMAGE_PROMPTS_SYSTEM_PROMPT_V1, WRITE_IMAGE_PROMPTS_TOOL, buildImagePromptsDynamicBlock } from '@/lib/prompts/image-prompts'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type ImagePromptEntry = {
  shot_key: string
  image_prompt: string
}

function isImagePromptEntry(value: unknown): value is ImagePromptEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.shot_key === 'string' && hasUsablePrompt(v.image_prompt)
}

/**
 * Matches Claude's raw write_image_prompts tool input against the shot_keys that were
 * actually requested. Entries that are malformed, too short, or for a shot_key that
 * wasn't requested are dropped rather than persisted.
 */
export function resolveImagePromptResults(
  rawPrompts: unknown,
  targetShotKeys: string[]
): { validEntries: ImagePromptEntry[]; missingShotKeys: string[] } {
  const entries = Array.isArray(rawPrompts) ? rawPrompts.filter(isImagePromptEntry) : []
  const targetSet = new Set(targetShotKeys)
  const validEntries = entries.filter((entry) => targetSet.has(entry.shot_key))

  const returnedKeys = new Set(validEntries.map((entry) => entry.shot_key))
  const missingShotKeys = targetShotKeys.filter((key) => !returnedKeys.has(key))

  return { validEntries, missingShotKeys }
}

type ImagePromptShot = {
  id: string
  shot_key: string | null
  voice_over: string
}

async function loadProjectShots(
  supabase: SupabaseServerClient,
  projectId: string
): Promise<{ ok: true; allShots: ImagePromptShot[] } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('shots')
    .select('id, shot_key, voice_over')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, allShots: data ?? [] }
}

async function projectExistsForUser(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()

  return data !== null
}

export type ImagePromptGenerationResult =
  | { ok: true; status: 200; data: { shots: unknown[] } }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 404; error: string }
  | {
      ok: false
      status: 409
      error: string
      reason: BlockedReason
    }
  | { ok: false; status: 422; error: string; missingShotKeys?: string[]; failedShotKeys?: string[]; shots?: unknown[] }
  | { ok: false; status: 402; error: string }
  | { ok: false; status: 500; error: string }

type PipelineOutcome = {
  missingShotKeys: string[]
  failedShotKeys: string[]
  shots: unknown[] | null
  refetchError: string | null
  persistedCount: number
}

/**
 * Runs the resolve -> per-shot update -> refetch pipeline against a write_image_prompts
 * tool input. Called from both the fresh-Claude-call path and the RECOVER path -
 * rawInput is either the live toolUseBlock.input or a stored generations.payload,
 * identical shape either way. Each shot's image_prompt and image_prompt_stale are
 * written together in one .update() - a shot Claude never returned (missingShotKeys)
 * or whose own .update() errors (failedShotKeys, tracked independently) never has
 * either column touched, so it keeps its prior value and stale flag exactly as before.
 */
async function runImagePromptsPipeline(
  supabase: SupabaseServerClient,
  projectId: string,
  scopedShots: (ImagePromptShot & { shot_key: string })[],
  rawInput: unknown
): Promise<PipelineOutcome> {
  const input = rawInput as { prompts?: unknown }
  const idByKey = new Map(scopedShots.map((s) => [s.shot_key, s.id]))
  const targetShotKeys = scopedShots.map((s) => s.shot_key)
  const { validEntries, missingShotKeys } = resolveImagePromptResults(input.prompts, targetShotKeys)

  const updateResults = await Promise.all(
    validEntries.map(async (entry) => {
      const { error } = await supabase
        .from('shots')
        .update({ image_prompt: entry.image_prompt, image_prompt_stale: false })
        .eq('id', idByKey.get(entry.shot_key)!)
      return { shotKey: entry.shot_key, error }
    })
  )

  const persistedShotKeys = updateResults.filter((r) => !r.error).map((r) => r.shotKey)
  const failedShotKeys = updateResults.filter((r) => r.error).map((r) => r.shotKey)

  const { data: refreshedShots, error: refreshError } = await supabase
    .from('shots')
    .select('*')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })

  return {
    missingShotKeys,
    failedShotKeys,
    shots: refreshedShots ?? null,
    refetchError: refreshError?.message ?? null,
    persistedCount: persistedShotKeys.length,
  }
}

function pipelineOutcomeToResult(pipeline: PipelineOutcome): ImagePromptGenerationResult {
  if (pipeline.refetchError) {
    return { ok: false, status: 500, error: pipeline.refetchError }
  }
  if (pipeline.missingShotKeys.length > 0 || pipeline.failedShotKeys.length > 0) {
    return {
      ok: false,
      status: 422,
      error: `Some image prompts couldn't be generated or saved: ${[...pipeline.missingShotKeys, ...pipeline.failedShotKeys].join(', ')}. Retry to regenerate.`,
      missingShotKeys: pipeline.missingShotKeys,
      failedShotKeys: pipeline.failedShotKeys,
      shots: pipeline.shots ?? [],
    }
  }
  return { ok: true, status: 200, data: { shots: pipeline.shots ?? [] } }
}

const BLOCKED_REASON_MESSAGES: Record<BlockedReason, string> = {
  already_ready: 'Image prompts have already been generated for this project.',
  already_generating: 'A generation is already in progress for this project.',
  retry_required: 'The last generation failed. Retry to try again.',
}

export async function runImagePromptGeneration(params: {
  gateway: ClaudeGateway
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  shotIds: string[]
  retry: boolean
  attemptId: string
  recordFixedSpend: typeof recordFixedSpend
  getBalance: typeof getBalance
  ensureSignupGrant: typeof ensureSignupGrant
}): Promise<ImagePromptGenerationResult> {
  const { gateway, supabase, projectId, userId, shotIds, retry, attemptId, recordFixedSpend, getBalance, ensureSignupGrant } =
    params

  // Loaded before the claim, same rationale as shots/logic.ts's loadProjectForClaim: a
  // vanished/unowned project returns 404 without needing to interpret an RLS/FK error
  // off the claim INSERT.
  const exists = await projectExistsForUser(supabase, projectId, userId)
  if (!exists) {
    return { ok: false, status: 404, error: 'Project not found' }
  }

  const loaded = await loadProjectShots(supabase, projectId)
  if (!loaded.ok) {
    return { ok: false, status: 500, error: loaded.error }
  }

  // Scope is entirely client-supplied - see CLAUDE.md's "scope is never inferred,
  // defaulted, or widened server-side" principle (established for camera fields,
  // applied here to which shots). A shotIds entry that doesn't resolve to a real shot
  // in this project is rejected before a claim slot is ever consumed.
  const idSet = new Set(shotIds)
  const scopedShots = loaded.allShots.filter(
    (s): s is ImagePromptShot & { shot_key: string } => idSet.has(s.id) && s.shot_key !== null
  )
  if (scopedShots.length !== shotIds.length) {
    return { ok: false, status: 400, error: 'One or more shotIds do not belong to this project' }
  }

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: 'image_prompts', operation: 'write_image_prompts', shotId: null, elementId: null },
    retry,
  })

  if (claim.outcome === 'error') {
    return { ok: false, status: 500, error: claim.message }
  }
  if (claim.outcome === 'blocked') {
    return { ok: false, status: 409, error: BLOCKED_REASON_MESSAGES[claim.reason], reason: claim.reason }
  }

  const { generation } = claim
  const pendingPayload = generation.payload

  let outcome: ImagePromptGenerationResult = {
    ok: false,
    status: 500,
    error: 'Image prompt generation did not complete',
  }
  let clearPayloadOnSettle = false
  let usageId: string | null = null
  let measuredBreakdown: UsageBreakdown | null = null
  let stopReasonForSettle: string | null = null
  let caughtError: unknown = null
  // Visible to `finally` regardless of which branch below sets it - this is what
  // makes the partial-persistence ledger charge correct.
  let persistedCount = 0

  try {
    // RECOVER BEFORE SPEND - and before the balance gate: nothing new is being spent,
    // so a recoverable payload must stay recoverable even if the caller's balance has
    // since dropped to zero. usageId stays null here, which is what keeps both the
    // usage settle and the ledger charge out of the `finally` block below.
    if (pendingPayload !== null) {
      console.warn(
        `[image-prompts] recovering pending payload for project=${projectId} generation=${generation.id} - skipping a new Claude call`
      )
      const pipeline = await runImagePromptsPipeline(supabase, projectId, scopedShots, pendingPayload)
      persistedCount = pipeline.persistedCount
      outcome = pipelineOutcomeToResult(pipeline)
      return outcome
    }

    // BALANCE GATE - before any quote/reserve/provider call. quantity is the
    // requested scope size; this is a pre-flight check only, nothing is charged off
    // this number. The real charge (below, in `finally`) is keyed on what actually
    // persists.
    const required = creditsFor({ step: 'image_prompts', operation: 'write_image_prompts', quantity: scopedShots.length })
    // Defensive: AppLayout already ensures this on every page load, but a client whose
    // first contact is this API call needs it here too - idempotent.
    await ensureSignupGrant(userId)
    const balance = await getBalance(userId)
    if (balance < required) {
      throw new InsufficientCreditsError(required, balance)
    }

    const dynamicBlock = buildImagePromptsDynamicBlock(
      loaded.allShots
        .filter((s): s is ImagePromptShot & { shot_key: string } => s.shot_key !== null)
        .map(({ shot_key, voice_over }) => ({ shot_key, voice_over })),
      scopedShots.map((s) => s.shot_key)
    )

    const userMessage = 'Generate the image prompts now.'

    const { estimatedCost, quotedBreakdown } = quoteClaudeCall({
      model: modelsConfig.imagePrompts.model,
      estimatedInputTokens: estimateInputTokens({
        texts: [IMAGE_PROMPTS_SYSTEM_PROMPT_V1, dynamicBlock, userMessage],
        tools: [WRITE_IMAGE_PROMPTS_TOOL],
      }),
      maxTokens: modelsConfig.imagePrompts.maxTokens,
    })

    await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })

    const reserved = await reserveUsage({
      supabase,
      userId,
      projectId,
      generationId: generation.id,
      shotId: null,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      provider: 'anthropic',
      model: modelsConfig.imagePrompts.model,
      quotedCost: estimatedCost,
      quotedBreakdown,
    })
    usageId = reserved.usageId

    const { message, stopReason, requestId } = await gateway.createMessage({
      model: modelsConfig.imagePrompts.model,
      max_tokens: modelsConfig.imagePrompts.maxTokens,
      system: [
        { type: 'text', text: IMAGE_PROMPTS_SYSTEM_PROMPT_V1, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicBlock },
      ],
      tools: [WRITE_IMAGE_PROMPTS_TOOL],
      tool_choice: { type: 'tool', name: 'write_image_prompts' },
      messages: [{ role: 'user', content: userMessage }],
    })

    measuredBreakdown = message.usage
    stopReasonForSettle = stopReason

    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === 'write_image_prompts'
    )

    if (!toolUseBlock) {
      outcome = { ok: false, status: 500, error: 'Claude did not return image prompts' }
      return outcome
    }

    // PERSIST BEFORE WRITING SHOTS. Lands before any shots.update - if the process
    // dies between here and SETTLE, the payload is already safe to recover on the next
    // claim.
    const { error: persistError } = await persistGenerationPayload(
      supabase,
      generation.id,
      toolUseBlock.input as Json
    )

    console.warn(`[image-prompts] stopReason=${stopReason} requestId=${requestId}`)

    if (persistError) {
      outcome = {
        ok: false,
        status: 500,
        error: `Claude returned image prompts, but they could not be saved safely (${persistError}). Retry to regenerate.`,
      }
      return outcome
    }

    const pipeline = await runImagePromptsPipeline(supabase, projectId, scopedShots, toolUseBlock.input)
    persistedCount = pipeline.persistedCount

    // TRUNCATION. A max_tokens stop was never a successful return, so - unlike a
    // normal failure - the payload is cleared here rather than left for a later
    // recovery: leaving it would make a retry replay the same truncated answer forever
    // instead of asking Claude for a fresh, complete one. Whatever did persist before
    // the truncation still counts toward persistedCount for the ledger charge below.
    if (stopReason === 'max_tokens') {
      clearPayloadOnSettle = true
      outcome = {
        ok: false,
        status: 422,
        error:
          'Generation stopped early before Claude finished the image prompts.' +
          (persistedCount > 0
            ? ' Some prompts were saved, but the batch is incomplete. Retry to regenerate.'
            : ' Retry to regenerate.'),
        missingShotKeys: pipeline.missingShotKeys,
        failedShotKeys: pipeline.failedShotKeys,
        shots: pipeline.shots ?? [],
      }
      return outcome
    }

    outcome = pipelineOutcomeToResult(pipeline)
    return outcome
  } catch (err) {
    caughtError = err
    outcome = {
      ok: false,
      status: err instanceof InsufficientCreditsError || err instanceof AllowanceExceededError ? 402 : 500,
      error: err instanceof Error ? err.message : 'Unexpected error during image prompt generation',
    }
    return outcome
  } finally {
    // SETTLE. Runs on every exit, including a thrown exception, so a project can never
    // be left stuck 'generating'.
    try {
      const { error: settleError } = await settleGeneration(supabase, generation.id, {
        success: outcome.ok,
        error: outcome.ok ? null : outcome.error,
        clearPayload: clearPayloadOnSettle,
      })
      if (settleError) {
        console.error('[image-prompts] SETTLE update failed', settleError)
      }
    } catch (settleErr) {
      console.error('[image-prompts] SETTLE update failed', settleErr)
    }

    // usage SETTLE. Only reserved on the fresh-call path (RECOVER and the
    // balance-gate-throw path never spend, so usageId stays null there).
    if (usageId) {
      await settleUsage({
        supabase,
        usageId,
        provider: 'anthropic',
        model: modelsConfig.imagePrompts.model,
        status: measuredBreakdown !== null && stopReasonForSettle !== 'max_tokens' ? 'succeeded' : 'failed',
        breakdown: measuredBreakdown,
        stopReason: stopReasonForSettle,
        error: outcome.ok ? null : caughtError,
      })

      // Ledger. Gated on persistedCount, NOT outcome.ok - this is a deliberate
      // departure from every other ledger-wired route in this codebase
      // (generate_shots/derive_camera/generate_element_reference all gate on
      // outcome.ok). image-prompts is the first route where a batch can partially
      // succeed (some shots persisted, some missing/truncated/failed) and still owe a
      // real charge for the ones that landed - a 422 with persistedCount > 0 must
      // still charge for persistedCount. Never throws to the caller.
      if (persistedCount > 0) {
        try {
          await recordFixedSpend({
            userId,
            step: 'image_prompts',
            operation: 'write_image_prompts',
            quantity: persistedCount,
            attemptId,
            projectId,
            messageId: null,
            shotKey: null,
          })
        } catch (err) {
          console.error('[image-prompts] ledger write failed', err)
        }
      }
    }
  }
}
