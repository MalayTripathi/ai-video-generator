import type { Operation } from '@/lib/config/pipeline'

// Per-operation claim policy - replaces a single global STALE_AFTER_MS, which was
// correct for a long paid shot-generation job and would be catastrophic for a chat
// turn (a wedged agent_turn would lock the agent for 15 minutes). See
// docs/decisions.md for the 180s derivation and why this module exists at all.

export interface OperationPolicy {
  /** How old `started_at` must be before a 'generating' row is stale-reclaimable. */
  staleAfterMs: number
  claimableFrom: {
    /** 'never': blocked always. 'retry': blocked unless retry:true. 'always': reclaimed unconditionally. */
    succeeded: 'never' | 'retry' | 'always'
    /** 'retry': blocked unless retry:true. 'always': reclaimed unconditionally, no retry flag needed. */
    failed: 'retry' | 'always'
  }
}

// Baseline window, unchanged from the original single global constant.
export const STALE_AFTER_MS = 15 * 60 * 1000

const DEFAULT_POLICY: OperationPolicy = {
  staleAfterMs: STALE_AFTER_MS,
  claimableFrom: { succeeded: 'never', failed: 'retry' },
}

// Tied to worst-case turn duration (iteration cap x per-call ceiling + margin), not UI
// patience - see docs/decisions.md's "Agent-turn stale window" entry.
const AGENT_TURN_STALE_AFTER_MS = 180 * 1000

export const OPERATION_POLICY: Record<Operation, OperationPolicy> = {
  // Regenerate-all: claimable from 'succeeded' too, gated behind the same retry flag
  // 'failed' already requires.
  generate_shots: { ...DEFAULT_POLICY, claimableFrom: { succeeded: 'retry', failed: 'retry' } },
  // A reusable mutex row, overwritten indefinitely - not a job record. Reclaimable from
  // either terminal state with no retry flag, since there is no "job" to resume, only a
  // lock to release.
  agent_turn: {
    staleAfterMs: AGENT_TURN_STALE_AFTER_MS,
    claimableFrom: { succeeded: 'always', failed: 'always' },
  },
  voiceover: DEFAULT_POLICY,
  background_music: DEFAULT_POLICY,
  write_image_prompts: DEFAULT_POLICY,
  write_video_prompts: DEFAULT_POLICY,
  generate_image: DEFAULT_POLICY,
  generate_clip: DEFAULT_POLICY,
  merge: DEFAULT_POLICY,
  // derive_camera never actually claims a `generations` row (see pipeline.ts), but it
  // does write `usage` rows, and aggregate.ts's per-operation stale-pending lookup needs
  // an entry for every Operation.
  derive_camera: DEFAULT_POLICY,
}

/**
 * Looks up an operation's claim policy. Fails loudly on an unknown operation rather than
 * falling back to a default - a silent default is exactly how a new operation would get
 * an accidental 15-minute lock.
 */
export function getOperationPolicy(operation: Operation): OperationPolicy {
  const policy = OPERATION_POLICY[operation]
  if (!policy) {
    throw new Error(`No OPERATION_POLICY entry for operation "${operation}"`)
  }
  return policy
}
