export type DurationTarget = '30-60s' | '1-2min' | '3-5min' | '8-10min'

// Single source of truth for the intake screen's pre-selected duration tile.
export const DEFAULT_DURATION_TARGET: DurationTarget = '30-60s'

// A submitted duration tier, falling back to the intake default - the server and the
// pre-selected tile can never disagree on what a missing or unknown value means.
export function parseDurationTarget(raw: string | null): DurationTarget {
  return raw && Object.hasOwn(durationConfig, raw) ? (raw as DurationTarget) : DEFAULT_DURATION_TARGET
}

export type DurationConfig = {
  label: string
  // The intake estimate's shot count and shot generation's pre-flight credit check
  // (2 credits x this) - never a cap on how many shots generation writes.
  targetShots: number
  estimatedCredits: number
  // The tier's seconds range. Shot generation keeps the outline's total inside it and
  // stops writing shots at the maximum; the workbench header's over-target warning reads
  // the maximum too. Not parsed from `label` elsewhere.
  targetSecondsMin: number
  targetSecondsMax: number
  // The length the outline is asked for: the middle of the range (a product choice).
  targetSeconds: number
}

// The intake duration tiles, shot generation and its pre-flight check all read from
// this map — the numbers live nowhere else.
export const durationConfig: Record<DurationTarget, DurationConfig> = {
  '30-60s': { label: '30–60s', targetShots: 8, estimatedCredits: 50, targetSecondsMin: 30, targetSecondsMax: 60, targetSeconds: 45 },
  '1-2min': { label: '1–2 min', targetShots: 15, estimatedCredits: 90, targetSecondsMin: 60, targetSecondsMax: 120, targetSeconds: 90 },
  '3-5min': { label: '3–5 min', targetShots: 40, estimatedCredits: 240, targetSecondsMin: 180, targetSecondsMax: 300, targetSeconds: 240 },
  '8-10min': { label: '8–10 min', targetShots: 75, estimatedCredits: 450, targetSecondsMin: 480, targetSecondsMax: 600, targetSeconds: 540 },
}
