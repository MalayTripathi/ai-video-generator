import type { Operation } from '@/lib/config/pipeline'
import {
  IMAGE_QUEUE_STALE_AFTER_MS,
  IMAGE_STALE_AFTER_MS,
  VOICEOVER_ALIGN_STALE_AFTER_MS,
  VOICEOVER_STALE_AFTER_MS,
} from '@/lib/config/storyboard'

// Per-operation claim policy - replaces a single global STALE_AFTER_MS, which was
// correct for a long paid shot-generation job and would be catastrophic for a chat
// turn (a wedged agent_turn would lock the agent for 15 minutes). See
// docs/decisions.md for the 180s derivation and why this module exists at all.

export interface OperationPolicy {
  /** How old `started_at` must be before a 'generating' row is stale-reclaimable. */
  staleAfterMs: number
  /** For an operation whose claims can wait queued behind a pool: how old `queued_at` must
   * be before a still-queued row is stale. Absent for operations that never queue. */
  queuedStaleAfterMs?: number
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
  // One claim per project. Regenerate is a new attempt, so both terminal states reclaim
  // unconditionally; the window covers every chunk of a long read.
  voiceover: {
    staleAfterMs: VOICEOVER_STALE_AFTER_MS,
    claimableFrom: { succeeded: 'always', failed: 'always' },
  },
  align_voiceover: {
    staleAfterMs: VOICEOVER_ALIGN_STALE_AFTER_MS,
    claimableFrom: { succeeded: 'always', failed: 'always' },
  },
  background_music: DEFAULT_POLICY,
  // Like generate_shots: Regenerate All/Stale/single-row are normal, repeatable
  // actions against an already-succeeded project, not exceptional retries - reclaim
  // from 'succeeded' is allowed behind the same retry flag 'failed' already requires.
  write_image_prompts: { ...DEFAULT_POLICY, claimableFrom: { succeeded: 'retry', failed: 'retry' } },
  write_video_prompts: DEFAULT_POLICY,
  // One claim per shot (storyboard's Step 4 image). Generate, Retry and Regenerate are all
  // ordinary repeatable actions on the same slot, so reclaim needs no retry flag from
  // either terminal state. Claims queue behind a concurrency pool, so a queued row ages
  // against its own, longer window; a started one against the per-call window - the same
  // threshold the status endpoint uses to show "failed".
  generate_image: {
    staleAfterMs: IMAGE_STALE_AFTER_MS,
    queuedStaleAfterMs: IMAGE_QUEUE_STALE_AFTER_MS,
    claimableFrom: { succeeded: 'always', failed: 'always' },
  },
  // A reusable per-element claim slot, not a one-shot job record: regenerating a
  // reference is a legitimate, repeatable user action (the Generate button), and must
  // never be blocked by a prior claim in either terminal state. No retry flag needed -
  // same reasoning as agent_turn's mutex, just element-scoped instead of project-scoped
  // (see the generations.element_id migration).
  generate_element_reference: { ...DEFAULT_POLICY, claimableFrom: { succeeded: 'always', failed: 'always' } },
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
