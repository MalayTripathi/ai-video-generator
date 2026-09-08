import type Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import type { ClaudeGateway } from '@/lib/claude'
import type { Tables } from '@/lib/database.types'
import { modelsConfig } from '@/lib/config/models'
import { stepIndex } from '@/lib/config/pipeline'
import { insertUserMessage } from '@/lib/messages-idempotency'
import { claimGeneration, settleGeneration } from '@/lib/generations/claim'
import {
  estimateInputTokens,
  quoteClaudeCall,
  assertWithinAllowance,
  reserveUsage,
  settleUsage,
  AllowanceExceededError,
} from '@/lib/usage'
import { AGENT_SYSTEM_PROMPT_V6, AGENT_TOOLS, buildShotIndexBlock } from '@/lib/prompts/agent'
import { dispatchAgentTool, type AgentToolContext } from './tools'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type MessageRow = Tables<'messages'>

const MAX_ITERATIONS = 8
const HISTORY_LIMIT = 20

export type AgentStreamEvent =
  | { type: 'turn_started' }
  | { type: 'text_delta'; text: string }
  // shotKey is the structured identifier for card locking/refetch - stable across
  // order_index renumbering, unlike a display number. Present whenever the tool acted on
  // (mutated, or refused acting on) one specific shot; absent when it concerns the whole
  // list (regenerate_all_shots) or the request as a whole (a lock refusal before any shot
  // was resolved). `label` stays free-text display copy only - never parse it for this.
  | { type: 'tool_completed'; label: string; shotKey?: string }
  | { type: 'refusal'; label: string; shotKey?: string }
  | { type: 'error'; message: string }
  | { type: 'settled'; content: string } // terminal - always fires exactly once

export type AgentTurnResult =
  | { ok: true; status: 200; message: MessageRow }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; error: string; reason: 'already_generating' }
  | { ok: false; status: 402; error: string }
  | { ok: false; status: 500; error: string }

type ClaimedProject = {
  // Already the 1-7 index (CLAUDE.md: intake=1 ... assembly=7), never a step name -
  // unlike current_step, which is the string enum. No stepIndex() call needed here.
  furthest_step: number
}

async function loadProjectForTurn(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string
): Promise<ClaimedProject | null> {
  const { data } = await supabase
    .from('projects')
    .select('furthest_step')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()
  return data
}

function extractFinishMessage(input: unknown): string {
  const message = (input as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.trim().length > 0 ? message : 'Done.'
}

const READ_ONLY_LOCK_REPLY =
  "This project's workbench is locked because later steps have already started, so I can no longer change shots here."

async function insertAssistantReply(
  supabase: SupabaseServerClient,
  projectId: string,
  clientId: string,
  content: string
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ project_id: projectId, role: 'assistant', content, client_id: clientId })
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to persist assistant reply: ${error?.message ?? 'no row returned'}`)
  }
  return data
}

/**
 * Runs one agent turn end to end: CLAIM the agent_turn mutex, build context, loop
 * Claude calls (up to MAX_ITERATIONS) dispatching tool calls between them, then SETTLE.
 * There is no PERSIST/RECOVER here (unlike generate_shots) - each tool call's DB write
 * is already durable the instant that iteration dispatches it, so there is no batched,
 * not-yet-written payload to protect. `agent_turn`'s claim is a pure concurrency mutex,
 * per its OPERATION_POLICY entry (claimableFrom: always/always) - see docs/decisions.md.
 */
export async function runAgentTurn(params: {
  gateway: ClaudeGateway
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  content: string
  clientId: string
  // Best-effort; runAgentTurn never lets a throwing onEvent affect the turn's outcome -
  // a broken client pipe must never skip settlement.
  onEvent?: (event: AgentStreamEvent) => void
}): Promise<AgentTurnResult> {
  const { gateway, supabase, projectId, userId, content, clientId } = params
  const emit = (event: AgentStreamEvent) => {
    try {
      params.onEvent?.(event)
    } catch {
      // A broken client pipe must never affect the turn - see module docblock.
    }
  }

  const project = await loadProjectForTurn(supabase, projectId, userId)
  if (!project) {
    return { ok: false, status: 404, error: 'Project not found' }
  }

  // Idempotency guard FIRST, before any claim or spend - see messages-idempotency.ts.
  const userMsgResult = await insertUserMessage({ supabase, projectId, content, clientId })
  if (userMsgResult.outcome === 'error') {
    return { ok: false, status: 500, error: userMsgResult.message }
  }

  if (userMsgResult.outcome === 'duplicate') {
    const { data: reply } = await supabase
      .from('messages')
      .select('*')
      .eq('project_id', projectId)
      .eq('client_id', clientId)
      .eq('role', 'assistant')
      .maybeSingle()
    if (reply) {
      emit({ type: 'settled', content: reply.content })
      return { ok: true, status: 200, message: reply }
    }
    // The original attempt hasn't reached its own SETTLE yet - a concurrent resend, not
    // a sequential lost-response retry. Nothing persisted for this attempt; the
    // in-flight winner will persist the real reply.
    return {
      ok: false,
      status: 409,
      error: 'This turn is still being processed.',
      reason: 'already_generating',
    }
  }

  const userMessage = userMsgResult.message
  const furthestStepIndex = project.furthest_step

  // Read-only lock: top-level short-circuit, before any claim and before ever calling
  // Claude - no cost, no mutex row, for a request that can't do anything anyway.
  if (furthestStepIndex >= stepIndex('storyboard')) {
    const assistantRow = await insertAssistantReply(supabase, projectId, clientId, READ_ONLY_LOCK_REPLY)
    emit({ type: 'settled', content: READ_ONLY_LOCK_REPLY })
    return { ok: true, status: 200, message: assistantRow }
  }

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: 'workbench', operation: 'agent_turn', shotId: null },
    // agent_turn's policy is claimableFrom: {succeeded: 'always', failed: 'always'} -
    // there is no "job" to protect from re-attempt, only a lock to release, so this is
    // always true and the policy is what actually gates reclaiming, not this flag.
    retry: true,
  })

  if (claim.outcome === 'error') {
    // The user message was already durably inserted above - without a persisted reply,
    // a resend of this exact client_id would find that row and no matching assistant
    // row forever (see messages-idempotency.ts's duplicate branch), stuck refusing the
    // identical request indefinitely instead of ever resolving. Persist a terminal
    // explanation for THIS attempt, same as the read-only-lock and thrown-error paths.
    await insertAssistantReply(
      supabase,
      projectId,
      clientId,
      'Something went wrong starting that - nothing was changed. Please try again.'
    )
    return { ok: false, status: 500, error: claim.message }
  }
  if (claim.outcome === 'blocked') {
    // Only reachable reason for this policy: already_generating (fresh, not yet stale).
    // Same orphan risk as the 'error' branch above - persist a terminal reply for this
    // specific attempt so a resend of this client_id resolves instead of looping.
    await insertAssistantReply(
      supabase,
      projectId,
      clientId,
      'Another turn was already running for this project when this was sent, so nothing was changed. Please try again.'
    )
    return {
      ok: false,
      status: 409,
      error: 'Another turn is already running for this project.',
      reason: 'already_generating',
    }
  }

  const generation = claim.generation
  emit({ type: 'turn_started' })

  let assistantContent: string | null = null
  let outcome: AgentTurnResult = { ok: false, status: 500, error: 'Agent turn did not complete' }
  const usageIds: string[] = []
  const settledUsageIds = new Set<string>()
  let caughtError: unknown = null

  async function reserveAndSettle(
    estimatedInputTokens: number
  ): Promise<{ usageId: string; markSettled: (breakdown: Anthropic.Usage | null, stopReason: string | null) => Promise<void> }> {
    const { estimatedCost, quotedBreakdown } = quoteClaudeCall({
      model: modelsConfig.agent.model,
      estimatedInputTokens,
      maxTokens: modelsConfig.agent.maxTokens,
    })
    await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })
    const reserved = await reserveUsage({
      supabase,
      userId,
      projectId,
      generationId: generation.id,
      shotId: null,
      messageId: userMessage.id,
      step: 'workbench',
      operation: 'agent_turn',
      provider: 'anthropic',
      model: modelsConfig.agent.model,
      quotedCost: estimatedCost,
      quotedBreakdown,
    })
    usageIds.push(reserved.usageId)
    return {
      usageId: reserved.usageId,
      markSettled: async (breakdown, stopReason) => {
        await settleUsage({
          supabase,
          usageId: reserved.usageId,
          provider: 'anthropic',
          model: modelsConfig.agent.model,
          status: breakdown !== null && stopReason !== 'max_tokens' ? 'succeeded' : 'failed',
          breakdown,
          stopReason,
          error: null,
        })
        settledUsageIds.add(reserved.usageId)
      },
    }
  }

  try {
    const { data: shotRows } = await supabase
      .from('shots')
      .select('order_index, visual_description, voice_over, shot_size_origin, camera_angle_origin, camera_movement_origin')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
    const shotIndexBlock = buildShotIndexBlock(shotRows ?? [])

    const { data: historyRows } = await supabase
      .from('messages')
      .select('role, content')
      .eq('project_id', projectId)
      .neq('id', userMessage.id)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)
    const history = (historyRows ?? []).reverse()

    const messages: Anthropic.MessageParam[] = [
      ...history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content },
    ]

    const toolCtx: AgentToolContext = {
      supabase,
      gateway,
      projectId,
      userId,
      furthestStepIndex,
      messageId: userMessage.id,
    }

    let finalText: string | null = null

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const estimatedInputTokens = estimateInputTokens({
        texts: [AGENT_SYSTEM_PROMPT_V6, shotIndexBlock, ...history.map((m) => m.content), content],
        tools: AGENT_TOOLS,
      })
      const { markSettled } = await reserveAndSettle(estimatedInputTokens)

      const { message, stopReason } = await gateway.createMessage(
        {
          model: modelsConfig.agent.model,
          max_tokens: modelsConfig.agent.maxTokens,
          system: [
            { type: 'text', text: AGENT_SYSTEM_PROMPT_V6, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: shotIndexBlock, cache_control: { type: 'ephemeral' } },
          ],
          tools: AGENT_TOOLS,
          messages,
        },
        { onTextDelta: (text) => emit({ type: 'text_delta', text }) }
      )

      await markSettled(message.usage, stopReason)

      if (stopReason === 'max_tokens') {
        finalText = "I ran out of room finishing that - here's what I have so far."
        break
      }

      messages.push({ role: 'assistant', content: message.content })

      const toolUseBlocks = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      )
      const textBlocks = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')

      if (toolUseBlocks.length === 0) {
        finalText = textBlocks || 'Done.'
        break
      }

      // finish never reaches dispatchAgentTool - it mutates nothing, so it's pulled out
      // before dispatch rather than routed through the same switch as a real tool.
      const finishBlock = toolUseBlocks.find((block) => block.name === 'finish')
      const mutationBlocks = toolUseBlocks.filter((block) => block.name !== 'finish')

      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = []
      let allMutationsApplied = true
      for (const block of mutationBlocks) {
        const result = await dispatchAgentTool(block.name, block.input, toolCtx)
        if (result.kind === 'applied') emit({ type: 'tool_completed', label: result.label, shotKey: result.shotKey })
        if (result.kind === 'refused') emit({ type: 'refusal', label: result.label, shotKey: result.shotKey })
        if (result.kind === 'errored') emit({ type: 'error', message: result.message })
        if (result.kind !== 'applied') allMutationsApplied = false
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result.forModel),
          is_error: result.kind !== 'applied',
        })
      }

      if (finishBlock) {
        // A check on what already happened, not a prediction: only trust the model's
        // closing message when every mutation bundled alongside it actually applied.
        // A refusal or error means the model predicted success it didn't get, so its
        // message is discarded and the turn falls through to the same round trip a
        // refusal already requires today - see docs/decisions.md.
        if (allMutationsApplied) {
          finalText = extractFinishMessage(finishBlock.input)
          break
        }
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: finishBlock.id,
          content: JSON.stringify({
            status: 'not_finished',
            reason: 'Not applied - another action in this response was refused or failed. Address that before finishing.',
          }),
          is_error: false,
        })
      }

      messages.push({ role: 'user', content: toolResultBlocks })

      if (iteration === MAX_ITERATIONS) {
        finalText = textBlocks || "I've made the changes I could for now - let me know if you'd like me to keep going."
      }
    }

    assistantContent = finalText ?? 'Done.'
    outcome = { ok: true, status: 200 } as AgentTurnResult
  } catch (err) {
    caughtError = err
    assistantContent = 'Something went wrong while working on that - nothing further was changed.'
    outcome = {
      ok: false,
      status: err instanceof AllowanceExceededError ? 402 : 500,
      error: err instanceof Error ? err.message : 'Unexpected error during agent turn',
    }
  } finally {
    const assistantRow = await insertAssistantReply(supabase, projectId, clientId, assistantContent ?? 'Done.')
    if (outcome.ok) {
      outcome = { ok: true, status: 200, message: assistantRow }
    }

    const { error: settleError } = await settleGeneration(supabase, generation.id, {
      success: outcome.ok,
      error: outcome.ok ? null : outcome.error,
      clearPayload: true,
    })
    if (settleError) {
      console.error('[agent] SETTLE update failed', settleError)
    }

    // Only reachable if a throw happened between a reserve and that same iteration's
    // own markSettled - settle it now so nothing is left 'pending'.
    for (const usageId of usageIds) {
      if (settledUsageIds.has(usageId)) continue
      await settleUsage({
        supabase,
        usageId,
        provider: 'anthropic',
        model: modelsConfig.agent.model,
        status: 'failed',
        breakdown: null,
        error: caughtError,
      })
    }

    emit({ type: 'settled', content: assistantContent ?? 'Done.' })
  }

  return outcome
}
