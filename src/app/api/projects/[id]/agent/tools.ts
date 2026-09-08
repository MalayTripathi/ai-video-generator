import type { createClient } from '@/lib/supabase/server'
import type { ClaudeGateway } from '@/lib/claude'
import type { Tables } from '@/lib/database.types'
import { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, MODEL_REPORTABLE_CAMERA_ORIGINS } from '@/lib/config/enums'
import { stalenessFor, type ShotFieldChange } from '@/lib/shot-staleness'
import { stepIndex } from '@/lib/config/pipeline'
import { generateUniqueShotKeys, MAX_SHOT_KEY_INSERT_ATTEMPTS, isUniqueViolation } from '@/lib/shot-key'
import { buildShotIndexBlock } from '@/lib/prompts/agent'
import { runShotGeneration } from '@/app/api/projects/[id]/shots/logic'
import { voiceOverIsValid, EMPTY_VOICEOVER_MESSAGE } from '@/lib/shot-voiceover'
import { visualDescriptionIsValid, EMPTY_VISUAL_DESCRIPTION_MESSAGE } from '@/lib/shot-visual-description'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type ShotRow = Tables<'shots'>

export type AgentToolContext = {
  supabase: SupabaseServerClient
  gateway: ClaudeGateway
  projectId: string
  userId: string
  // Precomputed once per turn (stepIndex(project.furthest_step)) - every mutation
  // handler checks it, zero extra queries per tool call.
  furthestStepIndex: number
  messageId: string
}

export type AgentToolOutcome =
  // shotKey identifies the specific shot a mutation/refusal is about, for the client to
  // lock that card or refetch it - stable across order_index renumbering, unlike a
  // display number. Omitted when the tool/refusal concerns the whole list, not one shot
  // (regenerate_all_shots; a lock refusal before any shot was resolved).
  | { kind: 'applied'; label: string; forModel: unknown; shotKey?: string }
  | { kind: 'refused'; label: string; forModel: unknown; shotKey?: string }
  | { kind: 'errored'; message: string; forModel: unknown }

const READ_ONLY_LOCK_MESSAGE =
  "This project's workbench is locked - later steps have already started, so shots can no longer be changed here."

function isReadOnlyLocked(ctx: AgentToolContext): boolean {
  return ctx.furthestStepIndex >= stepIndex('storyboard')
}

async function loadShotByNumber(
  supabase: SupabaseServerClient,
  projectId: string,
  shotNumber: unknown
): Promise<ShotRow | null> {
  if (typeof shotNumber !== 'number' || !Number.isInteger(shotNumber) || shotNumber < 1) return null
  const { data } = await supabase
    .from('shots')
    .select('*')
    .eq('project_id', projectId)
    .eq('order_index', shotNumber - 1)
    .maybeSingle()
  return data
}

type BoundCharacter = { id: string; name: string }

async function loadBoundCharacters(supabase: SupabaseServerClient, shotId: string): Promise<BoundCharacter[]> {
  const { data } = await supabase
    .from('shot_elements')
    .select('elements(id, name, type)')
    .eq('shot_id', shotId)

  const characters: BoundCharacter[] = []
  for (const row of data ?? []) {
    // PostgREST's embed shape for a to-one FK isn't always inferred as a single object
    // by the generated types - normalize to a list defensively rather than fight it.
    const embedded = row.elements as { id: string; name: string; type: string } | { id: string; name: string; type: string }[] | null
    const items = Array.isArray(embedded) ? embedded : embedded ? [embedded] : []
    for (const item of items) {
      if (item.type === 'character') characters.push({ id: item.id, name: item.name })
    }
  }
  return characters
}

async function loadDialogue(supabase: SupabaseServerClient, shotId: string) {
  const { data } = await supabase
    .from('shot_dialogue')
    .select('element_id, line')
    .eq('shot_id', shotId)
    .order('order_index', { ascending: true })
  return data ?? []
}

async function rebuildShotIndex(supabase: SupabaseServerClient, projectId: string): Promise<string> {
  const { data } = await supabase
    .from('shots')
    .select('order_index, visual_description, voice_over, shot_size_origin, camera_angle_origin, camera_movement_origin')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })
  return buildShotIndexBlock(data ?? [])
}

// ---------------------------------------------------------------------------
// get_shot
// ---------------------------------------------------------------------------

export async function handleGetShot(input: unknown, ctx: AgentToolContext): Promise<AgentToolOutcome> {
  const shotNumber = (input as { shot_number?: unknown })?.shot_number
  const shot = await loadShotByNumber(ctx.supabase, ctx.projectId, shotNumber)
  if (!shot) {
    return { kind: 'errored', message: `Shot ${String(shotNumber)} not found`, forModel: { error: 'not_found' } }
  }

  const [boundCharacters, dialogue] = await Promise.all([
    loadBoundCharacters(ctx.supabase, shot.id),
    loadDialogue(ctx.supabase, shot.id),
  ])
  const byId = new Map(boundCharacters.map((c) => [c.id, c.name]))

  return {
    kind: 'applied',
    label: `Looked at Shot ${shotNumber}`,
    forModel: {
      shot_number: shot.order_index + 1,
      voice_over: shot.voice_over,
      visual_description: shot.visual_description,
      duration_sec: shot.duration_sec,
      section_label: shot.section_label,
      shot_size: shot.shot_size,
      shot_size_origin: shot.shot_size_origin,
      camera_angle: shot.camera_angle,
      camera_angle_origin: shot.camera_angle_origin,
      camera_movement: shot.camera_movement,
      camera_movement_origin: shot.camera_movement_origin,
      dialogue: dialogue.map((d) => ({ speaker_name: byId.get(d.element_id) ?? 'unknown', line: d.line })),
      bound_characters: boundCharacters.map((c) => c.name),
    },
    shotKey: shot.shot_key,
  }
}

// ---------------------------------------------------------------------------
// update_shot
// ---------------------------------------------------------------------------

type CameraField = 'shot_size' | 'camera_angle' | 'camera_movement'

const CAMERA_ORIGIN_COLUMN: Record<CameraField, `${CameraField}_origin`> = {
  shot_size: 'shot_size_origin',
  camera_angle: 'camera_angle_origin',
  camera_movement: 'camera_movement_origin',
}

const CAMERA_ENUM: Record<CameraField, readonly string[]> = {
  shot_size: SHOT_SIZES,
  camera_angle: CAMERA_ANGLES,
  camera_movement: CAMERA_MOVEMENTS,
}

const CAMERA_FIELDS: CameraField[] = ['shot_size', 'camera_angle', 'camera_movement']

function has(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key)
}

type DialogueInputLine = { speaker_name: string; line: string }

function isDialogueInputLine(value: unknown): value is DialogueInputLine {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.speaker_name === 'string' && typeof v.line === 'string'
}

/**
 * Resolves a new dialogue array's speakers against this shot's ALREADY-bound
 * characters only - never creates or modifies a row in `elements` or `shot_elements`.
 * Element binding is C5's subject and unbuilt; `runShotsPipeline` (shots/logic.ts) is
 * the single production writer of `shot_elements`, writing it only from the model's own
 * original shot output, and that single-writer invariant is worth keeping intact for
 * when C5 starts. It also avoids silent duplicate characters ("Sarah" / "sarah" /
 * "Sarah J." as three unmergeable rows) and an unrequested future paid reference-image
 * render - "one reference image per element, reused across shots" is a standing money
 * rule (see CLAUDE.md's Cost policy). An agent write here can rewrite an existing
 * bound-character line's text, remove a line, or add a line for an already-bound
 * character; it can never introduce a speaker not already on this shot. Returns `null`
 * for a malformed shape (refuses as a structural issue); returns `unresolved` names
 * (refuses as a scope issue, listing which speakers ARE valid) when any speaker isn't
 * already bound.
 */
async function resolveDialogue(
  supabase: SupabaseServerClient,
  shotId: string,
  rawDialogue: unknown
): Promise<{ resolved: { element_id: string; line: string }[]; unresolved: string[]; bound: BoundCharacter[] } | null> {
  if (!Array.isArray(rawDialogue)) return null
  const lines = rawDialogue.filter(isDialogueInputLine)

  const bound = await loadBoundCharacters(supabase, shotId)
  const byLowerName = new Map(bound.map((c) => [c.name.toLowerCase(), c]))

  const resolved: { element_id: string; line: string }[] = []
  const unresolved: string[] = []
  for (const line of lines) {
    const character = byLowerName.get(line.speaker_name.trim().toLowerCase())
    if (!character) {
      unresolved.push(line.speaker_name)
      continue
    }
    resolved.push({ element_id: character.id, line: line.line })
  }

  return { resolved, unresolved, bound }
}

function dialogueUnchanged(
  current: { element_id: string; line: string }[],
  next: { element_id: string; line: string }[]
): boolean {
  if (current.length !== next.length) return false
  return current.every((row, i) => row.element_id === next[i].element_id && row.line === next[i].line)
}

export async function handleUpdateShot(input: unknown, ctx: AgentToolContext): Promise<AgentToolOutcome> {
  const raw = (input ?? {}) as Record<string, unknown>
  const shot = await loadShotByNumber(ctx.supabase, ctx.projectId, raw.shot_number)
  if (!shot) {
    return {
      kind: 'errored',
      message: `Shot ${String(raw.shot_number)} not found`,
      forModel: { error: 'not_found' },
    }
  }

  if (isReadOnlyLocked(ctx)) {
    return {
      kind: 'refused',
      label: `Couldn't update Shot ${raw.shot_number} - the workbench is locked`,
      forModel: { error: READ_ONLY_LOCK_MESSAGE },
      shotKey: shot.shot_key,
    }
  }

  // Dialogue resolves FIRST: any speaker not yet bound to this shot is auto-created (or
  // reused project-wide by name) and bound, never refused - see resolveDialogue's own
  // docblock. Only a malformed shape refuses the call.
  let dialogueWrite: { element_id: string; line: string }[] | null = null
  let dialogueChanged = false
  if (has(raw, 'dialogue')) {
    const result = await resolveDialogue(ctx.supabase, shot.id, raw.dialogue)
    if (!result) {
      return {
        kind: 'refused',
        label: `Couldn't update Shot ${raw.shot_number} - dialogue was malformed`,
        forModel: { error: 'dialogue must be an array of {speaker_name, line}' },
        shotKey: shot.shot_key,
      }
    }
    if (result.unresolved.length > 0) {
      return {
        kind: 'refused',
        label: `Couldn't update Shot ${raw.shot_number} - unknown dialogue speaker(s)`,
        forModel: {
          error: `These speakers are not bound to this shot, so they can't be used: ${result.unresolved.join(', ')}. Characters already bound to this shot: ${
            result.bound.map((c) => c.name).join(', ') || 'none'
          }.`,
        },
        shotKey: shot.shot_key,
      }
    }
    const current = await loadDialogue(ctx.supabase, shot.id)
    dialogueChanged = !dialogueUnchanged(current, result.resolved)
    dialogueWrite = result.resolved
  }

  // A shot needs narration or dialogue, not necessarily both - see shot-voiceover.ts.
  // Checked against the EFFECTIVE post-call state (this call's own voice_over/dialogue
  // if included, else the shot's persisted values), before any write, same as every
  // other refusal in this function.
  const effectiveVoiceOver = has(raw, 'voice_over') && typeof raw.voice_over === 'string' ? raw.voice_over.trim() : shot.voice_over
  if (effectiveVoiceOver === '') {
    const effectiveDialogueCount = dialogueWrite !== null ? dialogueWrite.length : (await loadDialogue(ctx.supabase, shot.id)).length
    if (!voiceOverIsValid(effectiveVoiceOver, effectiveDialogueCount > 0)) {
      return {
        kind: 'refused',
        label: `Couldn't update Shot ${raw.shot_number} - no narration or dialogue`,
        forModel: { error: EMPTY_VOICEOVER_MESSAGE },
        shotKey: shot.shot_key,
      }
    }
  }

  // visual_description is the sole input to image/video prompts (both paid) and to
  // camera re-derivation - same effective-post-call-state check as voice_over above,
  // before any write.
  const effectiveVisualDescription =
    has(raw, 'visual_description') && typeof raw.visual_description === 'string'
      ? raw.visual_description.trim()
      : (shot.visual_description ?? '')
  if (!visualDescriptionIsValid(effectiveVisualDescription)) {
    return {
      kind: 'refused',
      label: `Couldn't update Shot ${raw.shot_number} - visual description can't be empty`,
      forModel: { error: EMPTY_VISUAL_DESCRIPTION_MESSAGE },
      shotKey: shot.shot_key,
    }
  }

  const updates: Record<string, unknown> = {}
  const staleChanges: ShotFieldChange[] = []

  if (has(raw, 'voice_over') && typeof raw.voice_over === 'string') {
    const trimmed = raw.voice_over.trim()
    if (trimmed !== shot.voice_over) {
      updates.voice_over = trimmed
      staleChanges.push('voice_over')
    }
  }

  if (has(raw, 'visual_description') && typeof raw.visual_description === 'string') {
    const trimmed = raw.visual_description.trim()
    if (trimmed !== (shot.visual_description ?? '')) {
      updates.visual_description = trimmed
      staleChanges.push('visual_description')
    }
  }

  if (has(raw, 'section_label') && typeof raw.section_label === 'string') {
    const trimmed = raw.section_label.trim() || null
    if (trimmed !== shot.section_label) {
      updates.section_label = trimmed
    }
  }

  if (has(raw, 'duration_sec') && typeof raw.duration_sec === 'number') {
    const rounded = Math.round(raw.duration_sec * 10) / 10
    if (rounded !== shot.duration_sec) {
      updates.duration_sec = rounded
      updates.duration_locked = true
    }
  }

  for (const field of CAMERA_FIELDS) {
    if (!has(raw, field)) continue
    const value = raw[field]
    const originValue = raw[`${field}_origin`]
    if (typeof value !== 'string' || !CAMERA_ENUM[field].includes(value)) continue
    const suppliedOrigin =
      typeof originValue === 'string' && (MODEL_REPORTABLE_CAMERA_ORIGINS as readonly string[]).includes(originValue)
        ? originValue
        : 'auto'

    const originColumn = CAMERA_ORIGIN_COLUMN[field]
    const currentOrigin = shot[originColumn]
    // A field already marked 'override' is protected: only real new textual evidence
    // ('derived') can move it. Mirrors runCameraDerivation's identical rule.
    const shouldApply = currentOrigin !== 'override' || suppliedOrigin === 'derived'
    if (!shouldApply) continue

    if (shot[field] === value && currentOrigin === suppliedOrigin) continue

    updates[field] = value
    updates[originColumn] = suppliedOrigin
    staleChanges.push('camera')
  }

  if (dialogueWrite !== null && dialogueChanged) {
    staleChanges.push('dialogue')
  }

  for (const change of staleChanges) {
    const staleness = stalenessFor(change)
    Object.assign(updates, staleness.shot)
    if (Object.keys(staleness.project).length > 0) {
      await ctx.supabase.from('projects').update(staleness.project).eq('id', ctx.projectId)
    }
  }

  if (Object.keys(updates).length > 0) {
    const { error } = await ctx.supabase.from('shots').update(updates).eq('id', shot.id)
    if (error) {
      return { kind: 'errored', message: error.message, forModel: { error: error.message } }
    }
  }

  if (dialogueWrite !== null && dialogueChanged) {
    const { error: deleteError } = await ctx.supabase.from('shot_dialogue').delete().eq('shot_id', shot.id)
    if (deleteError) {
      return { kind: 'errored', message: deleteError.message, forModel: { error: deleteError.message } }
    }
    if (dialogueWrite.length > 0) {
      const rows = dialogueWrite.map((line, index) => ({
        shot_id: shot.id,
        project_id: ctx.projectId,
        element_id: line.element_id,
        line: line.line,
        order_index: index,
      }))
      const { error: insertError } = await ctx.supabase.from('shot_dialogue').insert(rows)
      if (insertError) {
        return { kind: 'errored', message: insertError.message, forModel: { error: insertError.message } }
      }
    }
  }

  const nothingChanged = Object.keys(updates).length === 0 && !(dialogueWrite !== null && dialogueChanged)
  return {
    kind: 'applied',
    label: nothingChanged ? `No changes needed for Shot ${raw.shot_number}` : `Updated Shot ${raw.shot_number}`,
    forModel: { updated: !nothingChanged },
    shotKey: shot.shot_key,
  }
}

// ---------------------------------------------------------------------------
// insert_shot
// ---------------------------------------------------------------------------

export async function handleInsertShot(input: unknown, ctx: AgentToolContext): Promise<AgentToolOutcome> {
  const raw = (input ?? {}) as Record<string, unknown>

  if (isReadOnlyLocked(ctx)) {
    return {
      kind: 'refused',
      label: "Couldn't insert a shot - the workbench is locked",
      forModel: { error: READ_ONLY_LOCK_MESSAGE },
    }
  }

  const insertAfter = raw.insert_after_shot_number
  if (typeof insertAfter !== 'number' || !Number.isInteger(insertAfter) || insertAfter < 0) {
    return { kind: 'errored', message: 'insert_after_shot_number must be a non-negative integer', forModel: { error: 'invalid_input' } }
  }
  if (typeof raw.voice_over !== 'string' || raw.voice_over.trim().length === 0) {
    return { kind: 'errored', message: 'voice_over is required', forModel: { error: 'invalid_input' } }
  }

  const visualDescription = typeof raw.visual_description === 'string' ? raw.visual_description.trim() : ''
  if (!visualDescriptionIsValid(visualDescription)) {
    return {
      kind: 'refused',
      label: "Couldn't insert a shot - visual description can't be empty",
      forModel: { error: EMPTY_VISUAL_DESCRIPTION_MESSAGE },
    }
  }

  const { data: existingShots } = await ctx.supabase
    .from('shots')
    .select('id, order_index')
    .eq('project_id', ctx.projectId)
    .order('order_index', { ascending: false })
  const shots = existingShots ?? []

  let newOrderIndex = 0
  if (insertAfter > 0) {
    const anchor = shots.find((s) => s.order_index === insertAfter - 1)
    if (!anchor) {
      return {
        kind: 'errored',
        message: `Shot ${insertAfter} not found`,
        forModel: { error: 'not_found' },
      }
    }
    newOrderIndex = anchor.order_index + 1
  }

  // Shift every shot at or after the insertion point up by one, highest order_index
  // first - shots_project_id_order_index_key is a UNIQUE constraint, so shifting in
  // ascending order would transiently collide with a row not yet moved.
  const toShift = shots.filter((s) => s.order_index >= newOrderIndex).sort((a, b) => b.order_index - a.order_index)
  for (const s of toShift) {
    const { error } = await ctx.supabase.from('shots').update({ order_index: s.order_index + 1 }).eq('id', s.id)
    if (error) {
      return { kind: 'errored', message: error.message, forModel: { error: error.message } }
    }
  }

  const camera: Record<string, string | null> = {
    shot_size: null,
    shot_size_origin: 'auto',
    camera_angle: null,
    camera_angle_origin: 'auto',
    camera_movement: null,
    camera_movement_origin: 'auto',
  }
  for (const field of CAMERA_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string' && CAMERA_ENUM[field].includes(value)) {
      camera[field] = value
      const originValue = raw[`${field}_origin`]
      camera[CAMERA_ORIGIN_COLUMN[field]] =
        typeof originValue === 'string' && (MODEL_REPORTABLE_CAMERA_ORIGINS as readonly string[]).includes(originValue)
          ? originValue
          : 'auto'
    }
  }

  let insertError: { message: string } | null = null
  let insertedShotKey: string | null = null
  for (let attempt = 0; attempt < MAX_SHOT_KEY_INSERT_ATTEMPTS; attempt++) {
    const [shotKey] = generateUniqueShotKeys(1)
    const { error } = await ctx.supabase.from('shots').insert({
      project_id: ctx.projectId,
      order_index: newOrderIndex,
      shot_key: shotKey,
      voice_over: raw.voice_over.trim(),
      visual_description: visualDescription,
      duration_sec: typeof raw.duration_sec === 'number' ? raw.duration_sec : null,
      section_label: typeof raw.section_label === 'string' ? raw.section_label.trim() || null : null,
      duration_locked: false,
      ...camera,
    })
    if (!error) {
      insertError = null
      insertedShotKey = shotKey
      break
    }
    if (!isUniqueViolation(error)) {
      insertError = error
      break
    }
    insertError = error
  }

  if (insertError) {
    return { kind: 'errored', message: insertError.message, forModel: { error: insertError.message } }
  }

  const shotIndex = await rebuildShotIndex(ctx.supabase, ctx.projectId)
  return {
    kind: 'applied',
    label:
      insertAfter === 0
        ? 'Inserted a new shot at the start'
        : `Inserted a new shot after Shot ${insertAfter}`,
    forModel: { shot_index: shotIndex },
    shotKey: insertedShotKey ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// regenerate_all_shots
// ---------------------------------------------------------------------------

export async function handleRegenerateAllShots(_input: unknown, ctx: AgentToolContext): Promise<AgentToolOutcome> {
  if (isReadOnlyLocked(ctx)) {
    return {
      kind: 'refused',
      label: "Couldn't regenerate shots - the workbench is locked",
      forModel: { error: READ_ONLY_LOCK_MESSAGE },
    }
  }

  // Tighter than the general read-only lock: only allowed at exactly workbench. Once
  // the user has moved on to image prompts, paid output exists that a wholesale
  // shot-list replacement would destroy.
  if (ctx.furthestStepIndex !== stepIndex('workbench')) {
    return {
      kind: 'refused',
      label: "Couldn't regenerate shots - later steps have already produced work this would destroy",
      forModel: {
        error:
          "Shots can't be regenerated from scratch anymore - later steps have already produced work that this would destroy.",
      },
    }
  }

  const result = await runShotGeneration({
    gateway: ctx.gateway,
    supabase: ctx.supabase,
    projectId: ctx.projectId,
    userId: ctx.userId,
    retry: true,
    messageId: ctx.messageId,
  })

  if (!result.ok) {
    if (result.status === 409 || result.status === 402) {
      return { kind: 'refused', label: "Couldn't regenerate shots", forModel: { error: result.error } }
    }
    return { kind: 'errored', message: result.error, forModel: { error: result.error } }
  }

  // Cost is no longer embedded here: runAgentTurn's sumTurnCost sums ALL of this turn's
  // usage rows (this generate_shots call plus the surrounding agent_turn iterations' own
  // spend), not just this one operation's row - see docs/decisions.md.
  return {
    kind: 'applied',
    label: 'Regenerated all shots',
    forModel: { shot_count: result.data.shots.length },
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function dispatchAgentTool(
  name: string,
  input: unknown,
  ctx: AgentToolContext
): Promise<AgentToolOutcome> {
  switch (name) {
    case 'get_shot':
      return handleGetShot(input, ctx)
    case 'update_shot':
      return handleUpdateShot(input, ctx)
    case 'insert_shot':
      return handleInsertShot(input, ctx)
    case 'regenerate_all_shots':
      return handleRegenerateAllShots(input, ctx)
    default:
      return { kind: 'errored', message: `Unknown tool "${name}"`, forModel: { error: 'unknown_tool' } }
  }
}
