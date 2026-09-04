import type Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import type { ClaudeGateway } from '@/lib/claude'
import { modelsConfig } from '@/lib/config/models'
import type { UsageBreakdown } from '@/lib/config/pricing'
import { MODEL_REPORTABLE_CAMERA_ORIGINS } from '@/lib/config/enums'
import {
  estimateInputTokens,
  quoteClaudeCall,
  assertWithinAllowance,
  reserveUsage,
  settleUsage,
  AllowanceExceededError,
} from '@/lib/usage'
import {
  CAMERA_FIELD_NAMES,
  CAMERA_FIELD_ENUM,
  CAMERA_DERIVATION_SYSTEM_PROMPT,
  buildDeriveCameraTool,
  buildCameraDynamicBlock,
  type CameraFieldName,
} from '@/lib/prompts/camera-derivation'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type CameraFieldUpdate = { value: string; origin: 'auto' | 'derived' }

export type CameraDerivationResult =
  | { ok: true; status: 200; data: { updated: Partial<Record<CameraFieldName, CameraFieldUpdate>> } }
  | { ok: false; status: 404 | 400 | 402 | 422 | 500; error: string }

type ShotForCamera = {
  id: string
  project_id: string
  visual_description: string | null
  shot_size: string | null
  shot_size_origin: string
  camera_angle: string | null
  camera_angle_origin: string
  camera_movement: string | null
  camera_movement_origin: string
}

// Mirrors actions.ts's loadOwnedShot pattern (duplicated rather than shared, matching
// this repo's existing per-module convention) - shots has no user_id of its own, so
// ownership only resolves through the projects join.
async function loadOwnedShot(
  supabase: SupabaseServerClient,
  shotId: string,
  userId: string
): Promise<ShotForCamera | null> {
  const { data } = await supabase
    .from('shots')
    .select(
      'id, project_id, visual_description, shot_size, shot_size_origin, camera_angle, camera_angle_origin, camera_movement, camera_movement_origin, projects!inner(user_id)'
    )
    .eq('id', shotId)
    .eq('projects.user_id', userId)
    .maybeSingle()
  return data
}

function isValidCameraValue(field: CameraFieldName, value: unknown): value is string {
  return typeof value === 'string' && (CAMERA_FIELD_ENUM[field] as readonly string[]).includes(value)
}

function isValidReportableOrigin(value: unknown): value is 'auto' | 'derived' {
  return typeof value === 'string' && (MODEL_REPORTABLE_CAMERA_ORIGINS as readonly string[]).includes(value)
}

/**
 * Runs the camera re-derivation call for one shot. Two triggers share this one
 * function: `fields` omitted asks about all 3 fields (a visual_description edit);
 * `revertField` set is a single-field "Revert to auto" - it both flips that field's
 * origin away from 'override' and re-derives it in the same call (see CLAUDE.md: this
 * is a deliberate combined-call design, not a separate origin-flip action followed by
 * a route call).
 *
 * No `generations` row is claimed here - see pipeline.ts's OPERATIONS comment. This is
 * a sub-second Haiku call, not expensive/resumable work, and a claim row's terminal
 * 'succeeded' state would block every subsequent edit of the same shot's description.
 */
export async function runCameraDerivation(params: {
  gateway: ClaudeGateway
  supabase: SupabaseServerClient
  projectId: string
  shotId: string
  userId: string
  fields?: CameraFieldName[]
  revertField?: CameraFieldName
}): Promise<CameraDerivationResult> {
  const { gateway, supabase, projectId, shotId, userId, fields, revertField } = params

  const shot = await loadOwnedShot(supabase, shotId, userId)
  if (!shot || shot.project_id !== projectId) {
    return { ok: false, status: 404, error: 'Shot not found' }
  }

  let requestedFields: CameraFieldName[] = fields && fields.length > 0 ? [...fields] : [...CAMERA_FIELD_NAMES]
  if (revertField && !requestedFields.includes(revertField)) {
    requestedFields = [...requestedFields, revertField]
  }

  const originByField: Record<CameraFieldName, string> = {
    shot_size: shot.shot_size_origin,
    camera_angle: shot.camera_angle_origin,
    camera_movement: shot.camera_movement_origin,
  }

  // All-override guard: skipped for a revert, whose whole point is to un-override one
  // field even if all 3 happen to be 'override'. Otherwise, asking Claude about 3
  // fields nobody wants touched would be pure waste - no reserve, no network call.
  if (!revertField) {
    const allOverride = CAMERA_FIELD_NAMES.every((field) => originByField[field] === 'override')
    if (allOverride) {
      return { ok: false, status: 400, error: 'Every camera field is set manually - nothing to re-derive.' }
    }
  }

  let usageId: string | null = null
  let measuredBreakdown: UsageBreakdown | null = null
  let stopReasonForSettle: string | null = null
  let outcome: CameraDerivationResult = { ok: false, status: 500, error: 'Camera derivation did not complete' }
  let caughtError: unknown = null

  try {
    const tool = buildDeriveCameraTool(requestedFields)
    const dynamicBlock = buildCameraDynamicBlock(shot.visual_description ?? '')
    const userMessage = 'Report the camera framing now.'

    const { estimatedCost, quotedBreakdown } = quoteClaudeCall({
      model: modelsConfig.camera.model,
      estimatedInputTokens: estimateInputTokens({
        texts: [CAMERA_DERIVATION_SYSTEM_PROMPT, dynamicBlock, userMessage],
        tools: [tool],
      }),
      maxTokens: modelsConfig.camera.maxTokens,
    })

    await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })

    const reserved = await reserveUsage({
      supabase,
      userId,
      projectId,
      generationId: null,
      shotId,
      step: 'workbench',
      operation: 'derive_camera',
      provider: 'anthropic',
      model: modelsConfig.camera.model,
      quotedCost: estimatedCost,
      quotedBreakdown,
    })
    usageId = reserved.usageId

    const { message, stopReason, requestId } = await gateway.createMessage({
      model: modelsConfig.camera.model,
      max_tokens: modelsConfig.camera.maxTokens,
      system: [
        { type: 'text', text: CAMERA_DERIVATION_SYSTEM_PROMPT },
        { type: 'text', text: dynamicBlock },
      ],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'derive_camera' },
      messages: [{ role: 'user', content: userMessage }],
    })

    measuredBreakdown = message.usage
    stopReasonForSettle = stopReason
    console.warn(`[camera] stopReason=${stopReason} requestId=${requestId}`)

    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'derive_camera'
    )

    if (!toolUseBlock) {
      outcome = { ok: false, status: 500, error: 'Claude did not return camera framing' }
      return outcome
    }

    // Defensive; should be unreachable at a 128-token ceiling for <=3 enum fields, but
    // handled identically to /prompts for consistency - a truncated answer was never
    // "returned successfully" in the sense this contract requires.
    if (stopReason === 'max_tokens') {
      outcome = { ok: false, status: 422, error: 'Camera derivation stopped early before Claude finished.' }
      return outcome
    }

    const input = toolUseBlock.input as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    const applied: Partial<Record<CameraFieldName, CameraFieldUpdate>> = {}

    for (const field of requestedFields) {
      const value = input[field]
      const origin = input[`${field}_origin`]
      if (!isValidCameraValue(field, value) || !isValidReportableOrigin(origin)) continue

      const currentOrigin = originByField[field]
      // Force-apply for the explicit revert target regardless of Claude's answer -
      // reverting always lands on 'auto' (no mention) or 'derived' (explicit mention),
      // both valid non-override states. Otherwise: apply to auto/derived fields
      // unconditionally, and to an override field only when Claude found explicit new
      // textual evidence ('derived') - this is the "description wins over a prior
      // manual choice" rule, enforced here in code, never trusted to the model alone.
      const shouldApply = field === revertField || currentOrigin !== 'override' || origin === 'derived'
      if (!shouldApply) continue

      updates[field] = value
      updates[`${field}_origin`] = origin
      applied[field] = { value, origin }
    }

    if (Object.keys(updates).length === 0) {
      outcome = { ok: false, status: 422, error: 'Claude did not return a usable camera value.' }
      return outcome
    }

    // Camera re-derivation counts as a camera-field edit for staleness purposes, same
    // as a manual dropdown change - see CLAUDE.md's staleness table.
    updates.image_prompt_stale = true
    updates.video_prompt_stale = true

    const { error: updateError } = await supabase.from('shots').update(updates).eq('id', shotId)
    if (updateError) {
      outcome = { ok: false, status: 500, error: updateError.message }
      return outcome
    }

    outcome = { ok: true, status: 200, data: { updated: applied } }
    return outcome
  } catch (err) {
    caughtError = err
    outcome = {
      ok: false,
      status: err instanceof AllowanceExceededError ? 402 : 500,
      error: err instanceof Error ? err.message : 'Unexpected error during camera derivation',
    }
    return outcome
  } finally {
    // SETTLE never throws - see reserve-settle.ts's module docblock. Only reserved
    // on the path that actually called quoteClaudeCall/reserveUsage above; the
    // all-override/not-found guards return before that point, so usageId stays null
    // and no settle is attempted for them.
    if (usageId) {
      await settleUsage({
        supabase,
        usageId,
        provider: 'anthropic',
        model: modelsConfig.camera.model,
        status: measuredBreakdown !== null && stopReasonForSettle !== 'max_tokens' ? 'succeeded' : 'failed',
        breakdown: measuredBreakdown,
        stopReason: stopReasonForSettle,
        error: outcome.ok ? null : caughtError,
      })
    }
  }
}
