// A hand-edited image prompt only has to be non-blank. The model-output floor in
// prompts/prompt-validation.ts (MIN_PROMPT_LENGTH) guards against a degenerate
// response, not a person's own words, so it deliberately does not apply here.
export const EMPTY_IMAGE_PROMPT_MESSAGE = "A prompt can't be empty. Regenerate to write a new one."

export function imagePromptIsValid(value: string): boolean {
  return value.trim() !== ''
}
