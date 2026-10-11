import { CLAIM_STALE_MARGIN_MS } from './storyboard'
import { SHOTS_ROUTE_MAX_DURATION_S } from './shot-timing'

// Shot generation (Workbench): an outline call plans the scenes, then chunk calls write
// each scene's shots, run as a self-continuing server chain. Every size, timing and
// pacing number lives here, never at a call site and never in env. Models and their
// max_tokens come from env through models.server.ts (modelsConfig.shotOutline / .shots).

// The most shots one chunk request writes. Measured on Haiku 5.5 (Oct 10 2026 live run):
// 306-364 output tokens per shot, so 8 shots is ~2,700-2,900 tokens - well under the
// chunk's max_tokens (CLAUDE_SHOTS_MAX_TOKENS, 8,000 in every environment). The run budget
// is derived from that max_tokens, never the other way round (shot-timing.ts).
export const SHOTS_PER_CHUNK = 8

// Route maxDuration, the hand-off timeout and the derived run budget live in the leaf
// shot-timing.ts, which env.ts reads to refuse a shots model the chain cannot fit.
export { SHOTS_ROUTE_MAX_DURATION_S, SHOT_HANDOFF_TIMEOUT_MS, shotRunBudgetMs } from './shot-timing'

// There is no chain limit: a chain continues while each run saves shots and stops at the
// first run that saves none (the progress guard, worker.ts). Every run saves at least one
// shot and a project holds at most its shot ceiling, so a chain is bounded by construction.

// The Workbench's status poll while shots are being written: the next read starts this long
// after the previous one returned.
export const SHOT_STATUS_POLL_MS = 3_000

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

// The share of a scene's remaining seconds its word budget fills: each shot adds its padding
// and is rounded up to a length the video model renders, so a budget of the full seconds
// would overrun them. Code enforces the seconds whatever the model writes.
export const WORD_BUDGET_FILL = 0.9

// Added to a shot's spoken length before it is rounded up to a length the video model
// allows - at generation (from the word count) and at Fit to voiceover (from the measured
// span). Gaps between spoken spans measured p50 0.12s, max 0.21s.
export const SHOT_DURATION_PAD_SEC = 0.25

// Chunk shot positions before the run's final re-sequence: a chunk's shots take
// order_index = BASE + scene position x SCENE_STRIDE + chunk index x SHOTS_PER_CHUNK + i,
// unique across parallel chunks and above any contiguous index a project already holds.
export const SHOT_ORDER_BASE = 1_000_000
export const SHOT_ORDER_SCENE_STRIDE = 10_000
