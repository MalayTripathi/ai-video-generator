import type { createClient } from '@/lib/supabase/server'
import type { ClaudeGateway } from '@/lib/claude'
import { logClaudeUsage } from '@/lib/claude'
import { modelsConfig } from '@/lib/config/models'
import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import { generateUniqueShotKeys, isUniqueViolation, MAX_SHOT_KEY_INSERT_ATTEMPTS } from '@/lib/shot-key'
import {
  SHOT_GENERATION_SYSTEM_PROMPT_V2,
  WRITE_SHOTS_TOOL,
  buildShotsDynamicBlock,
} from '@/lib/prompts/shot-generation'
import type { Json, Tables } from '@/lib/database.types'
import type Anthropic from '@anthropic-ai/sdk'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type ElementRow = Tables<'elements'>

const SHOT_SIZES = ['wide', 'full', 'medium', 'close_up', 'extreme_close_up'] as const
const CAMERA_ANGLES = ['eye_level', 'low', 'high', 'over_the_shoulder', 'top_down'] as const
const CAMERA_MOVEMENTS = [
  'static',
  'slow_push_in',
  'pull_out',
  'pan',
  'tilt',
  'orbit',
  'handheld',
] as const
const ELEMENT_TYPES = ['character', 'location', 'prop'] as const
const VIDEO_TYPES = [
  'narrated_story',
  'explainer',
  'facts_listicle',
  'character_drama',
  'product_ad',
  'trailer',
] as const

// Tied to claude.ts's 600s SDK timeout + margin. Duplicated (not imported) from
// generation-lock.ts's constant of the same name/value: that module stays reserved for
// /prompts, which still uses the old generating_at-only CAS lock. Keep both in sync
// manually if either changes.
const STALE_AFTER_MS = 15 * 60 * 1000

export type ShotsGenerationStatus = 'pending' | 'generating' | 'ready' | 'failed'

const SHOTS_GENERATION_STATUSES: readonly ShotsGenerationStatus[] = [
  'pending',
  'generating',
  'ready',
  'failed',
]

/**
 * database.types.ts types the column as plain `string` (Supabase codegen doesn't emit
 * CHECK constraints as literal unions). An unrecognized value fails safe toward 'pending'
 * so an unexpected value re-attempts generation rather than getting permanently stuck.
 */
export function isShotsGenerationStatus(value: unknown): value is ShotsGenerationStatus {
  return typeof value === 'string' && (SHOTS_GENERATION_STATUSES as string[]).includes(value)
}

export type RawDialogueLine = { speaker_name: string; line: string }
export type RawElementRef = { name: string; type: string; description: string }

export type RawShot = {
  voice_over: string
  visual_description: string
  shot_size: string | null
  camera_angle: string | null
  camera_movement: string | null
  duration_sec: number | null
  section_label: string | null
  dialogue: RawDialogueLine[]
  element_names: RawElementRef[]
}

/**
 * DB CHECK constraints reject an unrecognized value outright. Claude
 * occasionally drifts from the declared enum despite a strict schema, so an
 * unrecognized value is nulled (the column is nullable) rather than failing
 * the whole shot.
 */
export function sanitizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

function isDialogueLine(value: unknown): value is RawDialogueLine {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.speaker_name === 'string' && typeof v.line === 'string' && v.line.trim().length > 0
}

function isElementRef(value: unknown): value is RawElementRef {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    typeof v.type === 'string' &&
    typeof v.description === 'string'
  )
}

function isRawShotShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A shot with no voice_over and no visual_description is unusable - there is
 * nothing to narrate or draw. Everything else (missing camera fields, an
 * empty section_label) is tolerated and left null/generic rather than
 * dropping the shot.
 */
export function isUsableShot(shot: RawShot): boolean {
  return shot.voice_over.trim().length > 0 || shot.visual_description.trim().length > 0
}

/**
 * Parses Claude's raw write_shots tool input into usable shots, dropping
 * only shots with neither narration nor a visual to draw from.
 */
export function parseRawShots(rawShots: unknown): RawShot[] {
  if (!Array.isArray(rawShots)) return []

  const shots = rawShots.filter(isRawShotShape).map(
    (v): RawShot => ({
      voice_over: typeof v.voice_over === 'string' ? v.voice_over : '',
      visual_description: typeof v.visual_description === 'string' ? v.visual_description : '',
      shot_size: typeof v.shot_size === 'string' ? v.shot_size : null,
      camera_angle: typeof v.camera_angle === 'string' ? v.camera_angle : null,
      camera_movement: typeof v.camera_movement === 'string' ? v.camera_movement : null,
      duration_sec: typeof v.duration_sec === 'number' ? v.duration_sec : null,
      section_label: typeof v.section_label === 'string' ? v.section_label.trim() || null : null,
      dialogue: Array.isArray(v.dialogue) ? v.dialogue.filter(isDialogueLine) : [],
      element_names: Array.isArray(v.element_names) ? v.element_names.filter(isElementRef) : [],
    })
  )

  return shots.filter(isUsableShot)
}

export type ShotsResponseBody = {
  title: string | null
  message: string
  video_type: string | null
  shots: {
    id: string
    order_index: number
    shot_key: string
    section_label: string | null
    voice_over: string
    visual_description: string | null
    duration_sec: number | null
    duration_locked: boolean
    shot_size: string | null
    camera_angle: string | null
    camera_movement: string | null
    dialogue: { element_id: string; element_name: string; line: string }[]
    elements: { id: string; name: string; type: string; status: string; reference_image_path: string | null }[]
  }[]
}

export type ShotGenerationResult =
  | { ok: true; status: 200; data: ShotsResponseBody }
  | { ok: false; status: 404; error: string }
  | {
      ok: false
      status: 409
      error: string
      reason: 'already_ready' | 'already_generating' | 'retry_required'
    }
  | { ok: false; status: 422; error: string }
  | { ok: false; status: 500; error: string }

type ClaimedProject = {
  source_text: string | null
  video_type: string | null
  language: string | null
  duration_target: string | null
  title: string | null
}

/**
 * CLAIM. One atomic conditional UPDATE is both the lock and the idempotency guard: it only
 * matches a row that is 'pending', or 'generating' with a stale generating_at, or (only
 * when retry is requested) 'failed'. A zero-row result means the claim was refused - no
 * code path below this function can reach the gateway without a claim in hand.
 */
async function claimShotsGeneration(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string,
  retry: boolean
): Promise<
  | { ok: true; project: ClaimedProject; pendingPayload: unknown | null }
  | { ok: false; result: ShotGenerationResult }
> {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString()

  const orParts = [
    'shots_generation.eq.pending',
    `and(shots_generation.eq.generating,generating_at.lt.${staleBefore})`,
  ]
  if (retry) orParts.push('shots_generation.eq.failed')

  const { data, error } = await supabase
    .from('projects')
    .update({ shots_generation: 'generating', generating_at: new Date().toISOString() })
    .eq('id', projectId)
    .eq('user_id', userId)
    .or(orParts.join(','))
    .select('source_text, video_type, language, duration_target, title, pending_shots_payload')

  if (error) {
    return { ok: false, result: { ok: false, status: 500, error: error.message } }
  }

  const claimed = data?.[0]
  if (claimed) {
    return {
      ok: true,
      project: {
        source_text: claimed.source_text,
        video_type: claimed.video_type,
        language: claimed.language,
        duration_target: claimed.duration_target,
        title: claimed.title,
      },
      pendingPayload: claimed.pending_shots_payload,
    }
  }

  // The claim was refused. This follow-up read is purely informational - it never feeds
  // back into a write, so it can't compromise the atomic decision the UPDATE already made.
  const { data: current } = await supabase
    .from('projects')
    .select('shots_generation')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()

  if (!current) {
    return { ok: false, result: { ok: false, status: 404, error: 'Project not found' } }
  }
  if (current.shots_generation === 'ready') {
    return {
      ok: false,
      result: {
        ok: false,
        status: 409,
        error: 'Shots have already been generated for this project.',
        reason: 'already_ready',
      },
    }
  }
  if (current.shots_generation === 'generating') {
    return {
      ok: false,
      result: {
        ok: false,
        status: 409,
        error: 'A generation is already in progress for this project.',
        reason: 'already_generating',
      },
    }
  }
  // 'failed' without retry, or the rare 'pending' race window, both read as retry_required.
  return {
    ok: false,
    result: {
      ok: false,
      status: 409,
      error: 'The last generation failed. Retry to try again.',
      reason: 'retry_required',
    },
  }
}

/**
 * Runs the parse -> resolve-elements -> insert-shots -> shot_elements -> dialogue pipeline
 * against a write_shots tool input. Called from both the fresh-Claude-call path and the
 * RECOVER path - rawInput is either the live toolUseBlock.input or a stored
 * pending_shots_payload, identical shape either way.
 */
async function runShotsPipeline(
  supabase: SupabaseServerClient,
  projectId: string,
  project: ClaimedProject,
  rawInput: unknown
): Promise<
  { ok: true; status: 200; data: ShotsResponseBody } | { ok: false; status: 422 | 500; error: string }
> {
  const input = rawInput as {
    title?: unknown
    message?: unknown
    video_type?: unknown
    shots?: unknown
  }

  const validatedShots = parseRawShots(input.shots).map((shot) => ({
    ...shot,
    shot_size: sanitizeEnum(shot.shot_size, SHOT_SIZES),
    camera_angle: sanitizeEnum(shot.camera_angle, CAMERA_ANGLES),
    camera_movement: sanitizeEnum(shot.camera_movement, CAMERA_MOVEMENTS),
  }))

  if (validatedShots.length === 0) {
    return {
      ok: false,
      status: 422,
      error: "Couldn't build the shot list. The model returned nothing usable.",
    }
  }

  const parsedTitle = typeof input.title === 'string' ? input.title.trim().slice(0, 60) || null : null
  const parsedMessage = typeof input.message === 'string' ? input.message.trim() : ''
  const parsedVideoType = sanitizeEnum(input.video_type, VIDEO_TYPES)

  // Dedup source of truth: reused across the whole request so two shots naming the same
  // new element resolve to one row, not one each. The project's (project_id, lower(name))
  // unique index is only a race safety net, not the primary mechanism - hence the
  // sequential awaits below.
  const { data: existingElements, error: elementsFetchError } = await supabase
    .from('elements')
    .select('*')
    .eq('project_id', projectId)

  if (elementsFetchError) {
    return { ok: false, status: 500, error: elementsFetchError.message }
  }

  const elementsByLowerName = new Map<string, ElementRow>()
  for (const el of existingElements ?? []) {
    elementsByLowerName.set(el.name.toLowerCase(), el)
  }

  async function resolveElement(
    name: string,
    type: string,
    description: string | null
  ): Promise<ElementRow> {
    const key = name.trim().toLowerCase()
    const existing = elementsByLowerName.get(key)
    if (existing) return existing

    const { data, error } = await supabase
      .from('elements')
      .insert({
        project_id: projectId,
        name: name.trim(),
        type,
        description: description?.trim() || null,
      })
      .select('*')
      .single()

    if (error) {
      if (isUniqueViolation(error)) {
        const { data: raced } = await supabase
          .from('elements')
          .select('*')
          .eq('project_id', projectId)
          .ilike('name', name.trim())
          .single()
        if (raced) {
          elementsByLowerName.set(key, raced)
          return raced
        }
      }
      throw new Error(error.message)
    }

    elementsByLowerName.set(key, data)
    return data
  }

  type ShotBuild = {
    shot: RawShot
    elementIds: string[]
    elementsForResponse: ElementRow[]
    dialogueResolved: { element_id: string; element_name: string; line: string }[]
  }

  const shotBuilds: ShotBuild[] = []

  try {
    for (const shot of validatedShots) {
      const elementIds = new Set<string>()
      const elementsForResponse: ElementRow[] = []

      for (const ref of shot.element_names) {
        const type = sanitizeEnum(ref.type, ELEMENT_TYPES) ?? 'prop'
        const el = await resolveElement(ref.name, type, ref.description)
        if (!elementIds.has(el.id)) {
          elementIds.add(el.id)
          elementsForResponse.push(el)
        }
      }

      const dialogueResolved: { element_id: string; element_name: string; line: string }[] = []
      for (const line of shot.dialogue) {
        const el = await resolveElement(line.speaker_name, 'character', null)
        if (!elementIds.has(el.id)) {
          elementIds.add(el.id)
          elementsForResponse.push(el)
        }
        dialogueResolved.push({ element_id: el.id, element_name: el.name, line: line.line })
      }

      shotBuilds.push({ shot, elementIds: [...elementIds], elementsForResponse, dialogueResolved })
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'Failed to resolve elements',
    }
  }

  let insertedShots: Tables<'shots'>[] | null = null
  let insertError: { message: string } | null = null

  for (let attempt = 0; attempt < MAX_SHOT_KEY_INSERT_ATTEMPTS; attempt++) {
    const shotKeys = generateUniqueShotKeys(validatedShots.length)
    const rows = validatedShots.map((shot, index) => ({
      project_id: projectId,
      order_index: index,
      shot_key: shotKeys[index],
      voice_over: shot.voice_over,
      visual_description: shot.visual_description || null,
      shot_size: shot.shot_size,
      camera_angle: shot.camera_angle,
      camera_movement: shot.camera_movement,
      duration_sec: shot.duration_sec,
      section_label: shot.section_label,
      duration_locked: false,
      camera_overridden: false,
    }))

    const { data, error } = await supabase.from('shots').insert(rows).select('*')

    if (!error) {
      insertedShots = (data ?? []).sort((a, b) => a.order_index - b.order_index)
      insertError = null
      break
    }

    if (!isUniqueViolation(error)) {
      insertError = error
      break
    }
    insertError = error
  }

  if (!insertedShots) {
    return { ok: false, status: 500, error: insertError?.message ?? 'Failed to insert shots' }
  }

  const shotElementRows = insertedShots.flatMap((shotRow, index) =>
    shotBuilds[index].elementIds.map((elementId) => ({ shot_id: shotRow.id, element_id: elementId }))
  )

  if (shotElementRows.length > 0) {
    const { error: shotElementsError } = await supabase.from('shot_elements').insert(shotElementRows)
    if (shotElementsError) {
      return { ok: false, status: 500, error: shotElementsError.message }
    }
  }

  const dialogueUpdates = insertedShots
    .map((shotRow, index) => ({ shotRow, dialogue: shotBuilds[index].dialogueResolved }))
    .filter(({ dialogue }) => dialogue.length > 0)

  const dialogueResults = await Promise.all(
    dialogueUpdates.map(({ shotRow, dialogue }) =>
      supabase
        .from('shots')
        .update({ dialogue: dialogue.map(({ element_id, line }) => ({ element_id, line })) })
        .eq('id', shotRow.id)
    )
  )
  const dialogueError = dialogueResults.find((r) => r.error)?.error
  if (dialogueError) {
    return { ok: false, status: 500, error: dialogueError.message }
  }

  // Guarded: only write the title if the user hasn't set one since creation
  // (still null, matching createProjectFromIntake's title: null on insert).
  if (parsedTitle && project.title === null) {
    await supabase.from('projects').update({ title: parsedTitle }).eq('id', projectId).is('title', null)
  }
  const appliedTitle = project.title ?? parsedTitle

  // Guarded: only resolve video_type when the user left it on auto-detect;
  // never overwrite a type chosen explicitly at intake.
  if (parsedVideoType && project.video_type === 'auto') {
    await supabase
      .from('projects')
      .update({ video_type: parsedVideoType })
      .eq('id', projectId)
      .eq('video_type', 'auto')
  }
  const appliedVideoType =
    project.video_type === 'auto' ? (parsedVideoType ?? project.video_type) : project.video_type

  if (parsedMessage) {
    await supabase
      .from('messages')
      .insert({ project_id: projectId, role: 'assistant', content: parsedMessage })
  }

  return {
    ok: true,
    status: 200,
    data: {
      title: appliedTitle,
      message: parsedMessage,
      video_type: appliedVideoType,
      shots: insertedShots.map((shotRow, index) => ({
        id: shotRow.id,
        order_index: shotRow.order_index,
        shot_key: shotRow.shot_key,
        section_label: shotRow.section_label,
        voice_over: shotRow.voice_over,
        visual_description: shotRow.visual_description,
        duration_sec: shotRow.duration_sec,
        duration_locked: shotRow.duration_locked,
        shot_size: shotRow.shot_size,
        camera_angle: shotRow.camera_angle,
        camera_movement: shotRow.camera_movement,
        dialogue: shotBuilds[index].dialogueResolved,
        elements: shotBuilds[index].elementsForResponse.map((el) => ({
          id: el.id,
          name: el.name,
          type: el.type,
          status: el.status,
          reference_image_path: el.reference_image_path,
        })),
      })),
    },
  }
}

export async function runShotGeneration(params: {
  gateway: ClaudeGateway
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  retry: boolean
}): Promise<ShotGenerationResult> {
  const { gateway, supabase, projectId, userId, retry } = params

  const claim = await claimShotsGeneration(supabase, projectId, userId, retry)
  if (!claim.ok) return claim.result // never entered 'generating' - nothing to settle

  const { project, pendingPayload } = claim
  let outcome: ShotGenerationResult = {
    ok: false,
    status: 500,
    error: 'Shot generation did not complete',
  }
  let clearPayloadOnSettle = false

  try {
    // RECOVER BEFORE SPEND. A stored pending_shots_payload means Claude has already been
    // paid for; recovery replays it and never re-calls the gateway.
    if (pendingPayload !== null) {
      console.warn(
        `[shots] recovering pending_shots_payload for project=${projectId} - skipping a new Claude call`
      )
      outcome = await runShotsPipeline(supabase, projectId, project, pendingPayload)
      return outcome
    }

    const targetShots =
      project.duration_target && project.duration_target in durationConfig
        ? durationConfig[project.duration_target as DurationTarget].targetShots
        : durationConfig['1-2min'].targetShots

    const { message, stopReason, requestId } = await gateway.createMessage({
      model: modelsConfig.shots.model,
      max_tokens: modelsConfig.shots.maxTokens,
      system: [
        { type: 'text', text: SHOT_GENERATION_SYSTEM_PROMPT_V2, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: buildShotsDynamicBlock(project, targetShots) },
      ],
      tools: [WRITE_SHOTS_TOOL],
      tool_choice: { type: 'tool', name: 'write_shots' },
      messages: [{ role: 'user', content: 'Generate the shot list now.' }],
    })

    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'write_shots'
    )

    if (!toolUseBlock) {
      await logClaudeUsage(supabase, projectId, 'shots', modelsConfig.shots.model, message.usage)
      outcome = { ok: false, status: 500, error: 'Claude did not return a shot list' }
      return outcome
    }

    // PERSIST BEFORE WRITING. Lands before any shot row insert - if the process dies
    // between here and SETTLE, the payload is already safe to recover on the next claim.
    const { error: persistError } = await supabase
      .from('projects')
      .update({ pending_shots_payload: toolUseBlock.input as Json })
      .eq('id', projectId)

    await logClaudeUsage(supabase, projectId, 'shots', modelsConfig.shots.model, message.usage)
    console.warn(`[shots] stopReason=${stopReason} requestId=${requestId}`)

    if (persistError) {
      // Hard gate: do not fall through and insert using the in-memory input anyway - doing
      // so would defeat the safety net for exactly the failure mode it exists to cover.
      outcome = {
        ok: false,
        status: 500,
        error: `Claude returned a shot list, but it could not be saved safely (${persistError.message}). Retry to regenerate.`,
      }
      return outcome
    }

    const pipelineResult = await runShotsPipeline(supabase, projectId, project, toolUseBlock.input)

    // TRUNCATION. A max_tokens stop was never a successful return, so - unlike a normal
    // failure - the payload is cleared here rather than left for a later recovery: leaving
    // it would make a retry replay the same truncated answer forever instead of asking
    // Claude for a fresh, complete one.
    if (stopReason === 'max_tokens') {
      clearPayloadOnSettle = true
      outcome = {
        ok: false,
        status: 422,
        error:
          'Generation stopped early before Claude finished the shot list.' +
          (pipelineResult.ok
            ? ` ${pipelineResult.data.shots.length} shot(s) were saved, but the list is incomplete. Retry to regenerate.`
            : ' Retry to regenerate.'),
      }
      return outcome
    }

    outcome = pipelineResult
    return outcome
  } catch (err) {
    outcome = {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : 'Unexpected error during shot generation',
    }
    return outcome
  } finally {
    // SETTLE. Runs on every exit, including a thrown exception, so a project can never be
    // left stuck 'generating'.
    try {
      if (outcome.ok) {
        await supabase
          .from('projects')
          .update({ shots_generation: 'ready', generating_at: null, pending_shots_payload: null })
          .eq('id', projectId)
      } else {
        await supabase
          .from('projects')
          .update({
            shots_generation: 'failed',
            generating_at: null,
            ...(clearPayloadOnSettle ? { pending_shots_payload: null } : {}),
          })
          .eq('id', projectId)
      }
    } catch (settleErr) {
      // No further safety net for a failed SETTLE write - logged, not thrown, so it can
      // never override the already-decided outcome being returned.
      console.error('[shots] SETTLE update failed', settleErr)
    }
  }
}
