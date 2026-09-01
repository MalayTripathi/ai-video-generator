export type DurationTarget = '30-60s' | '1-2min' | '3-5min' | '8-10min'

// Single source of truth for the intake screen's pre-selected duration tile.
export const DEFAULT_DURATION_TARGET: DurationTarget = '30-60s'

export type DurationConfig = {
  label: string
  targetShots: number
  estimatedCredits: number
}

// Both the intake duration tiles and the shot-generation prompt read from
// this map — the numbers live nowhere else.
export const durationConfig: Record<DurationTarget, DurationConfig> = {
  '30-60s': { label: '30–60s', targetShots: 8, estimatedCredits: 50 },
  '1-2min': { label: '1–2 min', targetShots: 15, estimatedCredits: 90 },
  '3-5min': { label: '3–5 min', targetShots: 40, estimatedCredits: 240 },
  '8-10min': { label: '8–10 min', targetShots: 75, estimatedCredits: 450 },
}
