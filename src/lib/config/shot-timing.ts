// Shot generation's chain timing: how long one chunk can take on a given Claude model, and
// from that, how long one run of the chain may keep starting chunks. A leaf module (no
// imports) so env.ts can refuse to boot with a shots model whose budget does not fit.
//
// A run stops starting chunks at its budget, lets the in-flight ones drain, then finishes or
// hands off. The latest a chunk can start is the budget, so the budget is whatever is left of
// the route's 300s after the slowest possible chunk, the hand-off (or the finish, whichever
// is longer) and a margin. max_tokens is never lowered to make this fit.

// Vercel Hobby's ceiling, and the shots route's `maxDuration` literal.
export const SHOTS_ROUTE_MAX_DURATION_S = 300

// The hand-off request to the continuation run. Past this it counts as refused.
export const SHOT_HANDOFF_TIMEOUT_MS = 15_000

// The run's last writes after its chunks drain: one batched re-sequence, the run row, the
// claim and the ledger row. Estimate - each is one round trip.
export const SHOT_FINISH_S = 10

// Kept clear at the end of every run.
export const SHOT_BUDGET_MARGIN_S = 10

export type ShotChainTiming = {
  basis: 'measured' | 'estimate'
  source: string
  /** Output tokens per second over a whole chunk call, reserve to settle (includes time to first token). */
  chunkTokensPerSec: number
  /** Before the call: balance read, chunk row, usage reservation. */
  chunkSetupS: number
  /** After the call: payload, usage settle, shot/element/dialogue writes, chunk settle. */
  chunkWritesS: number
  outlineTokensPerSec: number
  /** After the outline call: replace the shot list, write the scenes, style, title, message. */
  outlineWritesS: number
}

// Keyed by the Claude model id CLAUDE_SHOTS_MODEL holds. A model without an entry cannot
// be the shots model: boot fails rather than guessing its speed.
export const SHOT_CHAIN_TIMING: Readonly<Record<string, ShotChainTiming>> = {
  'claude-haiku-5-5': {
    basis: 'measured',
    source:
      'Oct 10 2026 live run (shot_runs 64e2a451): the slowest of 6 chunks, 54 tok/s; setup ~3s and writes 15-22s on a loaded dev process; outline 52 tok/s, then 29s of writes.',
    chunkTokensPerSec: 54,
    chunkSetupS: 3,
    chunkWritesS: 22,
    outlineTokensPerSec: 52,
    outlineWritesS: 29,
  },
  'claude-sonnet-5': {
    basis: 'estimate',
    source: 'Conservative estimate, not measured: 40 tok/s, with the Haiku run\'s overheads. Replace with the Sonnet live measurement.',
    chunkTokensPerSec: 40,
    chunkSetupS: 3,
    chunkWritesS: 22,
    outlineTokensPerSec: 40,
    outlineWritesS: 29,
  },
}

/** The slowest a chunk can be on this model: setup, a full max_tokens answer, the writes. */
export function worstChunkS(timing: ShotChainTiming, chunkMaxTokens: number): number {
  return timing.chunkSetupS + chunkMaxTokens / timing.chunkTokensPerSec + timing.chunkWritesS
}

/** The slowest the outline (run 0) can be: a full max_tokens answer, then its writes. */
export function worstOutlineS(timing: ShotChainTiming, outlineMaxTokens: number): number {
  return outlineMaxTokens / timing.outlineTokensPerSec + timing.outlineWritesS
}

const runTailS = () => Math.max(SHOT_HANDOFF_TIMEOUT_MS / 1000, SHOT_FINISH_S) + SHOT_BUDGET_MARGIN_S

/**
 * How long one run may keep starting chunks, in ms, so that a chunk started at the budget
 * still drains, and the run hands off or finishes, inside the route's 300s.
 */
export function shotRunBudgetMs(model: string, chunkMaxTokens: number): number {
  const timing = SHOT_CHAIN_TIMING[model]
  if (!timing) throw new Error(`No shot chain timing for ${model}`)
  return Math.floor((SHOTS_ROUTE_MAX_DURATION_S - worstChunkS(timing, chunkMaxTokens) - runTailS()) * 1000)
}

/** Why this shots model and its max_tokens cannot run the chain inside 300s, or null. */
export function shotChainTimingProblem(model: string, chunkMaxTokens: number, outlineMaxTokens: number): string | null {
  const timing = SHOT_CHAIN_TIMING[model]
  if (!timing) return `"${model}" has no shot chain timing in shot-timing.ts`
  if (shotRunBudgetMs(model, chunkMaxTokens) <= 0) {
    return `a ${chunkMaxTokens}-token chunk on "${model}" (~${Math.round(worstChunkS(timing, chunkMaxTokens))}s) leaves no run budget inside ${SHOTS_ROUTE_MAX_DURATION_S}s`
  }
  if (worstOutlineS(timing, outlineMaxTokens) + runTailS() > SHOTS_ROUTE_MAX_DURATION_S) {
    return `a ${outlineMaxTokens}-token outline on "${model}" cannot finish and hand off inside ${SHOTS_ROUTE_MAX_DURATION_S}s`
  }
  return null
}
