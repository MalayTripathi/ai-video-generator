import { videoModelBounds, type VideoModelConfig } from '@/lib/config/models'
import { SHOT_DURATION_PAD_SEC, spokenWordsPerSec } from '@/lib/config/shots'
import { countWords } from '@/lib/word-count'

// A shot's duration is computed here, never chosen by Claude: the words spoken in it at
// the project language's pace, plus padding, rounded UP to a length the project's video
// model can render and kept inside the model's range. Pure - no I/O.

// Inline eleven_v3 audio tags ([slowly], [warmly]) shape delivery but are not spoken.
const AUDIO_TAG = /\[[^\]]*\]/g

/** Words actually spoken in a line of narration or dialogue. */
export function spokenWordCount(text: string): number {
  return countWords(text.replace(AUDIO_TAG, ' '))
}

/**
 * The shortest length the model allows that holds `seconds`: the next whole step for a
 * range model, the next allowed value for a discrete one - kept within the model's
 * minimum and maximum either way.
 */
export function roundUpToModelDuration(seconds: number, model: VideoModelConfig): number {
  const { min, max } = videoModelBounds(model)
  if (model.kind === 'discrete') {
    const allowed = [...model.allowedDurations].sort((a, b) => a - b)
    return allowed.find((d) => d >= seconds - 1e-9) ?? max
  }
  const step = model.durationStep
  const up = Math.ceil(seconds / step - 1e-9) * step
  return Math.min(max, Math.max(min, Math.round(up * 1000) / 1000))
}

/**
 * The most narration words one shot can hold at the model's longest length - the prompt
 * tells Claude to split narration longer than this into two shots.
 */
export function maxNarrationWordsPerShot(model: VideoModelConfig, language: string | null): number {
  return Math.floor(videoModelBounds(model).max * spokenWordsPerSec(language))
}

export type ComputedDuration = { seconds: number; narrationOverflow: boolean }

/**
 * Duration for one generated shot. Spoken shots: (narration words + dialogue words) /
 * words-per-second + padding, rounded up to the model's lengths and clamped; one whose
 * speech still runs past the model's maximum is clamped there and flagged. Silent shots
 * (no narration, no dialogue) take Claude's whole-second estimate, within the same limits.
 */
export function computeShotDuration(params: {
  narration: string
  dialogue: readonly string[]
  silentEstimateSec: number | null
  language: string | null
  model: VideoModelConfig
}): ComputedDuration {
  const { model } = params
  const { min, max } = videoModelBounds(model)
  const words = spokenWordCount(params.narration) + params.dialogue.reduce((n, line) => n + spokenWordCount(line), 0)

  if (words === 0) {
    const estimate = params.silentEstimateSec
    const seconds = typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0 ? Math.round(estimate) : min
    return { seconds: roundUpToModelDuration(seconds, model), narrationOverflow: false }
  }

  const raw = words / spokenWordsPerSec(params.language) + SHOT_DURATION_PAD_SEC
  return { seconds: roundUpToModelDuration(raw, model), narrationOverflow: raw > max + 1e-9 }
}

/**
 * Fit to voiceover's length for a narrated shot: its measured spoken span plus padding,
 * rounded up the same way. Fit never writes a fractional second.
 */
export function fittedShotSeconds(spokenSec: number, model: VideoModelConfig): number {
  return roundUpToModelDuration(Math.max(0, spokenSec) + SHOT_DURATION_PAD_SEC, model)
}
