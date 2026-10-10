import { CLAIM_STALE_MARGIN_MS } from './storyboard'

// Shot generation (Workbench): an outline call plans the scenes, then chunk calls write
// each scene's shots, run as a self-continuing server chain. Every size, timing and
// pacing number lives here, never at a call site and never in env. Models and their
// max_tokens live in models.ts (modelsConfig.shotOutline / modelsConfig.shots).

// The most shots one chunk request writes. Derived, not chosen: measured ~316 output
// tokens per shot on Haiku (one generate_shots row, 1,262 tokens for 4 shots), designed at
// 400 to leave room for longer prose and dialogue - 8 x 400 = 3,200 expected tokens, under
// the chunk's 4,000 max_tokens. At the measured ~26 tokens/s end to end that is ~125s
// expected and ~154s at the ceiling. Re-measure on Sonnet before production (roadmap).
export const SHOTS_PER_CHUNK = 8

// Route maxDuration for /api/projects/[id]/shots, in seconds (mirrors the literal in the
// route file). Vercel Hobby's ceiling.
export const SHOTS_ROUTE_MAX_DURATION_S = 300

// One run stops starting chunks after this, lets its in-flight chunks drain, then hands
// the rest to a fresh run. Budget + the slowest chunk (~154s) + the hand-off stays under
// the route's maxDuration, and runs never overlap - so a run's running totals are exact.
export const SHOT_RUN_BUDGET_MS = 120_000

// The hand-off request to the continuation run. Past this it counts as refused.
export const SHOT_HANDOFF_TIMEOUT_MS = 15_000

// How many times a run may hand itself to a continuation. A chain that reaches it stops,
// and "Generate remaining shots" picks up the unwritten scenes.
export const SHOT_CHAIN_LIMIT = 16

// Parallel chunk requests per run.
export const SHOT_CHUNK_CONCURRENCY = 3

// A 'running' shot run whose heartbeat is older than this belongs to a dead chain. Every
// run re-stamps the heartbeat when it starts and as each chunk finishes, so the longest
// live gap is one chunk plus a hand-off - well inside a route's maxDuration plus margin.
export const SHOT_RUN_STALE_AFTER_MS = SHOTS_ROUTE_MAX_DURATION_S * 1000 + CLAIM_STALE_MARGIN_MS

// A chunk left 'running' this long was in a run that died: the next run retries it,
// replaying its stored payload when there is one.
export const SHOT_CHUNK_STALE_AFTER_MS = SHOT_RUN_STALE_AFTER_MS

// Spoken words per second, per project language, for a shot's computed duration. English
// is measured from a stored voiceover (2.19 rechecked); a language not yet measured uses
// the English value. scripts/measure-voiceover-wps.mjs reports the figures.
export const SPOKEN_WORDS_PER_SEC: Readonly<Record<string, number>> = { en: 2.17 }
export const DEFAULT_SPOKEN_WORDS_PER_SEC = 2.17

export function spokenWordsPerSec(language: string | null): number {
  return (language && SPOKEN_WORDS_PER_SEC[language]) || DEFAULT_SPOKEN_WORDS_PER_SEC
}

// Added to a shot's spoken length before it is rounded up to a length the video model
// allows - at generation (from the word count) and at Fit to voiceover (from the measured
// span). Gaps between spoken spans measured p50 0.12s, max 0.21s.
export const SHOT_DURATION_PAD_SEC = 0.25

// Chunk shot positions before the run's final re-sequence: a chunk's shots take
// order_index = BASE + scene position x SCENE_STRIDE + chunk index x SHOTS_PER_CHUNK + i,
// unique across parallel chunks and above any contiguous index a project already holds.
export const SHOT_ORDER_BASE = 1_000_000
export const SHOT_ORDER_SCENE_STRIDE = 10_000
