import { creditsFor, PRICE_TABLE } from '../../src/lib/config/credits'
import type { AspectRatio, ImageModelId, ImageQuality } from '../../src/lib/config/enums'
import { DEFAULT_IMAGE_MODEL } from '../../src/lib/config/models'
import { elementReferencePriceKey, storyboardImagePriceKey } from '../../src/lib/images/price-key'
import type { Operation, Step } from '../../src/lib/config/pipeline'

/** A fixed PRICE_TABLE entry's credit number, read from the config - never restated. */
export function fixedCredits(step: Step, operation: Operation): number {
  const entry = PRICE_TABLE[step]?.[operation]
  if (entry?.kind !== 'fixed') throw new Error(`(${step}, ${operation}) has no fixed price`)
  return entry.credits
}

/** One Storyboard frame's credits, priced exactly as the app prices it (defaults: a new project). */
export function framePrice(
  opts: { aspectRatio?: AspectRatio; imageModel?: ImageModelId; imageQuality?: ImageQuality; referenceCount?: number } = {}
): number {
  return creditsFor({
    step: 'storyboard',
    operation: 'generate_image',
    quantity: 1,
    image: storyboardImagePriceKey({
      aspectRatio: opts.aspectRatio ?? '9:16',
      imageModel: opts.imageModel ?? DEFAULT_IMAGE_MODEL,
      imageQuality: opts.imageQuality ?? 'low',
      referenceCount: opts.referenceCount ?? 0,
    }),
  })
}

/** One element reference image's credits, priced exactly as the app prices it. */
export function elementReferencePrice(imageQuality: ImageQuality = 'low', imageModel: ImageModelId = DEFAULT_IMAGE_MODEL): number {
  return creditsFor({
    step: 'workbench',
    operation: 'generate_element_reference',
    quantity: 1,
    image: elementReferencePriceKey(imageModel, imageQuality),
  })
}
