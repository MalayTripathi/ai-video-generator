import type { Step, Operation } from './pipeline'

// Single source of truth for every credit value in the product - no credit number
// may appear anywhere else in the codebase. (durationConfig's estimatedCredits in
// duration.ts is a pre-existing, separate concern: a rough upfront UI estimate shown
// before generation, not the actual per-operation price charged - see CLAUDE.md's
// module map.)

export const USD_PER_CREDIT = 0.001

export const SIGNUP_GRANT_CREDITS = 5000

// Stamped onto every credit_ledger row so a past row's price stays reconstructable
// after this table changes later - same pattern as pricing.ts's RATE_VERSION.
export const CREDIT_PRICE_VERSION = '2026-09-13'

/**
 * Converts a measured USD cost into credits, rounding up. Used only for agent_turn,
 * where the number of Claude calls in a turn isn't knowable in advance - round once
 * per user action (the summed total), never once per provider call.
 */
export function usdToCredits(usd: number): number {
  if (usd === 0) return 0
  return Math.max(1, Math.ceil(usd / USD_PER_CREDIT))
}

export type CreditUnit = 'per_shot' | 'per_element' | 'per_project'

type PriceEntry = { credits: number; unit: CreditUnit }

// Keyed on (step, operation), not operation alone: generate_image (storyboard's Step 4
// frame render) and generate_element_reference (workbench's per-element reference
// image) are two different things that happen to both generate images, at different
// steps with different prices, and the two prompt-writing operations sit at different
// steps too. Operation alone can't express this.
//
// workbench/agent_turn has no entry - dynamically priced via usdToCredits.
// generation/generate_clip has no entry, deliberately - the most expensive action in
// the product; a placeholder price risks anchoring the real one badly. Its absence
// must cause a lookup failure, not a silent default of zero.
export const PRICE_TABLE: Partial<Record<Step, Partial<Record<Operation, PriceEntry>>>> = {
  workbench: {
    generate_shots: { credits: 2, unit: 'per_shot' }, // measured
    derive_camera: { credits: 3, unit: 'per_shot' }, // measured
    // 3 credits derives from gpt-image-1-mini at low quality, 1024x1024: 272 output
    // tokens at $8/1M tokens is roughly $0.0022, and usdToCredits rounds up to 3.
    // Placeholder because published per-image figures for this model don't all
    // reconcile with that arithmetic - see pricing.ts's OPENAI_RATES comment.
    generate_element_reference: { credits: 3, unit: 'per_element' }, // placeholder
  },
  image_prompts: {
    write_image_prompts: { credits: 2, unit: 'per_shot' }, // placeholder
  },
  storyboard: {
    generate_image: { credits: 15, unit: 'per_shot' }, // placeholder
    voiceover: { credits: 30, unit: 'per_project' }, // placeholder
    background_music: { credits: 40, unit: 'per_project' }, // placeholder
  },
  video_prompts: {
    write_video_prompts: { credits: 2, unit: 'per_shot' }, // placeholder
  },
  assembly: {
    merge: { credits: 20, unit: 'per_project' }, // placeholder
  },
}

export class MissingCreditPriceError extends Error {
  constructor(step: Step, operation: Operation) {
    super(`No fixed credit price for (${step}, ${operation}).`)
    this.name = 'MissingCreditPriceError'
  }
}

/**
 * Fixed-price lookup for a (step, operation) pair. Throws when no entry exists -
 * never falls back to zero. `quantity` must always be supplied by the caller and
 * always derived server-side (project's shot count, 1 for a single regeneration,
 * number of elements actually generated) - never from a client-supplied value.
 * Batch and single-regeneration share one price shape: quantity is just 8 vs 1.
 */
export function creditsFor({
  step,
  operation,
  quantity,
}: {
  step: Step
  operation: Operation
  quantity: number
}): number {
  const entry = PRICE_TABLE[step]?.[operation]
  if (!entry) {
    throw new MissingCreditPriceError(step, operation)
  }
  return entry.unit === 'per_project' ? entry.credits : entry.credits * quantity
}
