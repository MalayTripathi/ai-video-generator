import type { PromptShot } from './types'

type PromptState = Pick<PromptShot, 'image_prompt' | 'image_prompt_stale' | 'image_prompt_edited'>

// The stale/edited flags have been accumulating since before prompts existed, so a flag
// alone means nothing: every reading here is gated on the prompt actually being there.
export function hasPrompt(shot: Pick<PromptShot, 'image_prompt'>): boolean {
  return shot.image_prompt !== null && shot.image_prompt.trim() !== ''
}

// A shot with no prompt is ungenerated - never stale, never counted by Regenerate Stale.
export function isUngenerated(shot: Pick<PromptShot, 'image_prompt'>): boolean {
  return !hasPrompt(shot)
}

export function isStale(shot: PromptState): boolean {
  return hasPrompt(shot) && shot.image_prompt_stale
}

export function isEdited(shot: PromptState): boolean {
  return hasPrompt(shot) && shot.image_prompt_edited
}

// The one automatic generation: on first arrival, when nothing has ever been attempted
// (no generations row) and no shot has a prompt. Anything else - a failed or partial
// run, a succeeded one - is the person's call, never a re-fire on reopen.
export function shouldAutoGenerate({
  generationState,
  shots,
  readOnly,
}: {
  generationState: string | null
  shots: Pick<PromptShot, 'image_prompt'>[]
  readOnly: boolean
}): boolean {
  if (readOnly) return false
  if (generationState !== null && generationState !== 'pending') return false
  return shots.length > 0 && shots.every(isUngenerated)
}

// "Shot 2" / "Shots 2 and 5" / "Shots 2, 3 and 5"
export function describeShotNumbers(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b).map(String)
  if (sorted.length === 0) return 'Those shots'
  if (sorted.length === 1) return `Shot ${sorted[0]}`
  return `Shots ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`
}
