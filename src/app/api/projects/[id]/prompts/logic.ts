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
