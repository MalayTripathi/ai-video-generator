import { videoModelBounds, type VideoModelConfig } from '@/lib/config/models'
import { SHOT_DURATION_PAD_SEC, WORD_BUDGET_FILL, spokenWordsPerSec } from '@/lib/config/shots'
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

/** The spoken words a scene's remaining seconds hold - each chunk's narration budget. */
export function chunkWordBudget(secondsLeft: number, language: string | null): number {
  return Math.max(0, Math.floor(secondsLeft * spokenWordsPerSec(language) * WORD_BUDGET_FILL))
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

// ---- Valid lengths on every path ---------------------------------------------------------
// Every place a shot's length is set - generation, the Workbench stepper, the agent, the
// Storyboard's drag and nudge, a project's video model change - lands on a length the shot's
// video model renders (isDurationAllowed). These are the shared rules.

const EPS = 1e-9

/** Every length the model renders, shortest first. */
export function allowedModelDurations(model: VideoModelConfig): number[] {
  if (model.kind === 'discrete') return [...model.allowedDurations].sort((a, b) => a - b)
  const out: number[] = []
  for (let i = 0; ; i++) {
    const s = Math.round((model.durationMin + i * model.durationStep) * 1000) / 1000
    if (s > model.durationMax + EPS) break
    out.push(s)
  }
  return out
}

/** The renderable length nearest `seconds` (a tie goes to the longer one). */
export function nearestModelDuration(seconds: number, model: VideoModelConfig): number {
  const allowed = allowedModelDurations(model)
  let best = allowed[0]
  for (const d of allowed) if (Math.abs(d - seconds) <= Math.abs(best - seconds) + EPS) best = d
  return best
}

/** The next renderable length above (1) or below (-1) `seconds`, held at the model's edge. */
export function stepModelDuration(seconds: number, model: VideoModelConfig, direction: 1 | -1): number {
  const allowed = allowedModelDurations(model)
  if (direction === 1) return allowed.find((d) => d > seconds + EPS) ?? allowed[allowed.length - 1]
  return [...allowed].reverse().find((d) => d < seconds - EPS) ?? allowed[0]
}

/** Seconds the words of a shot take to say - narration plus dialogue, without padding. */
export function spokenSeconds(params: { narration: string; dialogue: readonly string[]; language: string | null }): number {
  const words = spokenWordCount(params.narration) + params.dialogue.reduce((n, line) => n + spokenWordCount(line), 0)
  return words / spokenWordsPerSec(params.language)
}

/**
 * A length the model renders that still covers the shot's voice (its spoken seconds plus
 * padding): the current length when it already is one, else the covering length nearest it.
 * When even the model's longest length is too short for the voice, that longest length,
 * flagged - the shot's speech will run past its clip.
 */
export function voiceCoveringDuration(
  currentSec: number | null,
  voiceSec: number,
  model: VideoModelConfig
): { seconds: number; overflow: boolean } {
  const need = voiceSec > 0 ? voiceSec + SHOT_DURATION_PAD_SEC : 0
  const covering = allowedModelDurations(model).filter((d) => d >= need - EPS)
  if (covering.length === 0) return { seconds: videoModelBounds(model).max, overflow: true }
  if (currentSec !== null && covering.some((d) => Math.abs(d - currentSec) < EPS)) return { seconds: currentSec, overflow: false }
  const target = currentSec ?? need
  let best = covering[0]
  for (const d of covering) if (Math.abs(d - target) <= Math.abs(best - target) + EPS) best = d
  return { seconds: best, overflow: false }
}
