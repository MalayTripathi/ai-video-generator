import type { AspectRatio } from './enums'
import { isProduction } from './env'
import { tuningEnv } from './env.server'

// Export render and worker tunables (Storyboard F), from env class D (env.ts), so the app
// and the standalone worker in worker/ read the same numbers. Film-level defaults
// and presets (output sizes, captions, loudness) live in storyboard.ts.

const tuning = tuningEnv()

// x264 quality and the output frame rate.
export const EXPORT_CRF = tuning.exportCrf
export const EXPORT_FPS = tuning.exportFps

// Each still is scaled up by this factor before zoompan, so the move lands on sub-pixel
// positions of a larger image instead of stepping whole output pixels (the jitter).
export const EXPORT_MOTION_UPSCALE = tuning.exportMotionUpscale

// How often an idle worker looks for a queued export.
export const EXPORT_POLL_MS = tuning.exportPollMs

// A job still rendering this long after it started is marked failed on the next poll.
export const EXPORT_STUCK_TIMEOUT_MS = tuning.exportStuckTimeoutMs

// Succeeded exports kept per project; older ones are deleted with their files.
export const EXPORT_RETENTION = 5

// How many history rows the page shows beyond the kept succeeded ones (active and failed).
export const EXPORT_HISTORY_LIMIT = 10

// Lifetime of the signed output URLs the history returns.
export const EXPORT_SIGNED_URL_EXPIRES_S = 3600

// Outside production the worker refuses a larger film and renders smaller, so a local
// render stays quick on a small machine.
export const EXPORT_DEV_MAX_SHOTS = tuning.exportDevMaxShots
export const EXPORT_DEV_MAX_SEC = tuning.exportDevMaxSec
export const EXPORT_DEV_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '9:16': { width: 360, height: 640 },
  '16:9': { width: 640, height: 360 },
  '1:1': { width: 480, height: 480 },
}

export const exportIsProduction = (): boolean => isProduction()
