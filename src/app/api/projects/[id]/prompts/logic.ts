import type Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import type { ClaudeGateway } from '@/lib/claude'
import { modelsConfig } from '@/lib/config/models'
import type { UsageBreakdown } from '@/lib/config/pricing'
import { estimateInputTokens, quoteClaudeCall, assertWithinAllowance, reserveUsage, settleUsage, AllowanceExceededError } from '@/lib/usage'
import {
  claimGeneration,
  persistGenerationPayload,
  settleGeneration,
  type BlockedReason,
} from '@/lib/generations/claim'
import type { Json } from '@/lib/database.types'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type ShotPrompt = {
  shot_key: string
  image_prompt: string
  video_prompt: string
}

/**
 * Below this length a prompt is treated as unusable (empty, whitespace, or
 * a degenerate model response) rather than as real content - it's rejected
 * before persistence instead of being written as garbage.
 */
export const MIN_PROMPT_LENGTH = 50

export function hasUsablePrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= MIN_PROMPT_LENGTH
}

export function isShotPrompt(value: unknown): value is ShotPrompt {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.shot_key === 'string' &&
    hasUsablePrompt(v.image_prompt) &&
    hasUsablePrompt(v.video_prompt)
  )
}

export function needsPrompts(shot: {
  image_prompt: string | null
  video_prompt: string | null
}): boolean {
  return !hasUsablePrompt(shot.image_prompt) || !hasUsablePrompt(shot.video_prompt)
}

/**
 * Matches Claude's raw write_prompts tool input against the shot_keys that
 * were actually requested. Entries that are malformed, too short, or for a
 * shot_key that wasn't requested are dropped rather than persisted.
 */
export function resolvePromptResults(
  rawPrompts: unknown,
  targetShotKeys: string[]
): { validEntries: ShotPrompt[]; missingShotKeys: string[] } {
  const entries = Array.isArray(rawPrompts) ? rawPrompts.filter(isShotPrompt) : []
  const targetSet = new Set(targetShotKeys)
  const validEntries = entries.filter((entry) => targetSet.has(entry.shot_key))

  const returnedKeys = new Set(validEntries.map((entry) => entry.shot_key))
  const missingShotKeys = targetShotKeys.filter((key) => !returnedKeys.has(key))

  return { validEntries, missingShotKeys }
}

const PROMPTS_SYSTEM_PROMPT = `You are writing per-shot image and video prompts for a short narrated video, based on its script.

Write prompts as structured data via the write_prompts tool - never as free-text JSON in your reply. Call write_prompts exactly once with one entry per requested shot_key.

image_prompt is a detailed, self-contained description of that shot's image (~800-1200 characters) - it must make sense with no other context, since it goes straight to an image generation model.

video_prompt describes the motion within that shot's image (~400-700 characters) - what moves, how the camera behaves - not a new shot.

Use the full script below only for continuity (recurring characters, setting, visual style) between shots - do not write prompts for any shot_key not explicitly requested.`

const WRITE_PROMPTS_TOOL: Anthropic.Tool = {
  name: 'write_prompts',
  description: 'Write image_prompt and video_prompt for the requested shots only.',
  input_schema: {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            shot_key: {
              type: 'string',
              description: "The shot's identifier, e.g. 's001'.",
            },
            image_prompt: {
              type: 'string',
              description: 'Detailed, self-contained image description (~800-1200 characters).',
            },
            video_prompt: {
              type: 'string',
              description: "Describes motion within this shot's image (~400-700 characters).",
            },
          },
          required: ['shot_key', 'image_prompt', 'video_prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['prompts'],
    additionalProperties: false,
  },
  strict: true,
  cache_control: { type: 'ephemeral' },
}

function buildPromptsDynamicBlock(
  allShots: { shot_key: string; voice_over: string }[],
  targetKeys: string[]
) {
  return `Full script for context (in order):\n${JSON.stringify(allShots, null, 2)}\n\nWrite image_prompt and video_prompt only for these shot_keys: ${targetKeys.join(', ')}.`
}

type ShotForPrompts = {
  id: string
  shot_key: string | null
  voice_over: string
  image_prompt: string | null
  video_prompt: string | null
}

async function loadShotsNeedingPrompts(
  supabase: SupabaseServerClient,
  projectId: string
): Promise<
  | { ok: false; error: string }
  | { ok: true; allShots: ShotForPrompts[]; shotsNeedingPrompts: (ShotForPrompts & { shot_key: string })[] }
> {
  const { data: allShots, error } = await supabase
    .from('shots')
    .select('id, shot_key, voice_over, image_prompt, video_prompt')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })

  if (error) {
    return { ok: false, error: error.message }
  }

  const shotsNeedingPrompts = (allShots ?? []).filter(
    (s): s is ShotForPrompts & { shot_key: string } => s.shot_key !== null && needsPrompts(s)
  )

  return { ok: true, allShots: allShots ?? [], shotsNeedingPrompts }
}

export type PromptGenerationResult =
  | { ok: true; status: 200; data: { shots: unknown[] } }
  | { ok: false; status: 404; error: string }
  | {
      ok: false
      status: 409
      error: string
      reason: 'already_ready' | 'already_generating' | 'retry_required'
    }
  | { ok: false; status: 422; error: string; missingShotKeys?: string[]; shots?: unknown[] }
  | { ok: false; status: 402; error: string }
  | { ok: false; status: 500; error: string }

/**
 * Runs the resolve -> update -> refetch pipeline against a write_prompts tool input.
 * Called from both the fresh-Claude-call path and the RECOVER path - rawInput is
 * either the live toolUseBlock.input or a stored generations.payload, identical shape
 * either way. targetShotKeys is recomputed fresh by the caller every time (not stored
 * on the claim), so it always reflects the project's current state.
 */
async function runPromptsPipeline(
  supabase: SupabaseServerClient,
  projectId: string,
  shotsNeedingPrompts: (ShotForPrompts & { shot_key: string })[],
  rawInput: unknown
): Promise<PromptGenerationResult> {
  const input = rawInput as { prompts?: unknown }
  const idByKey = new Map(shotsNeedingPrompts.map((s) => [s.shot_key, s.id]))
  const targetShotKeys = shotsNeedingPrompts.map((s) => s.shot_key)
  const { validEntries, missingShotKeys } = resolvePromptResults(input.prompts, targetShotKeys)

  const updateResults = await Promise.all(
    validEntries.map((entry) =>
      supabase
        .from('shots')
        .update({ image_prompt: entry.image_prompt, video_prompt: entry.video_prompt })
        .eq('id', idByKey.get(entry.shot_key)!)
    )
  )

  const updateError = updateResults.find((r) => r.error)?.error
  if (updateError) {
    return { ok: false, status: 500, error: updateError.message }
  }

  const { data: refreshedShots, error: refreshError } = await supabase
    .from('shots')
    .select('*')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })

  if (refreshError) {
    return { ok: false, status: 500, error: refreshError.message }
  }

  if (missingShotKeys.length > 0) {
    return {
      ok: false,
      status: 422,
      error: `Claude couldn't generate usable prompts for: ${missingShotKeys.join(', ')}. Try again.`,
      missingShotKeys,
      shots: refreshedShots ?? [],
    }
  }

  return { ok: true, status: 200, data: { shots: refreshedShots ?? [] } }
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

const BLOCKED_REASON_MESSAGES: Record<BlockedReason, string> = {
  already_ready: 'Prompts have already been generated for this project.',
  already_generating: 'A generation is already in progress for this project.',
  retry_required: 'The last generation failed. Retry to try again.',
}

export async function runPromptGeneration(params: {
  gateway: ClaudeGateway
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  retry: boolean
}): Promise<PromptGenerationResult> {
  const { gateway, supabase, projectId, userId, retry } = params

  // Loaded before the claim, same rationale as shots/logic.ts's loadProjectForClaim:
  // a vanished/unowned project returns 404 without needing to interpret an RLS/FK
  // error off the claim INSERT.
  const exists = await projectExistsForUser(supabase, projectId, userId)
  if (!exists) {
    return { ok: false, status: 404, error: 'Project not found' }
  }

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: 'image_prompts', operation: 'write_prompts', shotId: null },
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
  let outcome: PromptGenerationResult = {
    ok: false,
    status: 500,
    error: 'Prompt generation did not complete',
  }
  let clearPayloadOnSettle = false
  let usageId: string | null = null
  let measuredBreakdown: UsageBreakdown | null = null
  let stopReasonForSettle: string | null = null
  let caughtError: unknown = null

  try {
    const loaded = await loadShotsNeedingPrompts(supabase, projectId)
    if (!loaded.ok) {
      outcome = { ok: false, status: 500, error: loaded.error }
      return outcome
    }
    const { shotsNeedingPrompts } = loaded

    // RECOVER BEFORE SPEND. A stored payload means Claude has already been paid for;
    // recovery replays it and never re-calls the gateway.
    if (pendingPayload !== null) {
      console.warn(
        `[prompts] recovering pending payload for project=${projectId} generation=${generation.id} - skipping a new Claude call`
      )
      outcome = await runPromptsPipeline(supabase, projectId, shotsNeedingPrompts, pendingPayload)
      return outcome
    }

    // Nothing to do: no shots need a prompt, so no Claude call is made. Runs through
    // the same pipeline with an empty target set - resolvePromptResults over an empty
    // targetShotKeys list yields no missing keys, so this advances current_step and
    // settles succeeded with no payload, matching the old route's early-return branch.
    if (shotsNeedingPrompts.length === 0) {
      outcome = await runPromptsPipeline(supabase, projectId, shotsNeedingPrompts, { prompts: [] })
      return outcome
    }

    const dynamicBlock = buildPromptsDynamicBlock(
      loaded.allShots
        .filter((s): s is ShotForPrompts & { shot_key: string } => s.shot_key !== null)
        .map(({ shot_key, voice_over }) => ({ shot_key, voice_over })),
      shotsNeedingPrompts.map((s) => s.shot_key)
    )

    const userMessage = 'Generate the image and video prompts now.'

    const { estimatedCost, quotedBreakdown } = quoteClaudeCall({
      model: modelsConfig.prompts.model,
      estimatedInputTokens: estimateInputTokens({
        texts: [PROMPTS_SYSTEM_PROMPT, dynamicBlock, userMessage],
        tools: [WRITE_PROMPTS_TOOL],
      }),
      maxTokens: modelsConfig.prompts.maxTokens,
    })

    await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })

    const reserved = await reserveUsage({
      supabase,
      userId,
      projectId,
      generationId: generation.id,
      shotId: null,
      step: 'image_prompts',
      operation: 'write_prompts',
      provider: 'anthropic',
      model: modelsConfig.prompts.model,
      quotedCost: estimatedCost,
      quotedBreakdown,
    })
    usageId = reserved.usageId

    const { message, stopReason, requestId } = await gateway.createMessage({
      model: modelsConfig.prompts.model,
      max_tokens: modelsConfig.prompts.maxTokens,
      system: [
        { type: 'text', text: PROMPTS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicBlock },
      ],
      tools: [WRITE_PROMPTS_TOOL],
      tool_choice: { type: 'tool', name: 'write_prompts' },
      messages: [{ role: 'user', content: userMessage }],
    })

    measuredBreakdown = message.usage
    stopReasonForSettle = stopReason

    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === 'write_prompts'
    )

    if (!toolUseBlock) {
      outcome = { ok: false, status: 500, error: 'Claude did not return prompts' }
      return outcome
    }

    // PERSIST BEFORE WRITING. Lands before any shots.update - if the process dies
    // between here and SETTLE, the payload is already safe to recover on the next claim.
    const { error: persistError } = await persistGenerationPayload(
      supabase,
      generation.id,
      toolUseBlock.input as Json
    )

    console.warn(`[prompts] stopReason=${stopReason} requestId=${requestId}`)

    if (persistError) {
      outcome = {
        ok: false,
        status: 500,
        error: `Claude returned prompts, but they could not be saved safely (${persistError}). Retry to regenerate.`,
      }
      return outcome
    }

    const pipelineResult = await runPromptsPipeline(
      supabase,
      projectId,
      shotsNeedingPrompts,
      toolUseBlock.input
    )

    // TRUNCATION. A max_tokens stop was never a successful return, so - unlike a
    // normal failure - the payload is cleared here rather than left for a later
    // recovery: leaving it would make a retry replay the same truncated answer
    // forever instead of asking Claude for a fresh, complete one.
    if (stopReason === 'max_tokens') {
      clearPayloadOnSettle = true
      outcome = {
        ok: false,
        status: 422,
        error:
          'Generation stopped early before Claude finished the prompts.' +
          (pipelineResult.ok
            ? ' Some prompts were saved, but the batch is incomplete. Retry to regenerate.'
            : ' Retry to regenerate.'),
      }
      return outcome
    }

    outcome = pipelineResult
    return outcome
  } catch (err) {
    caughtError = err
    outcome = {
      ok: false,
      status: err instanceof AllowanceExceededError ? 402 : 500,
      error: err instanceof Error ? err.message : 'Unexpected error during prompt generation',
    }
    return outcome
  } finally {
    // SETTLE. Runs on every exit, including a thrown exception, so a project can
    // never be left stuck 'generating'.
    try {
      const { error: settleError } = await settleGeneration(supabase, generation.id, {
        success: outcome.ok,
        error: outcome.ok ? null : outcome.error,
        clearPayload: clearPayloadOnSettle,
      })
      if (settleError) {
        console.error('[prompts] SETTLE update failed', settleError)
      }
    } catch (settleErr) {
      console.error('[prompts] SETTLE update failed', settleErr)
    }

    // usage SETTLE. Only reserved on the fresh-call path (RECOVER and the
    // nothing-needs-prompts branch never spend, so usageId stays null there) -
    // skipped entirely when nothing was ever reserved. status reflects whether Claude
    // actually responded and was billed, which is NOT the same as outcome.ok: a
    // persistError after a successful call is outcome.ok === false but was still
    // billed successfully, while a max_tokens stop is billed but must settle 'failed'
    // regardless of how much of the pipeline it saved.
    if (usageId) {
      await settleUsage({
        supabase,
        usageId,
        provider: 'anthropic',
        model: modelsConfig.prompts.model,
        status: measuredBreakdown !== null && stopReasonForSettle !== 'max_tokens' ? 'succeeded' : 'failed',
        breakdown: measuredBreakdown,
        stopReason: stopReasonForSettle,
        error: outcome.ok ? null : caughtError,
      })
    }
  }
}
