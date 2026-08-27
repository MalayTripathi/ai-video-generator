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
