/**
 * Below this length a prompt is treated as unusable (empty, whitespace, or
 * a degenerate model response) rather than as real content - it's rejected
 * before persistence instead of being written as garbage.
 */
export const MIN_PROMPT_LENGTH = 50

export function hasUsablePrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= MIN_PROMPT_LENGTH
}
