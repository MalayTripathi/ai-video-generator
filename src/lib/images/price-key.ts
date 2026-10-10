import { ASPECT_RATIOS, type AspectRatio } from '@/lib/config/enums'
import type { ImagePriceKey } from '@/lib/config/credits'
import { parseImageQuality, resolveImageModel } from '@/lib/config/models'
import { effectiveImageQuality, modelsConfig } from '@/lib/config/models.server'
import { STORYBOARD_IMAGE_SIZES } from '@/lib/config/storyboard'

// Server-side: effectiveImageQuality reads IMAGE_QUALITY_DEV_CAP, which the browser never
// sees - a client shows prices computed here, never its own.

// Every image price reads a shot's references through the embed
// `shot_elements(elements(reference_image_path, deleted_at))`, written out as a literal at
// each select so the typed client can infer the row.

type BoundElement = { reference_image_path: string | null; deleted_at: string | null }
type BoundElementRows = { elements: BoundElement | BoundElement[] | null }[] | null | undefined

/**
 * A shot's bound elements that can be sent as references: not deleted, with an image. Style
 * is never shot-bound, so it's never here. The worker sends exactly these (less any whose
 * object fails to download), and is charged on what it actually sent.
 */
export function usableReferencePaths(rows: BoundElementRows): string[] {
  return (rows ?? [])
    .flatMap((row) => (row.elements === null ? [] : Array.isArray(row.elements) ? row.elements : [row.elements]))
    .filter((el) => el.deleted_at === null && el.reference_image_path !== null)
    .map((el) => el.reference_image_path as string)
}

/**
 * The aspect ratio a frame is priced at: the project's own, or 9:16 for a row without a
 * valid one (the Image Prompts page's display rule). Pricing only - the worker refuses to
 * draw at a guessed size.
 */
export function pricedAspectRatio(value: string | null): AspectRatio {
  return value !== null && (ASPECT_RATIOS as readonly string[]).includes(value) ? (value as AspectRatio) : '9:16'
}

/**
 * A Storyboard frame's price key, for a project's stored aspect ratio, image model and image
 * quality. The key is also what the call sends: model (checked against the registry),
 * quality and size.
 */
export function storyboardImagePriceKey(params: {
  aspectRatio: AspectRatio
  imageModel: string
  imageQuality: string
  referenceCount: number
}): ImagePriceKey {
  const quality = effectiveImageQuality(parseImageQuality(params.imageQuality))
  return {
    model: resolveImageModel(params.imageModel, 'storyboard_frame', quality).id,
    quality,
    size: STORYBOARD_IMAGE_SIZES[params.aspectRatio],
    referenceCount: params.referenceCount,
  }
}

/** An element reference image's price key - a text-only generation, so no references. */
export function elementReferencePriceKey(imageModel: string, imageQuality: string): ImagePriceKey {
  const quality = effectiveImageQuality(parseImageQuality(imageQuality))
  return {
    model: resolveImageModel(imageModel, 'element_reference', quality).id,
    quality,
    size: modelsConfig.elements.size,
    referenceCount: 0,
  }
}
