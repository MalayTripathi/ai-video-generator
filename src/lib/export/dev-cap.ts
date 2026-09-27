import { EXPORT_DEV_MAX_SEC, EXPORT_DEV_MAX_SHOTS } from '@/lib/config/export'
import type { FilmTimeline } from '@/lib/storyboard/film'

/**
 * Outside production the worker refuses a film over the dev size cap, so a local render
 * stays quick on a small machine. Returns the failure copy, or null when the export may run.
 */
export function devCapError(timeline: FilmTimeline, isProduction: boolean): string | null {
  if (isProduction) return null
  const shots = new Set(timeline.segments.map((s) => s.shotId)).size
  if (shots > EXPORT_DEV_MAX_SHOTS || timeline.totalSec > EXPORT_DEV_MAX_SEC + 1e-6) {
    return `Local exports are limited to ${EXPORT_DEV_MAX_SHOTS} shots and ${EXPORT_DEV_MAX_SEC} seconds. This film is longer, so it renders only on the production export worker.`
  }
  return null
}
