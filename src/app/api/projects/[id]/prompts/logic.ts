export type ScenePrompt = {
  scene_key: string
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

export function isScenePrompt(value: unknown): value is ScenePrompt {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.scene_key === 'string' &&
    hasUsablePrompt(v.image_prompt) &&
    hasUsablePrompt(v.video_prompt)
  )
}

export function needsPrompts(scene: {
  image_prompt: string | null
  video_prompt: string | null
}): boolean {
  return !hasUsablePrompt(scene.image_prompt) || !hasUsablePrompt(scene.video_prompt)
}

/**
 * Matches Claude's raw write_prompts tool input against the scene_keys that
 * were actually requested. Entries that are malformed, too short, or for a
 * scene_key that wasn't requested are dropped rather than persisted.
 */
export function resolvePromptResults(
  rawPrompts: unknown,
  targetSceneKeys: string[]
): { validEntries: ScenePrompt[]; missingSceneKeys: string[] } {
  const entries = Array.isArray(rawPrompts) ? rawPrompts.filter(isScenePrompt) : []
  const targetSet = new Set(targetSceneKeys)
  const validEntries = entries.filter((entry) => targetSet.has(entry.scene_key))

  const returnedKeys = new Set(validEntries.map((entry) => entry.scene_key))
  const missingSceneKeys = targetSceneKeys.filter((key) => !returnedKeys.has(key))

  return { validEntries, missingSceneKeys }
}
