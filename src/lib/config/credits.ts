import type { Step, Operation } from './pipeline'
import type { ImageQuality, VideoResolution } from './enums'
import { OPENAI_RATES, videoUsdPerSecond } from './pricing'

// Single source of truth for every credit value in the product - no credit number
// may appear anywhere else in the codebase. (durationConfig's estimatedCredits in
// duration.ts is a pre-existing, separate concern: a rough upfront UI estimate shown
// before generation, not the actual per-operation price charged - see CLAUDE.md's
// module map.)

export const USD_PER_CREDIT = 0.001

export const SIGNUP_GRANT_CREDITS = 5000

// Stamped onto every credit_ledger row so a past row's price stays reconstructable
// after this table changes later - same pattern as pricing.ts's RATE_VERSION.
export const CREDIT_PRICE_VERSION = '2026-10-08'

// Multiplier from provider cost to the credit price of a computed (image, video) price.
export const CREDIT_MARGIN = 1.0 // placeholder

/**
 * Converts a USD cost into credits, rounding up - once per user action (agent_turn's
 * summed total; one image; one clip), never once per provider call.
 */
export function usdToCredits(usd: number): number {
  if (usd === 0) return 0
  // Settle binary float noise before rounding up: $0.084 x 5 is 0.42000000000000004, which
  // would otherwise round up to an extra credit. Any real excess (a micro-credit or more)
  // still rounds up.
  const credits = Math.round((usd / USD_PER_CREDIT) * 1e6) / 1e6
  return Math.max(1, Math.ceil(credits))
}

// per_1k_chars: quantity is a character count; per_minute: quantity is seconds. Both
// round up once, on the whole quantity.
export type CreditUnit = 'per_shot' | 'per_element' | 'per_project' | 'per_1k_chars' | 'per_minute'

// A fixed entry carries its credit number; an image entry is computed per image from the
// provider's cost for that model/quality/size (imageCredits) and needs the price key.
type PriceEntry = { kind: 'fixed'; credits: number; unit: CreditUnit } | { kind: 'image'; unit: CreditUnit }

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
    generate_shots: { kind: 'fixed', credits: 2, unit: 'per_shot' }, // measured
    derive_camera: { kind: 'fixed', credits: 3, unit: 'per_shot' }, // measured
    generate_element_reference: { kind: 'image', unit: 'per_element' },
  },
  image_prompts: {
    write_image_prompts: { kind: 'fixed', credits: 2, unit: 'per_shot' }, // placeholder
  },
  storyboard: {
    generate_image: { kind: 'image', unit: 'per_shot' },
    // Generation is priced by the script's length; aligning an upload by the audio's.
    voiceover: { kind: 'fixed', credits: 8, unit: 'per_1k_chars' }, // placeholder
    align_voiceover: { kind: 'fixed', credits: 4, unit: 'per_minute' }, // placeholder
    // Music is priced by the seconds requested (the picture's length, clamped).
    background_music: { kind: 'fixed', credits: 3, unit: 'per_minute' }, // placeholder
  },
  video_prompts: {
    write_video_prompts: { kind: 'fixed', credits: 2, unit: 'per_shot' }, // placeholder
  },
  assembly: {
    merge: { kind: 'fixed', credits: 20, unit: 'per_project' }, // placeholder
  },
}

export class MissingCreditPriceError extends Error {
  constructor(step: Step, operation: Operation, detail = 'no price entry') {
    super(`No credit price for (${step}, ${operation}): ${detail}.`)
    this.name = 'MissingCreditPriceError'
  }
}

// Thrown by a runner's balance gate (e.g. runElementReferenceGeneration) after
// claim/recover but before reserving usage or calling the provider - mapped to 402
// (never 429) by the route, mirroring AllowanceExceededError's positioning
// (src/lib/usage/allowance.ts). Lives in this module rather than the ledger writer's
// own, so it can be value-imported by a route's logic.ts without pulling in the
// ledger writer's transitive service-role/'server-only' dependency (see
// runElementReferenceGeneration's own getBalance/recordFixedSpend type-only-import
// comment) - tests/ledger.spec.ts's module-hygiene check enforces that only a route
// and its logic.ts import the ledger writer directly, so this class deliberately
// avoids even naming that module's path in this comment.
export class InsufficientCreditsError extends Error {
  // Plain fields, not TS constructor-parameter properties: this file is transitively
  // imported by the ledger writer module, which several tests load in a plain-Node
  // child process under Node's default (strip-only) type stripping - that mode cannot
  // parse a constructor parameter property (see tests/wiring-identity.spec.ts's own
  // comment on this exact limitation). A parameter property here would break every
  // test that goes through that dispatcher, not just ones touching this class.
  readonly requiredCredits: number
  readonly balanceCredits: number

  constructor(requiredCredits: number, balanceCredits: number) {
    super(`Not enough credits: this action costs ${requiredCredits}, balance is ${balanceCredits}.`)
    this.name = 'InsufficientCreditsError'
    this.requiredCredits = requiredCredits
    this.balanceCredits = balanceCredits
  }
}

/** What an image's price depends on: the call actually made. */
export type ImagePriceKey = {
  model: string
  quality: ImageQuality
  size: string
  /** Reference images sent as input to the call (0 for a text-only generation). */
  referenceCount: number
}

export class UnpricedImageError extends Error {
  constructor(key: ImagePriceKey) {
    super(`No OpenAI image rate for ${key.model} at ${key.quality}, ${key.size}.`)
    this.name = 'UnpricedImageError'
  }
}

/**
 * Credits for ONE image: the provider's cost for that model/quality/size - output tokens at
 * the output rate, each reference image's input tokens at the image-input rate, and the
 * prompt allowance at the text-input rate - times CREDIT_MARGIN. Never hand-set.
 */
export function imageCredits(key: ImagePriceKey): number {
  const rates = OPENAI_RATES.images[key.model]
  const outputTokens = rates?.outputTokensBySize[key.size]?.[key.quality]
  if (!rates || outputTokens === undefined) throw new UnpricedImageError(key)
  const usd =
    (outputTokens * rates.outputPerMTok +
      key.referenceCount * rates.imageInputTokensPerReference * rates.imageInputPerMTok +
      rates.promptTokenAllowance * rates.textInputPerMTok) /
    1_000_000
  return usdToCredits(usd * CREDIT_MARGIN)
}

/**
 * Credits for one generated clip: fal's per-second price for the model/resolution/audio
 * choice x seconds x CREDIT_MARGIN, rounded up once per clip. Not charged anywhere yet -
 * clip generation is unbuilt.
 */
export function videoClipCredits(params: {
  model: string
  resolution: VideoResolution
  audio: boolean
  seconds: number
}): number {
  const { seconds, ...choice } = params
  return usdToCredits(videoUsdPerSecond(choice) * seconds * CREDIT_MARGIN)
}

/**
 * Price lookup for a (step, operation) pair. Throws when no entry exists -
 * never falls back to zero. `quantity` must always be supplied by the caller and
 * always derived server-side (project's shot count, 1 for a single regeneration,
 * number of elements actually generated, the script's character count, the audio's
 * seconds) - never from a client-supplied value.
 * Batch and single-regeneration share one price shape: quantity is just 8 vs 1.
 */
export function creditsFor({
  step,
  operation,
  quantity,
  image,
}: {
  step: Step
  operation: Operation
  quantity: number
  /** Required for an image entry - every image in `quantity` is priced on this key. */
  image?: ImagePriceKey
}): number {
  const entry = PRICE_TABLE[step]?.[operation]
  if (!entry) {
    throw new MissingCreditPriceError(step, operation)
  }
  if (entry.kind === 'image') {
    if (!image) throw new MissingCreditPriceError(step, operation, 'an image price needs its model, quality and size')
    return imageCredits(image) * quantity
  }
  switch (entry.unit) {
    case 'per_project':
      return entry.credits
    case 'per_1k_chars':
      return Math.ceil((entry.credits * quantity) / 1000)
    case 'per_minute':
      return Math.ceil((entry.credits * quantity) / 60)
    default:
      return entry.credits * quantity
  }
}
