import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Tables } from '@/lib/database.types'
import type { VideoModelConfig } from '@/lib/config/models'
import {
  SHOT_SIZES,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  SHOT_ELEMENT_TYPES,
  MODEL_REPORTABLE_CAMERA_ORIGINS,
} from '@/lib/config/enums'
import { generateUniqueShotKeys, isUniqueViolation, MAX_SHOT_KEY_INSERT_ATTEMPTS } from '@/lib/shot-key'
import { computeShotDuration } from './durations'
import { chunkShotOrderIndex } from './positions'

// One chunk's write: its raw write_shots tool input parsed, durations computed in code,
// elements resolved (deduped by name across the whole run), and the shots, their element
// bindings and dialogue inserted - every batch built with one uniform map.

type Client = SupabaseClient<Database>
type ElementRow = Tables<'elements'>

export type RawDialogueLine = { speaker_name: string; line: string }
export type RawElementRef = { name: string; type: string; description: string }

export type RawShot = {
  voice_over: string
  visual_description: string
  shot_size: string | null
  camera_angle: string | null
  camera_movement: string | null
  shot_size_origin: string | null
  camera_angle_origin: string | null
  camera_movement_origin: string | null
  duration_sec: number | null
  dialogue: RawDialogueLine[]
  element_names: RawElementRef[]
}

/**
 * DB CHECK constraints reject an unrecognized value outright. Claude occasionally drifts
 * from the declared enum despite a strict schema, so an unrecognized value is nulled (the
 * column is nullable) rather than failing the whole shot.
 */
export function sanitizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function isDialogueLine(value: unknown): value is RawDialogueLine {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.speaker_name === 'string' && typeof v.line === 'string' && v.line.trim().length > 0
}

function isElementRef(value: unknown): value is RawElementRef {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.name === 'string' && v.name.trim().length > 0 && typeof v.type === 'string' && typeof v.description === 'string'
}

/**
 * A shot with no voice_over and no visual_description is unusable - there is nothing to
 * narrate or draw. Everything else (missing camera fields) is tolerated and left null
 * rather than dropping the shot.
 */
export function isUsableShot(shot: RawShot): boolean {
  return shot.voice_over.trim().length > 0 || shot.visual_description.trim().length > 0
}

/** Parses a write_shots tool input's shots, dropping only shots with nothing to narrate or draw. */
export function parseRawShots(rawShots: unknown): RawShot[] {
  if (!Array.isArray(rawShots)) return []
  return rawShots
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map(
      (v): RawShot => ({
        voice_over: typeof v.voice_over === 'string' ? v.voice_over : '',
        visual_description: typeof v.visual_description === 'string' ? v.visual_description : '',
        shot_size: typeof v.shot_size === 'string' ? v.shot_size : null,
        camera_angle: typeof v.camera_angle === 'string' ? v.camera_angle : null,
        camera_movement: typeof v.camera_movement === 'string' ? v.camera_movement : null,
        shot_size_origin: typeof v.shot_size_origin === 'string' ? v.shot_size_origin : null,
        camera_angle_origin: typeof v.camera_angle_origin === 'string' ? v.camera_angle_origin : null,
        camera_movement_origin: typeof v.camera_movement_origin === 'string' ? v.camera_movement_origin : null,
        duration_sec: typeof v.duration_sec === 'number' ? v.duration_sec : null,
        dialogue: Array.isArray(v.dialogue) ? v.dialogue.filter(isDialogueLine) : [],
        element_names: Array.isArray(v.element_names) ? v.element_names.filter(isElementRef) : [],
      })
    )
    .filter(isUsableShot)
}

export type PreparedShot = RawShot & { seconds: number; narrationOverflow: boolean }

// Every key write_shots requires on a shot. A shot an answer cut short at max_tokens left
// without one of them was still being written.
const REQUIRED_SHOT_KEYS = [
  'voice_over',
  'visual_description',
  'shot_size',
  'camera_angle',
  'camera_movement',
  'shot_size_origin',
  'camera_angle_origin',
  'camera_movement_origin',
  'duration_sec',
  'dialogue',
  'element_names',
] as const

/**
 * The shots of an answer cut short at max_tokens that were written in full. The tool input
 * is parsed from partial JSON, so the shot being written when the answer stopped can look
 * whole with its text cut mid-sentence: the last shot is kept only when the answer went on
 * to `scene_complete` (the shots array had closed), and every kept shot has every key.
 */
export function completeShotsOfTruncated(rawInput: unknown): unknown[] {
  const input = (rawInput ?? {}) as { shots?: unknown; scene_complete?: unknown }
  if (!Array.isArray(input.shots)) return []
  const closed = typeof input.scene_complete === 'boolean'
  const candidates = closed ? input.shots : input.shots.slice(0, -1)
  return candidates.filter(
    (v) => typeof v === 'object' && v !== null && REQUIRED_SHOT_KEYS.every((k) => Object.hasOwn(v as object, k))
  )
}

/**
 * Parsed shots with their code-computed durations, in order. A truncated answer keeps only
 * its complete shots and never reports its scene complete - the next chunk continues it.
 */
export function prepareChunkShots(
  rawInput: unknown,
  ctx: { language: string | null; model: VideoModelConfig; truncated?: boolean }
): { shots: PreparedShot[]; sceneComplete: boolean } {
  const input = (rawInput ?? {}) as { shots?: unknown; scene_complete?: unknown }
  const rawShots = ctx.truncated ? completeShotsOfTruncated(rawInput) : input.shots
  const shots = parseRawShots(rawShots).map((shot) => {
    const { seconds, narrationOverflow } = computeShotDuration({
      narration: shot.voice_over,
      dialogue: shot.dialogue.map((d) => d.line),
      silentEstimateSec: shot.duration_sec,
      language: ctx.language,
      model: ctx.model,
    })
    return { ...shot, seconds, narrationOverflow }
  })
  return { shots, sceneComplete: !ctx.truncated && input.scene_complete === true }
}

/**
 * Resolves element names to rows, deduped by lower(name) across every chunk of a run.
 * The (project_id, lower(name)) unique index is the race safety net between chunks
 * running in parallel. Soft-deleted elements are never reused.
 */
export class ElementResolver {
  private readonly byLowerName = new Map<string, ElementRow>()

  constructor(
    private readonly supabase: Client,
    private readonly projectId: string,
    existing: readonly ElementRow[]
  ) {
    for (const el of existing) this.byLowerName.set(el.name.toLowerCase(), el)
  }

  static async load(supabase: Client, projectId: string): Promise<ElementResolver> {
    const { data, error } = await supabase.from('elements').select('*').eq('project_id', projectId).is('deleted_at', null)
    if (error) throw new Error(error.message)
    return new ElementResolver(supabase, projectId, data ?? [])
  }

  async resolve(name: string, type: string, description: string | null): Promise<ElementRow> {
    const key = name.trim().toLowerCase()
    const existing = this.byLowerName.get(key)
    if (existing) return existing

    const { data, error } = await this.supabase
      .from('elements')
      .insert({ project_id: this.projectId, name: name.trim(), type, description: description?.trim() || null })
      .select('*')
      .single()
    if (error) {
      if (isUniqueViolation(error)) {
        const { data: raced } = await this.supabase
          .from('elements')
          .select('*')
          .eq('project_id', this.projectId)
          .is('deleted_at', null)
          .ilike('name', name.trim())
          .single()
        if (raced) {
          this.byLowerName.set(key, raced)
          return raced
        }
      }
      throw new Error(error.message)
    }
    this.byLowerName.set(key, data)
    return data
  }
}

// The style element is project-level and must never be bound to a shot. resolve() dedups
// by lower(name) alone, so a per-shot reference sharing the style's name would otherwise
// resolve to that row and get bound.
function assertNotStyle(el: ElementRow): void {
  if (el.type === 'style') throw new Error(`"${el.name}" is the project's style element and cannot be bound to a shot`)
}

export type ChunkPlacement = { sceneId: string; scenePosition: number; chunkIndex: number }

/**
 * Inserts a chunk's accepted shots at their provisional positions, then their element
 * bindings and dialogue. Throws on a write failure - the caller marks the chunk failed.
 */
export async function insertChunkShots(
  supabase: Client,
  projectId: string,
  elements: ElementResolver,
  placement: ChunkPlacement,
  shots: readonly PreparedShot[]
): Promise<Tables<'shots'>[]> {
  if (shots.length === 0) return []

  const builds: { elementIds: string[]; dialogue: { element_id: string; line: string }[] }[] = []
  for (const shot of shots) {
    const elementIds = new Set<string>()
    for (const ref of shot.element_names) {
      const el = await elements.resolve(ref.name, sanitizeEnum(ref.type, SHOT_ELEMENT_TYPES) ?? 'prop', ref.description)
      assertNotStyle(el)
      elementIds.add(el.id)
    }
    const dialogue: { element_id: string; line: string }[] = []
    for (const line of shot.dialogue) {
      const el = await elements.resolve(line.speaker_name, 'character', null)
      assertNotStyle(el)
      elementIds.add(el.id)
      dialogue.push({ element_id: el.id, line: line.line })
    }
    builds.push({ elementIds: [...elementIds], dialogue })
  }

  let inserted: Tables<'shots'>[] | null = null
  let lastError: { message: string } | null = null
  // A unique violation here can only be a shot_key collision: provisional positions are
  // unique per chunk, and a dead attempt's leftovers were deleted before this write.
  for (let attempt = 0; attempt < MAX_SHOT_KEY_INSERT_ATTEMPTS; attempt++) {
    const keys = generateUniqueShotKeys(shots.length)
    const rows = shots.map((shot, i) => ({
      project_id: projectId,
      scene_id: placement.sceneId,
      order_index: chunkShotOrderIndex(placement.scenePosition, placement.chunkIndex, i),
      shot_key: keys[i],
      voice_over: shot.voice_over,
      visual_description: shot.visual_description || null,
      shot_size: sanitizeEnum(shot.shot_size, SHOT_SIZES),
      camera_angle: sanitizeEnum(shot.camera_angle, CAMERA_ANGLES),
      camera_movement: sanitizeEnum(shot.camera_movement, CAMERA_MOVEMENTS),
      // The origin columns are NOT NULL, so an unrecognized/missing value falls back to
      // 'auto' - it never claims the description names a camera choice.
      shot_size_origin: sanitizeEnum(shot.shot_size_origin, MODEL_REPORTABLE_CAMERA_ORIGINS) ?? 'auto',
      camera_angle_origin: sanitizeEnum(shot.camera_angle_origin, MODEL_REPORTABLE_CAMERA_ORIGINS) ?? 'auto',
      camera_movement_origin: sanitizeEnum(shot.camera_movement_origin, MODEL_REPORTABLE_CAMERA_ORIGINS) ?? 'auto',
      duration_sec: shot.seconds,
      narration_overflow: shot.narrationOverflow,
      duration_locked: false,
    }))
    const { data, error } = await supabase.from('shots').insert(rows).select('*')
    if (!error) {
      inserted = (data ?? []).sort((a, b) => a.order_index - b.order_index)
      break
    }
    lastError = error
    if (!isUniqueViolation(error)) break
  }
  if (!inserted) throw new Error(lastError?.message ?? 'Failed to insert shots')

  const shotElementRows = inserted.flatMap((row, i) => builds[i].elementIds.map((elementId) => ({ shot_id: row.id, element_id: elementId })))
  if (shotElementRows.length > 0) {
    const { error } = await supabase.from('shot_elements').insert(shotElementRows)
    if (error) throw new Error(error.message)
  }

  const dialogueRows = inserted.flatMap((row, i) =>
    builds[i].dialogue.map((d, lineIndex) => ({
      shot_id: row.id,
      project_id: projectId,
      element_id: d.element_id,
      line: d.line,
      order_index: lineIndex,
    }))
  )
  if (dialogueRows.length > 0) {
    const { error } = await supabase.from('shot_dialogue').insert(dialogueRows)
    if (error) throw new Error(error.message)
  }
  return inserted
}
