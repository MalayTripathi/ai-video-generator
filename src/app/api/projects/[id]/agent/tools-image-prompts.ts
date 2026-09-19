import type { createClient } from '@/lib/supabase/server'
import { peekGenerationPayload } from '@/lib/generations/claim'
import { parseImagePromptsInstruction } from '@/lib/prompts/image-prompts'
import { runImagePromptGeneration, payloadCoversScope } from '@/app/api/projects/[id]/image-prompts/logic'
import { BILLED_BY_TURN } from '@/app/api/projects/[id]/shots/logic'
import { handleDecline, type AgentToolContext, type AgentToolOutcome } from './tools'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

type TargetShot = { id: string; shot_key: string; order_index: number; image_prompt_edited: boolean }

async function loadShots(supabase: SupabaseServerClient, projectId: string): Promise<TargetShot[] | null> {
  const { data, error } = await supabase
    .from('shots')
    .select('id, shot_key, order_index, image_prompt_edited')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })
  if (error || !data) return null
  return data.filter((s): s is TargetShot => s.shot_key !== null)
}

type StoredResult = 'use' | 'fresh'

function readStoredResult(raw: unknown): StoredResult | undefined {
  return raw === 'use' || raw === 'fresh' ? raw : undefined
}

/**
 * The optional per-generation instruction, validated by the same parser as the HTTP route.
 * Invalid is handed back to the model to correct rather than refused to the user: cutting
 * a note off would silently change what they asked for, and the model can shorten it.
 */
function readInstruction(raw: unknown): { ok: true; instruction: string | null } | { ok: false; outcome: AgentToolOutcome } {
  const parsed = parseImagePromptsInstruction(raw)
  if (parsed.ok) return parsed
  return {
    ok: false,
    outcome: {
      kind: 'deferred',
      forModel: { error: `${parsed.error}. Shorten it to the essential steer and call the tool again.` },
    },
  }
}

/**
 * Shared body of both tools. Everything paid goes through runImagePromptGeneration - the
 * same claim -> recover -> persist -> settle machinery as the Regenerate buttons - with
 * BILLED_BY_TURN so its own fixed per-shot ledger write never fires: this call's measured
 * cost is handed back through onSettled and folded into the turn's single dynamic
 * agent_turn charge (agent/logic.ts), exactly as regenerate_all_shots does.
 */
async function regenerate(
  ctx: AgentToolContext,
  params: {
    input: Record<string, unknown>
    shots: TargetShot[]
    label: string
    shotKey?: string
  }
): Promise<AgentToolOutcome> {
  const parsed = readInstruction(params.input.instruction)
  if (!parsed.ok) return parsed.outcome
  const { instruction } = parsed
  const storedResult = readStoredResult(params.input.stored_result)
  const shotKeys = params.shots.map((s) => s.shot_key)

  // A paid payload the user has not yet seen land, covering exactly this scope. Only worth
  // looking for when it changes what happens: an instruction was given (RECOVER would
  // silently ignore it) or the user has just answered the question about it.
  let storedCovers = false
  if (instruction !== null || storedResult !== undefined) {
    const peek = await peekGenerationPayload(ctx.supabase, {
      projectId: ctx.projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shotId: null,
      elementId: null,
    })
    // A run still in flight (say, another tab's) holds the slot: its payload is about to be
    // applied by that run, not waiting for a decision. Skip the question and go to the
    // runner, whose claim refuses this request as already in progress.
    storedCovers = !peek.error && !peek.heldByLiveRun && peek.payload !== null && payloadCoversScope(peek.payload, shotKeys)
  }

  if (instruction !== null && storedResult === undefined && storedCovers) {
    return {
      kind: 'deferred',
      forModel: {
        status: 'stored_result_available',
        message:
          'A paid result from an earlier attempt is still stored for exactly these prompts and has not been applied. Nothing was regenerated, and the instruction has NOT been applied. Do not call this tool again this turn. Ask the user in plain words whether that earlier result is likely to be useful, or whether they would rather have a fresh one written with their instruction, and end the turn with that question. If they want the stored result, call this tool again with stored_result "use"; if they do not (or it is not useful), call it again with stored_result "fresh" and the original instruction.',
      },
    }
  }

  // 'use' replays the stored result, which cannot carry the instruction; if it has since
  // vanished there is nothing to replay, so the call is simply a fresh one with it.
  const useStored = storedResult === 'use' && storedCovers
  let costUsd: number | undefined
  const result = await runImagePromptGeneration({
    gateway: ctx.gateway,
    supabase: ctx.supabase,
    projectId: ctx.projectId,
    userId: ctx.userId,
    shotIds: params.shots.map((s) => s.id),
    retry: true,
    instruction: useStored ? null : instruction,
    history: ctx.history,
    messageId: ctx.messageId,
    onSettled: (usd) => {
      costUsd = usd
    },
    skipStoredPayload: storedResult === 'fresh',
    // attemptId is required but inert here: it is never read once BILLED_BY_TURN
    // short-circuits the fixed-price write.
    attemptId: crypto.randomUUID(),
    recordFixedSpend: BILLED_BY_TURN,
  })

  // costUsd is set only when a fresh call actually spent, and rides on every outcome: a
  // 422 partial or a truncation is billed exactly like a success (the call is paid for).
  if (!result.ok) {
    if (result.status === 409 || result.status === 402) {
      return {
        kind: 'refused',
        label: "Couldn't rewrite the prompts",
        forModel: { error: result.error },
        shotKey: params.shotKey,
        costUsd,
      }
    }
    if (result.status === 422) {
      return {
        kind: 'errored',
        message: result.error,
        forModel: { error: result.error, missing_shot_keys: result.missingShotKeys ?? [], failed_shot_keys: result.failedShotKeys ?? [] },
        costUsd,
      }
    }
    return { kind: 'errored', message: result.error, forModel: { error: result.error }, costUsd }
  }

  const overwroteHandEdited = params.shots.filter((s) => s.image_prompt_edited).length
  return {
    kind: 'applied',
    label: params.label,
    forModel: {
      rewritten: params.shots.length,
      instruction_applied: instruction !== null && !useStored,
      overwrote_hand_edited_prompts: overwroteHandEdited,
    },
    shotKey: params.shotKey,
    costUsd,
  }
}

export async function handleRegenerateImagePrompt(input: unknown, ctx: AgentToolContext): Promise<AgentToolOutcome> {
  const raw = (input ?? {}) as Record<string, unknown>
  const shotNumber = raw.shot_number
  if (typeof shotNumber !== 'number' || !Number.isInteger(shotNumber) || shotNumber < 1) {
    return { kind: 'errored', message: `Shot ${String(shotNumber)} not found`, forModel: { error: 'not_found' } }
  }
  const shots = await loadShots(ctx.supabase, ctx.projectId)
  if (!shots) return { kind: 'errored', message: 'Could not load the shots', forModel: { error: 'load_failed' } }
  const shot = shots.find((s) => s.order_index === shotNumber - 1)
  if (!shot) {
    return {
      kind: 'errored',
      message: `Shot ${shotNumber} not found`,
      forModel: { error: 'not_found', shot_count: shots.length },
    }
  }
  return regenerate(ctx, { input: raw, shots: [shot], label: `Rewrote Shot ${shotNumber} prompt`, shotKey: shot.shot_key })
}

export async function handleRegenerateAllImagePrompts(input: unknown, ctx: AgentToolContext): Promise<AgentToolOutcome> {
  const raw = (input ?? {}) as Record<string, unknown>
  const shots = await loadShots(ctx.supabase, ctx.projectId)
  if (!shots) return { kind: 'errored', message: 'Could not load the shots', forModel: { error: 'load_failed' } }
  if (shots.length === 0) {
    return { kind: 'errored', message: 'There are no shots to rewrite prompts for', forModel: { error: 'no_shots' } }
  }
  return regenerate(ctx, { input: raw, shots, label: 'Rewrote all image prompts' })
}

export async function dispatchImagePromptsAgentTool(
  name: string,
  input: unknown,
  ctx: AgentToolContext
): Promise<AgentToolOutcome> {
  switch (name) {
    case 'regenerate_image_prompt':
      return handleRegenerateImagePrompt(input, ctx)
    case 'regenerate_all_image_prompts':
      return handleRegenerateAllImagePrompts(input, ctx)
    case 'decline':
      return handleDecline(input)
    default:
      return { kind: 'errored', message: `Unknown tool "${name}"`, forModel: { error: 'unknown_tool' } }
  }
}
